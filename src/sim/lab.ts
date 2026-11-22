import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { POLICY_TRAIN_LOG_PATH, SIM_MAPS_DIR } from "../paths";
import { boolSetting, getSetting, numSetting } from "../settings";
import { defaultParams } from "../solver/evaluator";
import { loadPolicyParams } from "../solver/policy";
import { logger } from "../tools";
import type { EpisodeResult } from "./episode";
import { SimPool } from "./pool";
import { comparePolicies, makeEvalSet, trainPolicy, type Comparison, type GenerationStat, type PolicySpec, type TrainResult } from "./train";

/**
 * 学習の仕事をまとめて受け持つ（WebUI の「学習」画面・試合後の学習・試合をしていない間の学習）。
 * - 同時に動かす仕事は1つ（CPU を取り合わないため）。
 * - 試合をしていない間の学習（TRAIN_IDLE）は、試合が始まると止め、終わったらまた始める。
 * - 状態は onChange で知らせる（ui/server が SSE の "lab" で配る）。
 */

export type LabTrigger = "manual" | "idle" | "post-match";
/** current = 今のパラメータの方策、default = 初期値の方策、solver = active-solver.ts */
export type LabPolicy = "current" | "default" | "solver";
export const LAB_POLICIES: readonly LabPolicy[] = ["current", "default", "solver"];

export interface LabJob {
  id: number;
  kind: "train" | "bench";
  trigger: LabTrigger;
  room: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** 学習の予定時間（分） */
  minutes: number | null;
  dryRun: boolean;
  /** bench の比べる2つ */
  a: LabPolicy | null;
  b: LabPolicy | null;
  n: number | null;
  generations: GenerationStat[];
  message: string;
  comparison: Comparison | null;
  accepted: boolean | null;
  stopped: boolean;
  error: string | null;
}

export interface LabState {
  job: LabJob | null;
  last: LabJob | null;
  idle: { enabled: boolean; chunkMin: number; reason: string | null };
  matchActive: boolean;
  workers: number;
}

const workerCount = () => {
  const n = Number(getSetting("SIM_WORKERS") || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};
const maxTurns = () => numSetting("SIM_MAX_TURNS", { min: 10, integer: true });

export function policySpec(p: LabPolicy): PolicySpec {
  if (p === "solver") return { kind: "solver" };
  return { kind: "planner", params: p === "default" ? defaultParams() : loadPolicyParams() };
}

export class LearningLab {
  private job: LabJob | null = null;
  private last: LabJob | null = null;
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
      idle: { enabled: this.idleOn(), chunkMin: numSetting("TRAIN_IDLE_CHUNK_MIN", { min: 1 }), reason: this.idleReason() },
      matchActive: this.matchActive,
      workers: this.pool?.size ?? workerCount() ?? 0,
    };
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
    if (this.job && this.job.trigger !== "idle") return "ほかの仕事が終わったら始めます";
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
    const job: LabJob = {
      id: this.nextId++,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      minutes: null,
      dryRun: false,
      a: null,
      b: null,
      n: null,
      generations: [],
      message: "",
      comparison: null,
      accepted: null,
      stopped: false,
      error: null,
      ...partial,
    };
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

  /** 方策のパラメータを学習する。ほかの仕事が動いていれば、試合をしていない間の学習なら止めて代わり、それ以外は null */
  async train(opts: { room: number | null; minutes: number; dryRun?: boolean; trigger: LabTrigger }): Promise<TrainResult | null> {
    if (this.job) {
      if (this.job.trigger !== "idle" || opts.trigger === "idle") return null;
      await this.stopAndWait();
    }
    const job = this.begin({ kind: "train", trigger: opts.trigger, room: opts.room, minutes: opts.minutes, dryRun: !!opts.dryRun, message: "学習を始めます" });
    const work = trainPolicy({
      pool: this.pool!,
      room: opts.room,
      budgetMs: opts.minutes * 60_000,
      maxTurns: maxTurns(),
      dryRun: opts.dryRun,
      trigger: opts.trigger,
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
    this.running = work;
    try {
      const r = await work;
      job.comparison = r.comparison;
      job.accepted = r.accepted;
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

  /** 2つの方策を同じ地図で比べる */
  async bench(opts: { room: number | null; n: number; a: LabPolicy; b: LabPolicy }): Promise<Comparison | null> {
    if (this.job) {
      if (this.job.trigger !== "idle") return null;
      await this.stopAndWait();
    }
    const job = this.begin({ kind: "bench", trigger: "manual", room: opts.room, a: opts.a, b: opts.b, n: opts.n, message: `${opts.n} 地図で比べています` });
    const work = comparePolicies(this.pool!, policySpec(opts.a), policySpec(opts.b), makeEvalSet(Math.floor(Math.random() * 1e8), opts.n, opts.room, maxTurns()));
    this.running = work;
    try {
      const c = await work;
      job.comparison = c;
      job.message = `${c.n} 地図: ${c.a} → ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}）`;
      return c;
    } catch (err) {
      job.error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      job.message = this.stopFlag ? "止めました" : `失敗: ${job.error}`;
      return null;
    } finally {
      this.finish(job);
    }
  }

  /** 1試合をシミュレータで打たせ、再生用の記録を返す（別の worker で動かすので画面を止めない） */
  async episode(opts: { seed: number; room: number | null; maxTurns: number | null; policy: LabPolicy }): Promise<EpisodeResult> {
    const pool = new SimPool(1);
    try {
      return await pool.run({ seed: opts.seed, room: opts.room, maxTurns: opts.maxTurns, policy: policySpec(opts.policy), trace: true });
    } finally {
      pool.close();
    }
  }

  /** 動いている仕事を止める。学習はそこまでの結果を確かめてから終わる */
  stop(): void {
    if (!this.job) return;
    this.stopFlag = true;
    this.job.message = this.job.kind === "train" ? "止めています（そこまでの結果を確かめています）" : "止めています";
    // 比べている途中は待たずに打ち切る
    if (this.job.kind === "bench") this.pool?.close();
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

  stopIdleLoop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private tickIdle(): void {
    if (!this.idleOn() || this.matchActive || this.job) return;
    void this.train({ room: this.roomForIdle(), minutes: numSetting("TRAIN_IDLE_CHUNK_MIN", { min: 1 }), trigger: "idle" });
  }
}

export const lab = new LearningLab();

/** 学習の記録（var/policy/train-log.jsonl）の新しい方から */
export function readTrainLog(limit = 100): Record<string, unknown>[] {
  if (!existsSync(POLICY_TRAIN_LOG_PATH)) return [];
  const lines = readFileSync(POLICY_TRAIN_LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (const l of lines.slice(-limit).reverse()) {
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}

/** 保存してある本物の地図の数（ルームごと） */
export function realMapCounts(): { room: number; count: number; latest: string | null }[] {
  if (!existsSync(SIM_MAPS_DIR)) return [];
  return readdirSync(SIM_MAPS_DIR)
    .filter((d) => /^room\d+$/.test(d))
    .map((d) => {
      const files = readdirSync(path.join(SIM_MAPS_DIR, d)).filter((f) => f.endsWith(".json")).sort();
      return { room: Number(d.slice(4)), count: files.length, latest: files.length ? files[files.length - 1]!.replace(/\.json$/, "") : null };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => a.room - b.room);
}
