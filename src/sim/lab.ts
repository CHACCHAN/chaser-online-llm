import { postMatchBusy } from "../evolution/post-match-queue";
import { measureGap } from "./oracle";
import { numSetting, boolSetting, getSetting } from "../settings";
import type { Params } from "../solver/evaluator";
import { PARAM_SPACE, type ParamSpec } from "../solver/evaluator";
import { getStyle, loadModelParams, loadModelParamsFile, loadStyles, playModelId, STANDARD_MODEL, type StyleDef } from "../solver/models";
import { loadModelProfiles, measureModels, traitTags, type ModelProfile } from "./model-traits";
import { logger } from "../tools";
import type { EpisodeResult } from "./episode";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { POLICY_TRAIN_LOG_PATH, SIM_MAPS_DIR, SIM_PROFILES_PATH } from "../paths";
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
 * - 空いている間の学習（TRAIN_IDLE）は毎回新しい地図で行う。試合中も続ける（TRAIN_DURING_MATCH。false なら試合が始まると止める）。
 *   試合後の振り返りが動いている間は、学習の LLM（評価関数を書き換える）だけ動かさない。
 */

export type LabTrigger = "manual" | "idle" | "post-match";

export interface LabJob {
  id: number;
  /** maps = 地図の組を今の方策で打たせる、train = 学習 */
  kind: "maps" | "train" | "measure";
  /** 打たせる・学習するモデル（knowledge/styles.json の id） */
  model: string;
  modelName: string;
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
  /** 打たせたモデル */
  model: string;
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
  /** 学習の LLM のモデル・思考の深さ（空なら試合の LLM と同じ。fallback はその値） */
  coach: { model: string; effort: string; fallbackModel: string; fallbackEffort: string };
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
  /** 空き時間の学習は、モデルを順番に育てる */
  private idleTurn = 0;

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
      coach: { model: getSetting("LAB_COACH_MODEL") ?? "", effort: getSetting("LAB_COACH_EFFORT") ?? "", fallbackModel: getSetting("LLM_MODEL_NAME") ?? "", fallbackEffort: getSetting("LLM_MODEL_EFFORT") ?? "" },
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
    if (this.matchActive && !boolSetting("TRAIN_DURING_MATCH")) return "試合中なので止めています（試合が終わるとまた始めます）";
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
    const style = getStyle(partial.model ?? playModelId());
    const job: LabJob = { id: this.nextId++, model: style.id, modelName: style.name, startedAt: new Date().toISOString(), finishedAt: null, minutes: null, generations: [], message: "", stopped: false, error: null, coach: null, ...partial };
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
  async makeMaps(opts: { n: number; room: number | null; model?: string }): Promise<boolean> {
    const c = this.claim();
    if (!(c === true || (c !== false && (await c)))) return false;
    const base = Math.floor(Math.random() * 1e8);
    this.evalSet = { seeds: Array.from({ length: opts.n }, (_, i) => base + i), rooms: Array.from({ length: opts.n }, () => opts.room), maxTurns: maxTurns() };
    const maps = this.evalSet.seeds.map((seed) => {
      const scn = makeScenario(makeRng(seed), { room: opts.room });
      return { seed, room: opts.room, name: scn.name, width: scn.grid[0]?.length ?? 0, height: scn.grid.length, webMap: scn.webMap, turns: Math.min(scn.totalTurns, maxTurns()) };
    });
    const model = getStyle(opts.model ?? playModelId());
    this.set = { id: this.nextId, room: opts.room, createdAt: new Date().toISOString(), maps, model: model.id, before: null, after: null, validation: null, accepted: null };
    this.runsBefore = null;
    this.runsAfter = null;
    const job = this.begin({ kind: "maps", trigger: "manual", room: opts.room, model: model.id, message: `${opts.n} 枚の地図を${model.name}で打たせています` });
    const work = this.playSet(loadModelParams(model.id));
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
  async train(opts: { room: number | null; minutes: number; dryRun?: boolean; trigger: LabTrigger; onSet?: boolean; model?: string }): Promise<TrainResult | null> {
    if (opts.trigger === "idle") {
      if (this.job) return null;
    } else {
      const c = this.claim();
      if (!(c === true || (c !== false && (await c)))) return null;
    }
    const useSet = opts.onSet === true && this.evalSet !== null;
    const room = useSet ? this.set!.room : opts.room;
    const model = getStyle(opts.model ?? (useSet ? this.set!.model : playModelId()));
    // 並べた地図を別のモデルで打たせていたら、学習するモデルで打たせ直す（学習前の記録）
    const job = this.begin({ kind: "train", trigger: opts.trigger, room, minutes: opts.minutes, model: model.id, message: useSet ? `${model.name}を、並べた ${this.evalSet!.seeds.length} 枚の地図で学習します` : `${model.name}の学習を始めます` });
    const work = (async () => {
      const r = await trainPolicy({
        pool: this.pool!,
        room,
        budgetMs: opts.minutes * 60_000,
        maxTurns: maxTurns(),
        dryRun: opts.dryRun,
        trigger: opts.trigger,
        model: model.id,
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
        this.set!.model = model.id;
      }
      // 採用したら、全部のモデルの特性を同じ地図・同じ相手で測り直す（特性の札はモデルどうしの比べ合い）
      if (r.accepted && !opts.dryRun && !this.stopFlag) {
        job.message = "モデルの特性を測っています（全部のモデルを同じ地図・同じ相手で）";
        this.emit(true);
        await measureModels(this.pool!).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "特性を測れなかった"));
      }
      // 学習の LLM: 結果を読んで学習環境（評価関数・地図の作り方・学習のやり方）を直す。
      // 試合中は動かさない（試合後の学習は、次の試合の前なので動かす）。試すだけ・止めた時も動かさない
      // 試合中も学習を続ける時（TRAIN_DURING_MATCH）は学習の LLM も動かす。ただし試合後の振り返りが動いている間は、
      // 評価関数を同時に書き換えないように動かさない（試合後の学習は、振り返りの後に同じ列の中で動くので動かす）
      const inMatch = () =>
        opts.trigger !== "post-match" && ((this.matchActive && !boolSetting("TRAIN_DURING_MATCH")) || postMatchBusy());
      if (boolSetting("LAB_COACH") && r.generations > 0 && !opts.dryRun && !this.stopFlag && !inMatch()) {
        job.message = "学習の LLM が結果を読んで、学習環境を直しています";
        job.coach = { state: "running", startedAt: new Date().toISOString(), result: null };
        this.emit(true);
        // 地図ごとの成績: 並べた地図があればそれ、無ければ今の方策でこのルームの地図を打たせる
        const params = loadModelParams(model.id);
        const base = 6_000_000 + Math.floor(Math.random() * 1e6);
        const jobs = useSet
          ? this.evalSet!.seeds.map((seed, i) => ({ seed, room: this.evalSet!.rooms[i] ?? null, maxTurns: this.evalSet!.maxTurns, trace: true, policy: { kind: "planner" as const, params: r.after } }))
          : Array.from({ length: 12 }, (_, i) => ({ seed: base + i, room, maxTurns: maxTurns(), trace: true, policy: { kind: "planner" as const, params } }));
        const runs = useSet ? this.runsAfter! : await this.pool!.runAll(jobs);
        // 理論値の目安との差（同じ地図・同じ相手で、全部を知っている・深く考える方策と比べる）
        job.message = "理論値の目安との差を測っています";
        this.emit(true);
        const gap = await measureGap(this.pool!, jobs, runs).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "理論値の目安との差を測れなかった");
          return null;
        });
        job.message = "学習の LLM が結果を読んで、学習環境を直しています";
        this.emit(true);
        const result = await runLabCoach(
          { trigger: opts.trigger, room, train: r, runs, runsBefore: useSet ? this.runsBefore : null, gap, model: model.id },
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
          : `${model.name}: ${r.generations} 世代・${r.episodes} 試合。学習に使っていない地図で ${r.comparison.a} → ${r.comparison.b}${model.id === STANDARD_MODEL ? " 点/ターン" : "（目的の値）/ターン"} → ${r.accepted ? (opts.dryRun ? "良くなった（試すだけなので保存しない）" : "保存した（次の試合から使う）") : "見送り（はっきり良くなっていない）"}`;
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
    if (active && this.job?.trigger === "idle" && !boolSetting("TRAIN_DURING_MATCH")) this.stop();
    this.emit(true);
  }

  /** 試合をしていない間の学習を見張る（数秒ごと） */
  startIdleLoop(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.tickIdle(), 5000);
  }

  private tickIdle(): void {
    if (!this.idleOn() || (this.matchActive && !boolSetting("TRAIN_DURING_MATCH")) || this.job) return;
    // モデルを順番に育てる（試合で使うモデルは2回に1回、残りはほかのモデルを順に）
    // 相手が出ないルーム（人数が自分だけ）では、相手に向けたモデル（目的に当てた・当てられた得点があるもの）は育てない
    // （学習の LLM の要望 2026-11-23: 1人のルームでハンターを 25 世代育てて、罠が増えただけだった）
    // 目安に届ききっていて弱点も無いルーム（直近 3 回とも 98% 以上）は、いろいろな地図で学習する
    // （学習の LLM の要望 2026-11-23: ルーム 3 は 100% で直すものが無いのに、空き時間の学習が何度も回っていた）
    const wanted = this.roomForIdle();
    const room = wanted !== null && roomSaturated(wanted) ? null : wanted;
    const styles = idleStyles(loadStyles(), room);
    const play = styles.some((s) => s.id === playModelId()) ? playModelId() : STANDARD_MODEL;
    const others = styles.filter((s) => s.id !== play);
    const turn = this.idleTurn++;
    const model = turn % 2 === 0 || others.length === 0 ? play : others[Math.floor(turn / 2) % others.length]!.id;
    void this.train({ room, minutes: numSetting("TRAIN_IDLE_CHUNK_MIN", { min: 1 }), trigger: "idle", model });
  }

  /** 全部のモデルの特性を測る（同じ地図・同じ相手） */
  async measure(): Promise<boolean> {
    const c = this.claim();
    if (!(c === true || (c !== false && (await c)))) return false;
    const job = this.begin({ kind: "measure", trigger: "manual", room: null, model: STANDARD_MODEL, message: "全部のモデルを同じ地図・同じ相手で打たせて、特性を測っています" });
    const work = measureModels(this.pool!);
    this.running = work;
    try {
      await work;
      job.message = "特性を測りました";
    } catch (err) {
      job.error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      job.message = this.stopFlag ? "止めました" : `失敗: ${job.error}`;
    } finally {
      this.finish(job);
    }
    return true;
  }

  /** モデル（特性ごと）とパラメータの一覧（「学習」画面の「モデル」） */
  models(): ModelsInfo {
    const styles = loadStyles();
    const profiles = loadModelProfiles();
    const lastTrain = lastTrainByModel();
    return {
      play: playModelId(),
      params: (Object.entries(PARAM_SPACE) as [string, ParamSpec][]).map(([name, s]) => ({ name, doc: s.doc, min: s.min, max: s.max, init: s.init, integer: !!s.integer })),
      models: styles.map((s) => {
        const file = loadModelParamsFile(s.id);
        return {
          ...s,
          params: loadModelParams(s.id),
          trained: !!file && (s.id === STANDARD_MODEL || file.source === "train"),
          updatedAt: file?.updatedAt ?? null,
          profile: profiles[s.id] ?? null,
          tags: traitTags(s.id, profiles),
          lastTrain: lastTrain[s.id] ?? null,
        };
      }),
    };
  }
}

export interface ModelsInfo {
  /** 試合で使うモデル */
  play: string;
  /** 学習するパラメータ（名前・説明・範囲・初めの値） */
  params: { name: string; doc: string; min: number; max: number; init: number; integer: boolean }[];
  models: (StyleDef & {
    params: Record<string, number>;
    trained: boolean;
    updatedAt: string | null;
    profile: ModelProfile | null;
    tags: string[];
    /** 最後の学習（学習前→後のパラメータ、採用したか） */
    lastTrain: { at: string; accepted: boolean; trigger: string | null; before: Record<string, number> | null; after: Record<string, number>; a: number; b: number } | null;
  })[];
}

/** train-log.jsonl から、モデルごとの最後の学習（model の無い古い記録は標準のモデル） */
function lastTrainByModel(): Record<string, ModelsInfo["models"][number]["lastTrain"]> {
  const out: Record<string, ModelsInfo["models"][number]["lastTrain"]> = {};
  try {
    if (!existsSync(POLICY_TRAIN_LOG_PATH)) return out;
    for (const line of readFileSync(POLICY_TRAIN_LOG_PATH, "utf-8").trim().split("\n")) {
      try {
        const o = JSON.parse(line) as { at: string; accepted: boolean; dryRun?: boolean; trigger: string | null; model?: string; generations: number; before?: Record<string, number>; after: Record<string, number>; comparison: { a: number; b: number } };
        if (!o.generations || o.dryRun) continue;
        out[o.model ?? STANDARD_MODEL] = { at: o.at, accepted: o.accepted, trigger: o.trigger, before: o.before ?? null, after: o.after, a: o.comparison.a, b: o.comparison.b };
      } catch {
        // 壊れた行は飛ばす
      }
    }
  } catch {
    // 読めなければ空
  }
  return out;
}

export const lab = new LearningLab();

/** 空き時間に育てるモデル。相手が出ないルームでは、相手に向けたモデルを外す（標準はいつも残す） */
export function idleStyles(styles: StyleDef[], room: number | null, players?: [number, number]): StyleDef[] {
  try {
    players ??= loadProfile(room).players;
  } catch {
    return styles;
  }
  if (players[1] > 1) return styles;
  return styles.filter((s) => s.id === STANDARD_MODEL || !((s.objective.put ?? 0) !== 0 || (s.objective.putDamage ?? 0) !== 0));
}

/** 直近 3 回の学習の LLM の記録で、そのルームが理論値の目安に 98% 以上届いていたか */
export function roomSaturated(room: number, log = readCoachLog(30)): boolean {
  const recent = log.filter((c) => c.room === room && c.gap).slice(-3);
  return recent.length >= 3 && recent.every((c) => c.gap!.ratio >= 0.98);
}
