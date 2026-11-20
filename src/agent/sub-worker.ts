import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR, CURRENT_ASK_SUB_PATH } from "../paths";
import { numSetting } from "../settings";
import { uiBus } from "../ui/event-bus";
import type { ClaudeModelSettings } from "./claude-env";
import { ClaudeSession } from "./claude-session";
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
 * メインエージェントから仕事（調査・ツール作成・ログ分析）を受け取り、裏で順番に処理するサブエージェント。
 * 仕事ごとに新しい Claude Code セッション（ツールあり・保存なし）を起動し、返答したら閉じる。
 * 前の仕事の会話は持ち越さない（必要な情報は依頼文・ファイル・ツールの出力で渡す）。
 * メインは待たずに毎フェーズ返答でき、結果は後のフェーズのメッセージで受け取る。
 */
export class SubWorker {
  private readonly tasks: SubTask[] = [];
  private nextId = 1;
  private running = false;
  private stopped = false;
  private reported = new Set<number>();
  private current: ClaudeSession | null = null;
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

  enqueue(request: string, requestedAt?: string): SubTask {
    const task: SubTask = { id: this.nextId++, request, status: "queued", result: null, durationMs: null, requestedAt };
    this.tasks.push(task);
    this.publish();
    void this.pump();
    return task;
  }

  /** 実行中・待機中の仕事 */
  pending(): SubTask[] {
    return this.tasks.filter((t) => t.status === "queued" || t.status === "running");
  }

  /** 前回呼び出し以降に終わった仕事（メインへの報告用） */
  takeFinished(): SubTask[] {
    const done = this.tasks.filter((t) => (t.status === "done" || t.status === "failed") && !this.reported.has(t.id));
    for (const t of done) this.reported.add(t.id);
    return done;
  }

  /** 全ての仕事（TODO 表示用） */
  all(): SubTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /** 試合終了: 実行中の仕事は止め、待機中の仕事は流さない */
  async stop(): Promise<void> {
    this.stopped = true;
    this.current?.kill();
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
      appendSystemPrompt: readFileSync(path.join(AGENT_DIR, "prompts/sub.md"), "utf-8"),
      noSessionPersistence: true,
      quietLifecycle: true,
    });
    s.start();
    return s;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.tasks.find((t) => t.status === "queued"); task && !this.stopped; task = this.tasks.find((t) => t.status === "queued")) {
        task.status = "running";
        task.startedAt = Date.now();
        this.publish();
        const session = this.newSession();
        this.current = session;
        const res = await session.ask(`[TASK #${task.id}] ${task.request}`, numSetting("AGENT_SUB_TASK_TIMEOUT_MIN", { min: 1 }) * 60_000);
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
        this.usageTotals = addUsage(this.usageTotals, session.usage);
        this.current = null;
        this.publish();
      }
    } finally {
      this.running = false;
    }
  }
}
