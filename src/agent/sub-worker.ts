import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR, CURRENT_ASK_SUB_PATH, CURRENT_SUB_SNAPSHOT_DIR } from "../paths";
import { numSetting } from "../settings";
import { uiBus } from "../ui/event-bus";
import type { ClaudeModelSettings } from "./claude-env";
import { AGENT_WORK_TOOLS, ClaudeSession } from "./claude-session";
import { type ProtectedSnapshot, restoreProtectedFiles, snapshotProtectedFiles } from "../evolution/edit-guard";
import { addUsage, emptyUsage, type UsageTotals } from "./usage";

export interface SubTask {
  id: number;
  request: string;
  status: "queued" | "running" | "done" | "failed";
  result: string | null;
  durationMs: number | null;
  /** 依頼したフェーズ（メインへの TODO 表示用） */
  requestedAt?: string;
  startedAt?: number;
  /** 依頼した時の盤面（区画・座標世代・盤面のファイル）。結果が今の座標で使えるかをメインが判断するため */
  context?: SubTaskContext;
}

export interface SubTaskContext {
  turn: number;
  phase: string;
  segment: number;
  frameVersion: number;
  /** 依頼時の盤面（var/current/sub-snapshots/task-N.json） */
  snapshotPath?: string;
}

const STATUS_LABEL = { queued: "待機", running: "作業中", done: "完了", failed: "失敗" } as const;

/** TODO の1行（メインへのメッセージと ASK_SUB.md で共通） */
export function formatSubTodoLine(t: SubTask, now = Date.now()): string {
  const elapsed = t.status === "running" && t.startedAt ? ` ${Math.round((now - t.startedAt) / 1000)}s経過` : "";
  return `- #${t.id} [${STATUS_LABEL[t.status]}${elapsed}] ${t.requestedAt ? `${t.requestedAt}に依頼: ` : ""}${t.request.slice(0, 120)}`;
}

/** var/current/ASK_SUB.md の中身（依頼全文と結果つき） */
export function renderAskSubFile(tasks: SubTask[]): string {
  const lines = ["# サブへの依頼（この試合）", "", "ハーネスが自動で書き出す。編集しても試合には反映されない。", ""];
  if (tasks.length === 0) lines.push("(まだない)");
  for (const t of tasks) {
    lines.push(`## #${t.id} [${STATUS_LABEL[t.status]}] ${t.requestedAt ?? ""}`.trimEnd(), "", "依頼:", t.request, "");
    if (t.result !== null) lines.push(`結果${t.durationMs ? `（${Math.round(t.durationMs / 1000)}s）` : ""}:`, t.result, "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * メインエージェントから仕事（調査・ツール作成・ログ分析）を受け取り、裏で処理するサブエージェント（AGENT_SUB_CONCURRENCY 件まで同時）。
 * 仕事ごとに新しい Claude Code セッション（ツールあり・保存なし）を起動し、返答したら閉じる。
 * 前の仕事の会話は持ち越さない（必要な情報は依頼文・ファイル・ツールの出力で渡す）。
 * メインは待たずに毎フェーズ返答でき、結果は後のフェーズのメッセージで受け取る。
 */
export class SubWorker {
  private readonly tasks: SubTask[] = [];
  private nextId = 1;
  /** 今動いている仕事の数 */
  private active = 0;
  private stopped = false;
  private reported = new Set<number>();
  private sessions = new Set<ClaudeSession>();
  private usageTotals: UsageTotals = emptyUsage();
  private guard: ProtectedSnapshot | null = null;

  constructor(private readonly settings: ClaudeModelSettings) {}

  /** サブの累計使用量（終わった仕事の分。実行中の仕事は終わった時点で加算） */
  get usage(): UsageTotals {
    return { ...this.usageTotals };
  }

  start(): void {
    this.stopped = false;
    this.tasks.length = 0;
    this.reported.clear();
    rmSync(CURRENT_SUB_SNAPSHOT_DIR, { recursive: true, force: true });
    // 試合中のサブはツールを使えるが、ハーネス・ソルバー・プロンプト・方針・設定は変えさせない（試合終了時に元に戻す）
    this.guard = snapshotProtectedFiles({ includeSolver: true });
    this.publish();
  }

  private publish(): void {
    uiBus.patchState({ subTasks: this.tasks.map((t) => ({ ...t })) });
    try {
      mkdirSync(path.dirname(CURRENT_ASK_SUB_PATH), { recursive: true });
      writeFileSync(CURRENT_ASK_SUB_PATH, renderAskSubFile(this.tasks));
    } catch {
      // 書き出しに失敗しても試合は続ける
    }
  }

  /** 仕事を足す。snapshot（依頼時の盤面の JSON）があれば var/current/sub-snapshots/task-N.json に残し、サブにはそれを読ませる */
  enqueue(request: string, requestedAt?: string, context?: Omit<SubTaskContext, "snapshotPath"> & { snapshot?: string }): SubTask {
    const id = this.nextId++;
    let ctx: SubTaskContext | undefined;
    if (context) {
      const { snapshot, ...rest } = context;
      ctx = { ...rest };
      if (snapshot) {
        try {
          mkdirSync(CURRENT_SUB_SNAPSHOT_DIR, { recursive: true });
          const p = path.join(CURRENT_SUB_SNAPSHOT_DIR, `task-${id}.json`);
          writeFileSync(p, snapshot);
          ctx.snapshotPath = path.relative(path.dirname(AGENT_DIR), p);
        } catch {
          // 書けなくても依頼は出す
        }
      }
    }
    const task: SubTask = { id, request, status: "queued", result: null, durationMs: null, requestedAt, ...(ctx ? { context: ctx } : {}) };
    this.tasks.push(task);
    this.publish();
    this.pump();
    return task;
  }

  /** メインに見せるサブの様子（作業中・待機・1件あたりの時間）。メインは前の会話を持たないので、サブが動いていることを毎回伝える */
  summary(now = Date.now()): string {
    const running = this.tasks.filter((t) => t.status === "running");
    const queued = this.tasks.filter((t) => t.status === "queued").length;
    const durations = this.tasks.filter((t) => t.status === "done" && t.durationMs).map((t) => t.durationMs!);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null;
    const max = numSetting("AGENT_SUB_CONCURRENCY", { min: 1, integer: true });
    return [
      running.length > 0
        ? `作業中 ${running.length}件（${running.map((t) => `#${t.id} ${t.startedAt ? Math.round((now - t.startedAt) / 1000) : 0}s`).join(", ")}）`
        : "作業中なし",
      `待機 ${queued}件`,
      avg !== null ? `1件あたり平均${avg}s` : "",
      `同時に${max}件まで`,
    ]
      .filter(Boolean)
      .join("・");
  }

  /** 実行中・待機中の仕事 */
  pending(): SubTask[] {
    return this.tasks.filter((t) => t.status === "queued" || t.status === "running");
  }

  /** 終わったがメインにまだ届けていない仕事 */
  peekFinished(): SubTask[] {
    return this.tasks.filter((t) => (t.status === "done" || t.status === "failed") && !this.reported.has(t.id)).map((t) => ({ ...t }));
  }

  /** メインが正常に返答したフェーズで見せた結果を、届けたことにする（時間切れのフェーズに載った結果は次のフェーズにもう一度出す） */
  markReported(ids: number[]): void {
    for (const id of ids) this.reported.add(id);
  }

  /** 終わった仕事を取り出し、届けたことにする */
  takeFinished(): SubTask[] {
    const done = this.peekFinished();
    this.markReported(done.map((t) => t.id));
    return done;
  }

  /** 全ての仕事（TODO 表示用） */
  all(): SubTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /** 試合終了: 実行中の仕事は止め、待機中の仕事は流さない */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of this.sessions) s.kill();
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === "queued") {
        t.status = "failed";
        t.result = "試合終了のため未着手で中止";
        changed = true;
      }
    }
    if (changed) this.publish();
    if (this.guard) {
      const reverted = restoreProtectedFiles(this.guard);
      this.guard = null;
      if (reverted.length > 0) {
        uiBus.pushClaudeEvent({
          context: "in_game",
          kind: "error",
          title: "[sub] 編集範囲外の変更を元に戻した",
          content: `試合中のサブが変更できるのは knowledge/・agent/tools/・assets/ 等のみ:\n${reverted.join("\n")}`,
        });
      }
    }
  }

  private newSession(): ClaudeSession {
    const s = new ClaudeSession({
      model: this.settings.subModel || this.settings.model,
      subModel: this.settings.subModel,
      effort: this.settings.subEffort || this.settings.effort,
      context: "in_game",
      label: "sub",
      tools: AGENT_WORK_TOOLS,
      appendSystemPrompt: readFileSync(path.join(AGENT_DIR, "prompts/sub.md"), "utf-8"),
      noSessionPersistence: true,
      quietLifecycle: true,
    });
    s.start();
    return s;
  }

  /** 空きがある限り、待機中の仕事を始める */
  private pump(): void {
    const max = numSetting("AGENT_SUB_CONCURRENCY", { min: 1, integer: true });
    while (!this.stopped && this.active < max) {
      const task = this.tasks.find((t) => t.status === "queued");
      if (!task) return;
      this.active += 1;
      void this.run(task).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(task: SubTask): Promise<void> {
    task.status = "running";
    task.startedAt = Date.now();
    this.publish();
    const session = this.newSession();
    this.sessions.add(session);
    try {
      const res = await session.ask(`[TASK #${task.id}] ${task.request}${task.context ? `\n\n依頼時の盤面: ${task.context.snapshotPath ?? "(なし)"}（T${task.context.turn} ${task.context.phase}・区画${task.context.segment}・座標世代${task.context.frameVersion}）。座標はこの盤面の pos と同じ座標。var/current/snapshot.json は今の盤面で、ワープの後は座標系が違う（frameVersion で分かる）` : ""}`, numSetting("AGENT_SUB_TASK_TIMEOUT_MIN", { min: 1 }) * 60_000);
      if (res.status === "ok") {
        task.status = "done";
        task.result = res.text.slice(0, 1500);
        task.durationMs = res.durationMs;
        await session.stop();
      } else {
        task.status = "failed";
        task.result = this.stopped ? "試合終了のため作業中に中止" : res.status === "dead" ? res.error : res.status;
        session.kill(); // 上限超過: 止めて以降の消費を断つ
      }
    } catch (err) {
      task.status = "failed";
      task.result = err instanceof Error ? err.message : String(err);
      session.kill();
    } finally {
      this.usageTotals = addUsage(this.usageTotals, session.usage);
      this.sessions.delete(session);
      this.publish();
    }
  }
}
