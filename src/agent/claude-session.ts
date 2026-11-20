import type { Subprocess } from "bun";
import { PROJECT_ROOT } from "../paths";
import { logger } from "../tools/logger";
import { uiBus } from "../ui/event-bus";
import { baseClaudeArgs, buildClaudeEnv, type ClaudeModelSettings } from "./claude-env";
import { addUsage, contextSizeFromRaw, emptyUsage, type UsageTotals, usageFromRaw } from "./usage";

export type ClaudeContext = "in_game" | "evolution" | "system";

export type AskResult =
  | { status: "ok"; text: string; durationMs: number }
  | { status: "timeout"; durationMs: number }
  | { status: "busy" }
  | { status: "dead"; error: string };

interface StreamEvent {
  type?: string;
  subtype?: string;
  result?: string;
  usage?: Parameters<typeof usageFromRaw>[0];
  total_cost_usd?: number;
  message?: {
    usage?: Parameters<typeof usageFromRaw>[0];
    content?: Array<{ type?: string; thinking?: string; text?: string; name?: string; input?: unknown; content?: unknown }>;
  };
}

export interface ClaudeSessionOptions extends ClaudeModelSettings {
  /** 既定システムプロンプトの末尾に追加するテキスト */
  appendSystemPrompt?: string;
  /** Claude Code 既定のシステムプロンプトを丸ごと置き換える（指定時は appendSystemPrompt より優先） */
  systemPrompt?: string;
  /** 組み込みツール。"" で全て無効（ツール定義を送らないので1回あたりのトークンが大きく減る） */
  tools?: string;
  /** 会話をディスクに保存しない（使い捨ての問い合わせ用） */
  noSessionPersistence?: boolean;
  /** --agents に渡すサブエージェント定義 */
  agents?: Record<string, { description: string; prompt: string; model?: string }>;
  context?: ClaudeContext;
  /** UI の思考ログに付ける名前 (main / sub) */
  label?: string;
}

/**
 * Claude Code を `--input-format stream-json` で常駐させるセッション。
 * 1プロセスで文脈を保ったまま、ターンごとにメッセージを流し込んで結果を受け取る。
 *
 * - ask() は同時に1つだけ。前の問い合わせが終わっていなければ "busy" を返す。
 * - タイムアウトしても Claude 側の処理は止めない（調査・ツール作成を続けさせる）。
 *   遅れて届いた結果は破棄し、セッションは次の ask() から再び使える。
 */
export class ClaudeSession {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private pending: { resolve: (r: AskResult) => void; startedAt: number; timedOut: boolean } | null = null;
  private busyFlag = false;
  private deadReason: string | null = null;
  private readonly context: ClaudeContext;
  private usageTotals: UsageTotals = emptyUsage();
  private contextTokens: number | null = null;
  /** この問い合わせ中に assistant イベントから会話の大きさが取れたか */
  private contextFromAssistant = false;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.context = options.context ?? "in_game";
  }

  get busy(): boolean {
    return this.busyFlag;
  }

  /** このセッションの累計使用量（タイムアウト後に遅れて届いた分も含む） */
  get usage(): UsageTotals {
    return { ...this.usageTotals };
  }

  /** 直近の API 呼び出しで送った会話の大きさ（トークン）。不明なら null */
  get contextSize(): number | null {
    return this.contextTokens;
  }

  get alive(): boolean {
    return this.proc !== null && this.deadReason === null;
  }

  start(): void {
    if (this.proc) return;
    const args = [...baseClaudeArgs(this.options), "--input-format", "stream-json"];
    if (this.options.systemPrompt !== undefined) args.push("--system-prompt", this.options.systemPrompt);
    else if (this.options.appendSystemPrompt) args.push("--append-system-prompt", this.options.appendSystemPrompt);
    if (this.options.tools !== undefined) args.push("--tools", this.options.tools);
    if (this.options.noSessionPersistence) args.push("--no-session-persistence");
    if (this.options.agents) args.push("--agents", JSON.stringify(this.options.agents));

    logger.info({ model: this.options.model ?? null, effort: this.options.effort ?? null }, "Starting persistent Claude session");
    this.proc = Bun.spawn(args, {
      cwd: PROJECT_ROOT,
      env: buildClaudeEnv(this.options),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.deadReason = null;
    void this.pump(this.proc.stdout, (line) => this.onStdout(line));
    void this.pump(this.proc.stderr, (line) => {
      if (line.trim()) this.emit("error", "stderr", line.slice(0, 800));
    });
    void this.proc.exited.then((code) => {
      this.deadReason = `Claude process exited (code ${code})`;
      this.proc = null;
      this.busyFlag = false;
      this.emit("error", "Session Ended", this.deadReason);
      if (this.pending && !this.pending.timedOut) this.pending.resolve({ status: "dead", error: this.deadReason });
      this.pending = null;
    });
    this.emit("system", "Session Started", `model=${this.options.model ?? "default"} effort=${this.options.effort ?? "default"}`);
  }

  ask(text: string, timeoutMs: number): Promise<AskResult> {
    if (!this.proc || this.deadReason) return Promise.resolve({ status: "dead", error: this.deadReason ?? "not started" });
    if (this.busyFlag) return Promise.resolve({ status: "busy" });

    this.busyFlag = true;
    const startedAt = Date.now();
    return new Promise<AskResult>((resolve) => {
      const entry = { resolve, startedAt, timedOut: false };
      this.pending = entry;
      setTimeout(() => {
        if (this.pending === entry && !entry.timedOut) {
          entry.timedOut = true;
          resolve({ status: "timeout", durationMs: Date.now() - startedAt });
        }
      }, timeoutMs);
      this.proc!.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
      this.proc!.stdin.flush();
    });
  }

  /** 処理中でもすぐ止める（使い捨ての問い合わせが予算切れになった時など。以降のトークン消費を止める） */
  kill(): void {
    this.proc?.kill();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    const p = this.proc;
    const killer = setTimeout(() => p.kill(), 5000);
    await p.exited;
    clearTimeout(killer);
  }

  private onStdout(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(trimmed) as StreamEvent;
    } catch {
      this.emit("text", "Output", trimmed.slice(0, 1500));
      return;
    }

    if (ev.type === "assistant") {
      const size = contextSizeFromRaw(ev.message?.usage);
      if (size !== null) {
        this.contextTokens = size;
        this.contextFromAssistant = true;
      }
    }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === "thinking" && b.thinking) this.emit("thinking", "Reasoning", b.thinking.slice(0, 2000));
        else if (b.type === "text" && b.text) this.emit("text", "Claude", b.text.slice(0, 2000));
        else if (b.type === "tool_use")
          this.emit("tool_use", b.name ?? "Tool", JSON.stringify(b.input ?? {}, null, 2).slice(0, 1200));
      }
      return;
    }
    if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type !== "tool_result") continue;
        const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        this.emit("tool_result", "Tool Output", t.slice(0, 900));
      }
      return;
    }
    if (ev.type === "result") {
      if (ev.usage) this.usageTotals = addUsage(this.usageTotals, usageFromRaw(ev.usage, ev.total_cost_usd));
      else this.usageTotals = addUsage(this.usageTotals, { ...emptyUsage(), calls: 1 });
      // ゲートウェイによっては assistant イベントに usage が無い。その場合は result の入力量（キャッシュ込み）を会話の大きさとみなす
      // （ツールを使った問い合わせでは複数回分の合計になり大きめに出るが、要約を早めに始めるだけなので安全側）
      if (!this.contextFromAssistant) {
        const size = contextSizeFromRaw(ev.usage);
        if (size !== null) this.contextTokens = size;
      }
      this.contextFromAssistant = false;
      const entry = this.pending;
      this.pending = null;
      this.busyFlag = false;
      const text = typeof ev.result === "string" ? ev.result : "";
      if (entry && !entry.timedOut) {
        entry.resolve({ status: "ok", text, durationMs: Date.now() - entry.startedAt });
      } else if (entry) {
        this.emit("system", "Late Result (discarded)", text.slice(0, 600));
      }
    }
  }

  private emit(kind: "thinking" | "text" | "tool_use" | "tool_result" | "system" | "error", title: string, content: string): void {
    uiBus.pushClaudeEvent({ context: this.context, kind, title: this.options.label ? `[${this.options.label}] ${title}` : title, content });
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    }
    if (buf.trim()) onLine(buf);
  }
}
