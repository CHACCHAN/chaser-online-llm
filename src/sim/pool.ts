import { cpus } from "node:os";
import type { Params } from "../solver/evaluator";
import type { EpisodeResult } from "./episode";
import type { OpponentPlan } from "./opponents";

/** シミュレータの1試合分の仕事（地図は seed から worker が作る） */
export interface EpisodeJob {
  seed: number;
  room: number | null;
  /** 試合のターン数の上限（学習を速くするため。null なら地図の設定どおり） */
  maxTurns: number | null;
  /** 再生用の記録を返す */
  trace?: boolean;
  policy: {
    kind: "planner";
    params: Params;
    /** 別の評価関数のファイル（エージェントの改修前後を比べる時） */
    evaluatorPath?: string;
    /**
     * 作戦スクリプトでモデルを切り替えながら打つ（試合と同じ。src/solver/tactics-runtime.ts の makeTacticalPolicy）。
     * models = 特性ごとのモデルのパラメータ、start = 最初のモデル、path = 別の作戦スクリプトのファイル（無ければ今の tactics.ts）。
     * params は使わない
     */
    tactics?: { models: Record<string, Params>; start: string; path?: string };
  };
  /**
   * 理論値の目安（同じ地図・同じ相手）: know = 全体マップを毎ターン見て、全部のワープの行き先を知っている。
   * deep = それに加えて、目標の数・先読み・ビーム幅を一番大きくする
   */
  oracle?: "know" | "deep";
  /** 相手の決め方（無ければ worker が今の設定から作る。学習は始めに1回作って、比べる両方に同じものを渡す） */
  opponents?: OpponentPlan;
}

type Pending = { resolve: (r: EpisodeResult) => void; reject: (e: Error) => void };

/** 複数の worker でシミュレータを並列に回す */
export class SimPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: EpisodeJob; p: Pending }[] = [];
  private busy = new Map<Worker, Pending>();

  constructor(size = Math.max(1, Math.min(16, cpus().length - 2))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url).href);
      w.onmessage = (ev: MessageEvent<{ ok: true; result: EpisodeResult } | { ok: false; error: string }>) => {
        const p = this.busy.get(w);
        this.busy.delete(w);
        if (p) {
          if (ev.data.ok) p.resolve(ev.data.result);
          else p.reject(new Error(ev.data.error));
        }
        this.idle.push(w);
        this.pump();
      };
      w.onerror = (ev) => {
        const p = this.busy.get(w);
        this.busy.delete(w);
        p?.reject(new Error(ev.message));
        this.idle.push(w);
        this.pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run(job: EpisodeJob): Promise<EpisodeResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, p: { resolve, reject } });
      this.pump();
    });
  }

  runAll(jobs: EpisodeJob[]): Promise<EpisodeResult[]> {
    return Promise.all(jobs.map((j) => this.run(j)));
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const { job, p } = this.queue.shift()!;
      this.busy.set(w, p);
      w.postMessage(job);
    }
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    for (const { p } of this.queue) p.reject(new Error("pool closed"));
    for (const p of this.busy.values()) p.reject(new Error("pool closed"));
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.busy.clear();
  }
}
