import { numSetting, boolSetting, getSetting } from "../settings";
import type { Params } from "../solver/evaluator";
import { loadPolicyParams } from "../solver/policy";
import { logger } from "../tools";
import type { EpisodeResult } from "./episode";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { SIM_MAPS_DIR, SIM_PROFILES_PATH } from "../paths";
import { loadRoomProfiles } from "../memory/knowledge-store";
import { loadProfile, loadRealMaps, makeScenario } from "./mapgen";
import { SimPool } from "./pool";
import { makeRng } from "./rng";
import { type CoachDeps, type CoachResult, readCoachLog, runLabCoach } from "./lab-coach";
import { trainPolicy, type Comparison, type EvalSet, type GenerationStat, type TrainResult } from "./train";

import { loadLeague } from "./opponents";
import { loadTrainConfig } from "./train-config";
/**
 * 学習の仕事をまとめて受け持つ（WebUI の「学習」画面・試合後の学習・試合をしていない間の学習）。
 *
 * 「学習」画面の流れ: 地図を作る（地図の組）→ 今の方策で全部の地図を打たせて記録（学習前）→ その組で学習 →
 * 学習後の方策で同じ地図を打たせて記録（学習後）。記録は再生用（各ターンの位置・得点・変わったマス）。
 * 保存するかは、学習に使っていない地図で確かめて決める（train.ts）。
 *
 * - 同時に動かす仕事は1つ（CPU を取り合わないため）。
 * - 試合をしていない間の学習（TRAIN_IDLE）は毎回新しい地図で行い、試合が始まると止める。
 */

export type LabTrigger = "manual" | "idle" | "post-match";

export interface LabJob {
  id: number;
  /** maps = 地図の組を今の方策で打たせる、train = 学習 */
  kind: "maps" | "train";
  trigger: LabTrigger;
  room: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** 学習の予定時間（分） */
  minutes: number | null;
  generations: GenerationStat[];
  message: string;
  stopped: boolean;
  error: string | null;
  /** 学習の後の、学習の LLM（学習環境を直す） */
  coach: { state: "running" | "done"; startedAt: string; result: CoachResult | null } | null;
}

/** 地図の組（画面に並べる地図） */
export interface MapSetInfo {
  id: number;
  room: number | null;
  createdAt: string;
  maps: { seed: number; room: number | null; name: string; width: number; height: number; webMap: boolean; turns: number }[];
  /** 学習前・学習後の 1ターンあたりの得点の平均（打たせ終わったら） */
  before: number | null;
  after: number | null;
  /** 学習に使っていない地図での確かめ（学習前→後） */
  validation: Comparison | null;
  /** 学習の結果を保存したか（学習していなければ null） */
  accepted: boolean | null;
}

/** 「ルーム」で選べるルーム（遊んだルーム・地図の作り方を書いたルーム・本物の地図があるルーム） */
export interface RoomChoice {
  room: number;
  /** 似せる時の地図の大きさ（最小〜最大）とターン数 */
  size: [number, number];
  turns: [number, number];
  /** 保存した本物の地図の枚数（Webマップから。試合で全体マップが取れた時に保存される） */
  realMaps: number;
  matchesPlayed: number;
}

export function roomChoices(): RoomChoice[] {
  const rooms = new Set<number>();
  for (const k of Object.keys(loadRoomProfiles().rooms)) rooms.add(Number(k));
  try {
    const sp = JSON.parse(readFileSync(SIM_PROFILES_PATH, "utf-8")) as { rooms?: Record<string, unknown> };
    for (const k of Object.keys(sp.rooms ?? {})) rooms.add(Number(k));
  } catch {
    // 読めなければ足さない
  }
  if (existsSync(SIM_MAPS_DIR)) for (const d of readdirSync(SIM_MAPS_DIR)) if (/^room\d+$/.test(d)) rooms.add(Number(d.slice(4)));
  const profiles = loadRoomProfiles().rooms;
  return [...rooms]
    .filter((r) => Number.isInteger(r) && r > 0)
    .sort((a, b) => a - b)
    .map((room) => {
      const p = loadProfile(room);
      return { room, size: p.size, turns: p.turns, realMaps: loadRealMaps(room).length, matchesPlayed: profiles[String(room)]?.matchesPlayed ?? 0 };
    });
}

export interface LabState {
  job: LabJob | null;
  last: LabJob | null;
  set: MapSetInfo | null;
  idle: { enabled: boolean; chunkMin: number; reason: string | null };
  matchActive: boolean;
  /** 学習のたびに学習の LLM が学習環境を直すか（LAB_COACH） */
  coachEnabled: boolean;
  /** 最後の学習の LLM の結果 */
  lastCoach: CoachResult | null;
  /** シミュレータの相手: 種類の重み（拾う・狙う・自分）と、自己対戦の相手に残っている前の自分の数 */
  opponents: { greedy: number; hunter: number; self: number; league: number };
}

const workerCount = () => {
  const n = Number(getSetting("SIM_WORKERS") || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};
const maxTurns = () => numSetting("SIM_MAX_TURNS", { min: 10, integer: true });
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const perTurnOf = (r: EpisodeResult) => r.score / Math.max(1, r.totalTurns);

export class LearningLab {
  private job: LabJob | null = null;
  private last: LabJob | null = null;
  private set: MapSetInfo | null = null;
  private evalSet: EvalSet | null = null;
  private runsBefore: EpisodeResult[] | null = null;
  private runsAfter: EpisodeResult[] | null = null;
  private nextId = 1;
  private stopFlag = false;
  private pool: SimPool | null = null;
  private running: Promise<unknown> | null = null;
  private idleEnabled: boolean | null = null;
  private matchActive = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: LabState) => void>();
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCoach: CoachResult | null = readCoachLog(1)[0] ?? null;
  /** 学習の LLM の差し替え（テスト用） */
  coachDeps: CoachDeps | null = null;
  /** 試合をしていない間の学習で使うルーム（今の設定のルーム） */
  roomForIdle: () => number | null = () => null;

  onChange(fn: (s: LabState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(): LabState {
    return {
      job: this.job,
      last: this.last,
      set: this.set,
      idle: { enabled: this.idleOn(), chunkMin: numSetting("TRAIN_IDLE_CHUNK_MIN", { min: 1 }), reason: this.idleReason() },
      matchActive: this.matchActive,
      coachEnabled: boolSetting("LAB_COACH"),
      opponents: (() => {
        const c = loadTrainConfig().config;
        return { greedy: c.oppGreedy, hunter: c.oppHunter, self: c.oppSelf, league: loadLeague().members.length };
      })(),
      lastCoach: this.lastCoach,
    };
  }

  /** 画面に並べる地図の組と、学習前・学習後の再生用の記録 */
  mapSet(): { set: MapSetInfo | null; grids: number[][][]; before: EpisodeResult[] | null; after: EpisodeResult[] | null } {
    const grids = this.evalSet ? this.evalSet.seeds.map((seed, i) => makeScenario(makeRng(seed), { room: this.evalSet!.rooms[i] ?? null }).grid) : [];
    return { set: this.set, grids, before: this.runsBefore, after: this.runsAfter };
  }

  get busy(): boolean {
    return this.job !== null;
  }

  private idleOn(): boolean {
    return this.idleEnabled ?? boolSetting("TRAIN_IDLE");
  }

  private idleReason(): string | null {
    if (!this.idleOn()) return null;
    if (this.matchActive) return "試合中なので止めています（試合が終わるとまた始めます）";
    if (this.job && this.job.trigger !== "idle") return "空き時間の学習は、いまの仕事が終わったら始めます";
    return null;
  }

  /** 変化を知らせる（世代ごとなど頻繁なので、0.3 秒に1回まで） */
  private emit(force = false): void {
    const send = () => {
      this.emitTimer = null;
      this.lastEmit = Date.now();
      const s = this.state();
      for (const fn of this.listeners) {
        try {
          fn(s);
        } catch {
          // 配信先の失敗は無視
        }
      }
    };
    if (force || Date.now() - this.lastEmit > 300) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      send();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(send, 300);
    }
  }

  private begin(partial: Pick<LabJob, "kind" | "trigger" | "room"> & Partial<LabJob>): LabJob {
    const job: LabJob = { id: this.nextId++, startedAt: new Date().toISOString(), finishedAt: null, minutes: null, generations: [], message: "", stopped: false, error: null, coach: null, ...partial };
    this.job = job;
    this.stopFlag = false;
    this.pool = new SimPool(workerCount());
    this.emit(true);
    return job;
  }

  private finish(job: LabJob): void {
    job.finishedAt = new Date().toISOString();
    this.pool?.close();
    this.pool = null;
    this.last = job;
    this.job = null;
    this.running = null;
    this.emit(true);
  }

  /** 空き時間の学習が動いていれば止めて譲る。ほかの仕事なら false（何も動いていなければ待たずに true。すぐ begin できる） */
  private claim(): boolean | Promise<boolean> {
    if (!this.job) return true;
    if (this.job.trigger !== "idle") return false;
    return this.stopAndWait().then(() => this.job === null);
  }

  /** 全部の地図を、このパラメータの方策で打たせる（再生用の記録つき） */
  private playSet(params: Params): Promise<EpisodeResult[]> {
    const set = this.evalSet!;
    return this.pool!.runAll(set.seeds.map((seed, i) => ({ seed, room: set.rooms[i] ?? null, maxTurns: set.maxTurns, trace: true, policy: { kind: "planner" as const, params } })));
  }

  /** 地図の組を作り、今の方策で全部打たせる（学習前の記録）。ほかの仕事が動いていれば false */
  async makeMaps(opts: { n: number; room: number | null }): Promise<boolean> {
    const c = this.claim();
    if (!(c === true || (c !== false && (await c)))) return false;
    const base = Math.floor(Math.random() * 1e8);
    this.evalSet = { seeds: Array.from({ length: opts.n }, (_, i) => base + i), rooms: Array.from({ length: opts.n }, () => opts.room), maxTurns: maxTurns() };
    const maps = this.evalSet.seeds.map((seed) => {
      const scn = makeScenario(makeRng(seed), { room: opts.room });
      return { seed, room: opts.room, name: scn.name, width: scn.grid[0]?.length ?? 0, height: scn.grid.length, webMap: scn.webMap, turns: Math.min(scn.totalTurns, maxTurns()) };
    });
    this.set = { id: this.nextId, room: opts.room, createdAt: new Date().toISOString(), maps, before: null, after: null, validation: null, accepted: null };
    this.runsBefore = null;
    this.runsAfter = null;
    const job = this.begin({ kind: "maps", trigger: "manual", room: opts.room, message: `${opts.n} 枚の地図を今の方策で打たせています` });
    const work = this.playSet(loadPolicyParams());
    this.running = work;
    try {
      this.runsBefore = await work;
      this.set.before = mean(this.runsBefore.map(perTurnOf));
      job.message = `${opts.n} 枚を打たせました（平均 ${this.set.before} 点/ターン）`;
    } catch (err) {
      job.error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      job.message = this.stopFlag ? "止めました" : `失敗: ${job.error}`;
    } finally {
      this.finish(job);
    }
    return true;
  }

  /** 方策のパラメータを学習する。onSet なら画面の地図の組で学習し、学習後も同じ地図を打たせる */
  async train(opts: { room: number | null; minutes: number; dryRun?: boolean; trigger: LabTrigger; onSet?: boolean }): Promise<TrainResult | null> {
    if (opts.trigger === "idle") {
      if (this.job) return null;
    } else {
      const c = this.claim();
      if (!(c === true || (c !== false && (await c)))) return null;
    }
    const useSet = opts.onSet === true && this.evalSet !== null;
    const room = useSet ? this.set!.room : opts.room;
    const job = this.begin({ kind: "train", trigger: opts.trigger, room, minutes: opts.minutes, message: useSet ? `並べた ${this.evalSet!.seeds.length} 枚の地図で学習を始めます` : "学習を始めます" });
    const work = (async () => {
      const r = await trainPolicy({
        pool: this.pool!,
        room,
        budgetMs: opts.minutes * 60_000,
        maxTurns: maxTurns(),
        dryRun: opts.dryRun,
        trigger: opts.trigger,
        ...(useSet ? { trainSet: this.evalSet! } : {}),
        shouldStop: () => this.stopFlag,
        onGeneration: (g) => {
          job.generations.push(g);
          this.emit();
        },
        log: (m) => {
          job.message = m;
          this.emit();
        },
      });
      // 並べた地図を学習前・学習後の方策で打たせ直す（同じ地図で見比べる）
      if (useSet && r.generations > 0) {
        job.message = "学習前と学習後の方策で、並べた地図を打たせています";
        this.emit(true);
        const [before, after] = await Promise.all([this.playSet(r.before), this.playSet(r.after)]);
        this.runsBefore = before;
        this.runsAfter = after;
        this.set!.before = mean(before.map(perTurnOf));
        this.set!.after = mean(after.map(perTurnOf));
        this.set!.validation = r.comparison;
        this.set!.accepted = r.accepted && !opts.dryRun;
      }
      // 学習の LLM: 結果を読んで学習環境（評価関数・地図の作り方・学習のやり方）を直す。
      // 試合中は動かさない（試合後の学習は、次の試合の前なので動かす）。試すだけ・止めた時も動かさない
      const inMatch = () => this.matchActive && opts.trigger !== "post-match";
      if (boolSetting("LAB_COACH") && r.generations > 0 && !opts.dryRun && !this.stopFlag && !inMatch()) {
        job.message = "学習の LLM が結果を読んで、学習環境を直しています";
        job.coach = { state: "running", startedAt: new Date().toISOString(), result: null };
        this.emit(true);
        // 地図ごとの成績: 並べた地図があればそれ、無ければ今の方策でこのルームの地図を打たせる
        const runs = useSet ? this.runsAfter! : await this.pool!.runAll(Array.from({ length: 12 }, (_, i) => ({ seed: 6_000_000 + Math.floor(Math.random() * 1e6) + i, room, maxTurns: maxTurns(), trace: true, policy: { kind: "planner" as const, params: loadPolicyParams() } })));
        const result = await runLabCoach(
          { trigger: opts.trigger, room, train: r, runs, runsBefore: useSet ? this.runsBefore : null },
          { ...(this.coachDeps ?? {}), shouldStop: () => this.stopFlag || inMatch() },
        );
        job.coach = { ...job.coach, state: "done", result };
        this.lastCoach = result;
      }
      return r;
    })();
    this.running = work;
    try {
      const r = await work;
      job.stopped = this.stopFlag;
      job.message =
        r.generations === 0
          ? "1世代も回る前に止めました"
          : `${r.generations} 世代・${r.episodes} 試合。学習に使っていない地図で ${r.comparison.a} → ${r.comparison.b} 点/ターン → ${r.accepted ? (opts.dryRun ? "良くなった（試すだけなので保存しない）" : "保存した（次の試合から使う）") : "見送り（はっきり良くなっていない）"}`;
      return r;
    } catch (err) {
      job.error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      job.message = this.stopFlag ? "止めました" : `失敗: ${job.error}`;
      if (!this.stopFlag) logger.warn({ err: job.error }, "学習に失敗");
      return null;
    } finally {
      this.finish(job);
    }
  }

  /** 動いている仕事を止める。学習はそこまでの結果を確かめてから終わる */
  stop(): void {
    if (!this.job) return;
    this.stopFlag = true;
    this.job.message = this.job.coach?.state === "running" ? "学習の LLM を止めています（確かめていない改修は戻します）" : this.job.kind === "train" ? "止めています（そこまでの結果を確かめています）" : "止めています";
    if (this.job.kind === "maps") this.pool?.close();
    this.emit(true);
  }

  async stopAndWait(): Promise<void> {
    const r = this.running;
    this.stop();
    if (r) await r.catch(() => {});
  }

  /** 試合をしていない間の学習を切り替える（.env への保存は呼ぶ側） */
  setIdle(enabled: boolean): void {
    this.idleEnabled = enabled;
    if (!enabled && this.job?.trigger === "idle") this.stop();
    this.emit(true);
    this.tickIdle();
  }

  /** 試合の始まり・終わり（index.ts から）。試合中は、試合をしていない間の学習を止める */
  setMatchActive(active: boolean): void {
    this.matchActive = active;
    if (active && this.job?.trigger === "idle") this.stop();
    this.emit(true);
  }

  /** 試合をしていない間の学習を見張る（数秒ごと） */
  startIdleLoop(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.tickIdle(), 5000);
  }

  private tickIdle(): void {
    if (!this.idleOn() || this.matchActive || this.job) return;
    void this.train({ room: this.roomForIdle(), minutes: numSetting("TRAIN_IDLE_CHUNK_MIN", { min: 1 }), trigger: "idle" });
  }
}

export const lab = new LearningLab();
