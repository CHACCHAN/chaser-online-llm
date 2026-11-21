import type { Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { AGENTS_GUIDE_PATH, PROJECT_ROOT } from "../paths";
import { logger } from "../tools/logger";
import { uiBus } from "../ui/event-bus";
import { baseClaudeArgs, buildClaudeEnv, type ClaudeModelSettings } from "./claude-env";
import { addUsage, contextSizeFromRaw, emptyUsage, type UsageTotals, usageFromRaw } from "./usage";

/** agent/AGENTS.md（エージェント向けの説明書）。無ければ空 */
export function agentsGuide(): string {
  return existsSync(AGENTS_GUIDE_PATH) ? readFileSync(AGENTS_GUIDE_PATH, "utf-8").trim() : "";
}

/** AGENTS.md の1節（見出し行から、同じか上の階層の次の見出しの前まで）。無ければ空 */
export function agentsGuideSection(heading: string): string {
  const lines = agentsGuide().split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return "";
  const level = (lines[start]!.match(/^#+/)?.[0] ?? "#").length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#+) /);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

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
  is_error?: boolean;
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
  /** agent/AGENTS.md を自動で付けない（試合中のメインは必要な節だけを systemPrompt に入れる） */
  agentsGuide?: false;
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
  /** 起動・正常終了を思考ログに出さない（毎フェーズ使い捨ての問い合わせ用） */
  quietLifecycle?: boolean;
}

/**
 * Claude Code を `--input-format stream-json` で起動するセッション（常駐にも、1回きりの使い捨てにも使う）。
 * 1プロセスで文脈を保ったまま、ターンごとにメッセージを流し込んで結果を受け取る。
 *
 * - ask() は同時に1つだけ。前の問い合わせが終わっていなければ "busy" を返す。
 * - タイムアウトしても Claude 側の処理は止めない（調査・ツール作成を続けさせる）。
 *   遅れて届いた結果は破棄し、セッションは次の ask() から再び使える。
 */
/** unrecognized_model を一度知らせたモデル（プロセスをまたいで共有） */
const warnedModels = new Set<string>();

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
  /** stop()/kill() で自分から止めた */
  private stopping = false;

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

  /** 起動引数（テストから確かめられるよう分けている） */
  buildArgs(): string[] {
    const args = [...baseClaudeArgs(this.options), "--input-format", "stream-json"];
    // エージェント向けの説明書（agent/AGENTS.md）を全セッションに渡す（CLAUDE.md は開発者向けなので読ませない）
    const guide = this.options.agentsGuide === false ? "" : agentsGuide();
    if (this.options.systemPrompt !== undefined) args.push("--system-prompt", [this.options.systemPrompt, guide].filter(Boolean).join("\n\n"));
    else {
      const append = [this.options.appendSystemPrompt, guide].filter(Boolean).join("\n\n");
      if (append) args.push("--append-system-prompt", append);
    }
    if (this.options.tools !== undefined) args.push("--tools", this.options.tools);
    if (this.options.noSessionPersistence) args.push("--no-session-persistence");
    if (this.options.agents) args.push("--agents", JSON.stringify(this.options.agents));
    return args;
  }

  start(): void {
    if (this.proc) return;
    const args = this.buildArgs();

    const log = this.options.quietLifecycle ? logger.debug.bind(logger) : logger.info.bind(logger);
    log({ model: this.options.model ?? null, effort: this.options.effort ?? null, label: this.options.label ?? null }, "Starting Claude session");
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
      if (!line.trim()) return;
      // Claude Code が知らないモデル名（ゲートウェイの gpt/glm 等）への警告。動作には影響しないので1モデルにつき1回だけ出す
      const m = line.match(/unrecognized_model\]\s*(\{.*\})/);
      if (m) {
        const model = (() => { try { return String((JSON.parse(m[1]!) as { model?: string }).model ?? ""); } catch { return ""; } })();
        if (warnedModels.has(model)) return;
        warnedModels.add(model);
        this.emit("system", "Model Notice", `Claude Code が知らないモデル (${model || "?"}) です。動作には影響しません（推定コストは不正確）`);
        return;
      }
      this.emit("error", "stderr", line.slice(0, 800));
    });
    void this.proc.exited.then((code) => {
      this.deadReason = `Claude process exited (code ${code})`;
      this.proc = null;
      this.busyFlag = false;
      const expected = this.stopping || code === 0;
      if (!expected) this.emit("error", "Session Ended", this.deadReason);
      else if (!this.options.quietLifecycle) this.emit("system", "Session Ended", this.deadReason);
      if (this.pending && !this.pending.timedOut) this.pending.resolve({ status: "dead", error: this.deadReason });
      this.pending = null;
    });
    if (!this.options.quietLifecycle) this.emit("system", "Session Started", `model=${this.options.model ?? "default"} effort=${this.options.effort ?? "default"}`);
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
      try {
        this.proc!.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
        this.proc!.stdin.flush();
      } catch (err) {
        // 送る直前にプロセスが終わっていた等。例外で試合を止めず、dead として返す
        this.pending = null;
        this.busyFlag = false;
        entry.timedOut = true;
        resolve({ status: "dead", error: `送信できない: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  /** 処理中でもすぐ止める（使い捨ての問い合わせが予算切れになった時など。以降のトークン消費を止める） */
  kill(): void {
    this.stopping = true;
    this.proc?.kill();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;
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
      if (!this.contextFromAssistant) {
        const size = contextSizeFromRaw(ev.usage);
        if (size !== null) this.contextTokens = size;
      }
      this.contextFromAssistant = false;
      const entry = this.pending;
      this.pending = null;
      this.busyFlag = false;
      const text = typeof ev.result === "string" ? ev.result : "";
      // API エラー（モデル名の誤り・ゲートウェイの拒否等）は応答ではないので dead として返し、思考ログにも出す
      const apiError = ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype.startsWith("error")) || /^API Error:/.test(text);
      if (apiError) this.emit("error", "API Error", (text || ev.subtype || "unknown").slice(0, 800));
      if (entry && !entry.timedOut) {
        if (apiError) entry.resolve({ status: "dead", error: (text || ev.subtype || "API error").slice(0, 300) });
        else entry.resolve({ status: "ok", text, durationMs: Date.now() - entry.startedAt });
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
