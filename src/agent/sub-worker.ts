import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "../paths";
import type { ClaudeModelSettings } from "./claude-env";
import { uiBus } from "../ui/event-bus";
import { ClaudeSession } from "./claude-session";

export interface SubTask {
  id: number;
  request: string;
  status: "queued" | "running" | "done" | "failed";
  result: string | null;
  durationMs: number | null;
}

const TASK_TIMEOUT_MS = 10 * 60_000;

/**
 * メインエージェントから仕事（調査・ツール作成・ログ分析）を受け取り、裏で順番に処理する常駐サブエージェント。
 * メインは待たずに毎ターン返答でき、結果は次のターンのメッセージで受け取る。
 */
export class SubWorker {
  private readonly session: ClaudeSession;
  private readonly tasks: SubTask[] = [];
  private nextId = 1;
  private running = false;
  private reported = new Set<number>();

  constructor(settings: ClaudeModelSettings) {
    this.session = new ClaudeSession({
      model: settings.subModel || settings.model,
      subModel: settings.subModel,
      effort: settings.subEffort || settings.effort,
      context: "in_game",
      label: "sub",
      appendSystemPrompt: readFileSync(path.join(AGENT_DIR, "prompts/sub.md"), "utf-8"),
    });
  }

  start(): void {
    this.session.start();
    this.publish();
  }

  private publish(): void {
    uiBus.patchState({ subTasks: this.tasks.map((t) => ({ ...t })) });
  }

  enqueue(request: string): SubTask {
    const task: SubTask = { id: this.nextId++, request, status: "queued", result: null, durationMs: null };
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

  async stop(): Promise<void> {
    await this.session.stop();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.tasks.find((t) => t.status === "queued"); task; task = this.tasks.find((t) => t.status === "queued")) {
        task.status = "running";
        this.publish();
        const res = await this.session.ask(`[TASK #${task.id}] ${task.request}`, TASK_TIMEOUT_MS);
        if (res.status === "ok") {
          task.status = "done";
          task.result = res.text.slice(0, 1500);
          task.durationMs = res.durationMs;
        } else {
          task.status = "failed";
          task.result = res.status === "dead" ? res.error : res.status;
          // タイムアウト時はセッションが処理を続けている可能性があるので、終わるまで次を流さない
          while (this.session.busy) await Bun.sleep(1000);
        }
        this.publish();
      }
    } finally {
      this.running = false;
    }
  }
}
