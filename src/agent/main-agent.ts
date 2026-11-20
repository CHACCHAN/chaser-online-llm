import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CMD1_COMMANDS, CMD2_COMMANDS, type WorldMap } from "../memory/world-map";
import { AGENT_DIR, VAR_DIR } from "../paths";
import { numSetting } from "../settings";
import type { AgentPlan, SolverDecision } from "../solver/active-solver";
import { logger } from "../tools/logger";
import { uiBus } from "../ui/event-bus";
import type { ClaudeModelSettings } from "./claude-env";
import { type AskResult, ClaudeSession } from "./claude-session";
import { SubWorker } from "./sub-worker";
import { addUsage, diffUsage, emptyUsage, totalTokens, type UsageTotals } from "./usage";

export const CURRENT_SNAPSHOT_PATH = path.join(VAR_DIR, "current/snapshot.json");

export type MainAction = "continue" | "plan" | "command";

export interface MainDecision {
  decision: SolverDecision;
  /** main = メインの判断を反映 (continue/plan/command) / solver = 時間切れ・不正応答・上限超過でソルバー単独 */
  source: "main" | "solver";
  action: MainAction | null;
  durationMs: number | null;
  note: string;
  delegated: string | null;
}

/** 試合中のエージェント使用量（UI と summary.json に出す） */
export interface AgentUsageReport {
  /** メイン（入れ替え前のセッション・入れ替え待ちの新メインを含む） */
  main: UsageTotals;
  sub: UsageTotals;
  /** 会話の要約係 */
  compact: UsageTotals;
  total: UsageTotals;
  totalTokens: number;
  /** 1試合の上限 (0 = 無制限) */
  limitTokens: number;
  limitReached: boolean;
  /** メインの今の会話の大きさ（トークン） */
  mainContextTokens: number | null;
  compactAtTokens: number;
  compactions: number;
  compacting: boolean;
}

interface MainReply {
  action: MainAction;
  command?: string;
  target?: [number, number];
  note?: string;
  delegate?: string;
}

interface Exchange {
  user: string;
  reply: string;
}

interface CompactionJob {
  /** 要約に含めた history の件数 */
  cut: number;
  /** 要約を持たせて準備中・準備済みの新しいメイン */
  standby: ClaudeSession | null;
  /** 新しいメインに渡した要約メッセージとその返答 */
  resume: Exchange | null;
  ready: boolean;
}

function readPrompt(name: string): string {
  return readFileSync(path.join(AGENT_DIR, "prompts", name), "utf-8");
}

function extractReplyJson(text: string): string | null {
  const m = [...text.matchAll(/\{[^{}]*"action"\s*:\s*"[^"]+"[^{}]*\}/g)];
  return m.length > 0 ? m[m.length - 1]![0] : null;
}

/**
 * 試合中に常駐する「作戦係＋例外係」のメインエージェント。
 * 毎フェーズ状況を受け取り、continue（今の作戦のまま）/ plan（目標マスを変える）/ command（手を直接指定）で返す。
 * 時間のかかる仕事は delegate でサブ (SubWorker) に投げ、結果は次のターンに届く。メイン自身は待たない。
 *
 * 会話が長くなると毎回送る量が増えてクォータを食う。AGENT_COMPACT_AT_TOKENS を超えたら
 * 試合を止めずに裏で要約係が要約し、要約を持たせた新しいメインにフェーズの区切りで入れ替える。
 * 使用量が AGENT_MATCH_TOKEN_LIMIT を超えたら、残りはソルバーのみで続ける。
 */
export class MainAgent {
  private session: ClaudeSession;
  private readonly sub: SubWorker;
  private plan: AgentPlan | null = null;
  private notices: string[] = [];
  private matchInfo = "";
  /** 今のメインセッションでのやり取り（次の要約の材料） */
  private history: Exchange[] = [];
  /** 入れ替えで終了したメインの使用量 */
  private retiredMainUsage: UsageTotals = emptyUsage();
  private compactUsage: UsageTotals = emptyUsage();
  private compaction: CompactionJob | null = null;
  private compactions = 0;
  private limitNotified = false;

  constructor(
    private readonly settings: ClaudeModelSettings,
    private readonly turnBudgetMs: number,
  ) {
    this.session = this.newMainSession();
    this.sub = new SubWorker(settings);
  }

  get alive(): boolean {
    return this.session.alive;
  }

  get currentPlan(): AgentPlan | null {
    return this.plan;
  }

  usage(): AgentUsageReport {
    const standby = this.compaction?.standby?.usage ?? emptyUsage();
    const main = addUsage(addUsage(this.retiredMainUsage, this.session.usage), standby);
    const sub = this.sub.usage;
    const compact = this.compactUsage;
    const total = addUsage(addUsage(main, sub), compact);
    const limitTokens = numSetting("AGENT_MATCH_TOKEN_LIMIT", { min: 0 });
    return {
      main,
      sub,
      compact,
      total,
      totalTokens: totalTokens(total),
      limitTokens,
      limitReached: limitTokens > 0 && totalTokens(total) >= limitTokens,
      mainContextTokens: this.session.contextSize,
      compactAtTokens: numSetting("AGENT_COMPACT_AT_TOKENS", { min: 0 }),
      compactions: this.compactions,
      compacting: this.compaction !== null,
    };
  }

  /** 試合開始時: メインとサブを起動し、ルーム情報を渡して準備させる */
  async begin(info: { room: number; stageName: string | null; webMap: boolean; highScore: number }): Promise<AskResult> {
    this.session.start();
    this.sub.start();
    this.plan = null;
    this.notices = [];
    this.history = [];
    this.matchInfo = `room=${info.room} stage=${info.stageName ?? "unknown"} webMap=${info.webMap} roomHighScore=${info.highScore}`;
    const text = [
      `[MATCH START] ${this.matchInfo}`,
      "knowledge/strategy.md と knowledge/tiles.json に目を通して準備し、準備できたら「READY」とだけ返答せよ。",
    ].join("\n");
    const res = await this.session.ask(text, numSetting("AGENT_WARMUP_TIMEOUT_SEC", { min: 5 }) * 1000);
    this.history.push({ user: text, reply: res.status === "ok" ? res.text : `(${res.status})` });
    this.publishUsage();
    return res;
  }

  /**
   * @param solve 作戦 (plan) を与えるとソルバー手を返す関数。continue/plan のときはこれで手を決める。
   */
  async decide(ctx: {
    turn: number;
    phase: "CMD1" | "CMD2";
    worldMap: WorldMap;
    solve: (plan: AgentPlan | null) => SolverDecision;
    events: string[];
  }): Promise<MainDecision> {
    this.refreshPlanStatus(ctx.worldMap);
    const solverNow = ctx.solve(this.plan);
    const fallback = (why: string, durationMs: number | null): MainDecision => ({
      decision: solverNow,
      source: "solver",
      action: null,
      durationMs,
      note: why,
      delegated: null,
    });

    if (this.checkLimit()) return fallback("token limit reached", null);

    this.maybeSwapToStandby();
    if (!this.session.alive) return fallback("main agent not running", null);
    if (this.session.busy) return fallback("main agent busy", null);

    await this.writeSnapshot(ctx.worldMap);
    const legal = ctx.phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const message = this.buildTurnMessage(ctx, solverNow, legal);
    const res = await this.session.ask(message, this.turnBudgetMs);
    this.history.push({ user: message, reply: res.status === "ok" ? res.text : `(${res.status})` });
    this.maybeStartCompaction();
    this.publishUsage();
    if (res.status === "timeout") return fallback(`timeout ${res.durationMs}ms`, res.durationMs);
    if (res.status !== "ok") return fallback(res.status === "dead" ? res.error : res.status, null);

    const reply = parseMainReply(res.text, ctx.turn, ctx.phase, legal);
    if (!reply) return fallback("応答に有効な JSON がない", res.durationMs);

    let delegated: string | null = null;
    if (reply.delegate) {
      const task = this.sub.enqueue(reply.delegate);
      delegated = `#${task.id} ${reply.delegate.slice(0, 80)}`;
    }

    let decision = solverNow;
    let note = "作戦どおり";
    if (reply.action === "plan" && reply.target) {
      this.plan = { target: reply.target, note: reply.note };
      decision = ctx.solve(this.plan);
      note = `作戦変更 → 目標 (${reply.target.join(",")})`;
    } else if (reply.action === "command" && reply.command) {
      decision = { command: reply.command as SolverDecision["command"], reason: reply.note ?? "", confidence: 1 };
      note = "手を直接指定";
    }
    return {
      decision: { ...decision, reason: `${decision.reason}${reply.note ? ` / ${reply.note}` : ""}` },
      source: "main",
      action: reply.action,
      durationMs: res.durationMs,
      note,
      delegated,
    };
  }

  /** 試合後: 同じセッション (試合の文脈を保持) で振り返り・ソルバー改修を行わせる */
  async postMatch(diagnosisMarkdown: string, runDir: string, timeoutMs: number): Promise<AskResult> {
    // 要約が準備済みなら入れ替えてから（その方が会話が小さい）、準備中なら取り消す
    this.maybeSwapToStandby();
    await this.cancelCompaction();
    if (!this.session.alive) return { status: "dead", error: "main agent not running" };
    const waitUntil = Date.now() + timeoutMs;
    while (this.session.busy && Date.now() < waitUntil) await Bun.sleep(1000);
    const subResults = this.formatSubResults();
    const res = await this.session.ask(
      [
        "[POST-MATCH] 試合が終わった。以下の診断と、この試合で自分が見た盤面・立てた作戦の記憶をもとに改善せよ。",
        "",
        diagnosisMarkdown,
        subResults ? `\n${subResults}` : "",
        "",
        "## やること",
        "1. 失点原因と、作戦（plan）が効いた/効かなかった場面を特定する（必要なら Agent ツールで調査を並行してよい）。",
        "2. `src/solver/active-solver.ts` を改修する（`decideTurnAction(worldMap, phase, turn, plan)` のシグネチャは維持）。編集してよいのは active-solver.ts（とそのテスト）・knowledge/・agent/tools/ だけ。それ以外（runner.ts 等のハーネス）を変えても自動で元に戻される。ハーネスの改善案は報告に書くこと。",
        "3. 判明したタイル得点・ルールは knowledge/ に残す。試合中に作った臨時ツール（`@temporary`）は、ソルバーへ組み込む／正式ツールにする（`@temporary` を外す）／削除する、のどれかに決める。",
        `4. \`bun src/cli.ts verify --run-dir ${runDir}\` と \`bun run typecheck\` が通るまで直す。`,
        "5. 最後に、何を変えたかを3行以内で報告する。",
      ].join("\n"),
      timeoutMs,
    );
    this.publishUsage();
    return res;
  }

  async end(): Promise<void> {
    await this.cancelCompaction();
    await Promise.all([this.session.stop(), this.sub.stop()]);
    this.publishUsage();
  }

  private newMainSession(): ClaudeSession {
    return new ClaudeSession({
      ...this.settings,
      context: "in_game",
      label: "main",
      appendSystemPrompt: readPrompt("main.md"),
    });
  }

  /** 上限超過ならサブへの新規依頼も止め、true を返す */
  private checkLimit(): boolean {
    const usage = this.usage();
    if (!usage.limitReached) return false;
    if (!this.limitNotified) {
      this.limitNotified = true;
      void this.cancelCompaction();
      uiBus.pushClaudeEvent({
        context: "in_game",
        kind: "error",
        title: "トークン上限に到達",
        content: `この試合で ${usage.totalTokens.toLocaleString()} トークン使用（上限 ${usage.limitTokens.toLocaleString()}、AGENT_MATCH_TOKEN_LIMIT）。残りはソルバーのみで続ける`,
      });
      this.publishUsage();
    }
    return true;
  }

  /**
   * 会話が閾値を超えたら裏で要約を始める（メインはそのまま試合を続ける）。
   * 1. 要約係（サブと同じモデル）がここまでの会話を要約
   * 2. 要約を持たせた新しいメインを起動して準備させる
   * 3. 次のフェーズの頭で入れ替える（maybeSwapToStandby）。要約後に進んだやり取りは入れ替え時に引き継ぐ
   */
  private maybeStartCompaction(): void {
    const threshold = numSetting("AGENT_COMPACT_AT_TOKENS", { min: 0 });
    // ゲートウェイが usage を返さないモデルでは、会話の文字数から推定する（日本語混じりで約3文字/トークン）
    const size =
      this.session.contextSize ??
      Math.round(this.history.reduce((n, e) => n + e.user.length + e.reply.length, 0) / 3) + 20_000;
    if (threshold === 0 || this.compaction !== null || size < threshold) return;

    const cut = this.history.length;
    const transcript = this.history
      .slice(0, cut)
      .map((e, i) => `### ${i + 1}. 状況\n${e.user}\n### ${i + 1}. メインの返答\n${e.reply}`)
      .join("\n\n");
    const job: CompactionJob = { cut, standby: null, resume: null, ready: false };
    this.compaction = job;
    uiBus.pushClaudeEvent({
      context: "in_game",
      kind: "system",
      title: "会話の要約を開始（裏で実行）",
      content: `メインの会話が ${size.toLocaleString()} トークン（閾値 ${threshold.toLocaleString()}）。試合は止めずに続ける`,
    });
    void this.runCompaction(job, transcript).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Compaction failed");
      if (this.compaction === job) this.compaction = null;
    });
  }

  private async runCompaction(job: CompactionJob, transcript: string): Promise<void> {
    const summarizer = new ClaudeSession({
      ...this.settings,
      model: this.settings.subModel || this.settings.model,
      effort: this.settings.subEffort || this.settings.effort,
      context: "in_game",
      label: "compact",
      appendSystemPrompt: readPrompt("compact.md"),
    });
    summarizer.start();
    const summary = await summarizer.ask(
      `以下の会話ログを要約せよ。\n\n${transcript}`,
      numSetting("AGENT_SUB_TASK_TIMEOUT_MIN", { min: 1 }) * 60_000,
    );
    await summarizer.stop();
    this.compactUsage = addUsage(this.compactUsage, summarizer.usage);
    this.publishUsage();
    if (this.compaction !== job) return; // 試合終了・上限到達で取り消された
    if (summary.status !== "ok" || !summary.text.trim()) {
      logger.warn({ status: summary.status }, "Compaction summary failed; keeping current main session");
      this.compaction = null;
      return;
    }

    const standby = this.newMainSession();
    job.standby = standby;
    standby.start();
    const resumeText = [
      `[MATCH RESUME] ${this.matchInfo}`,
      "あなたは試合の途中から作戦係を引き継ぐ。以下はここまでの会話の要約。次のメッセージから通常どおり毎フェーズの状況が届く。",
      "",
      summary.text.trim(),
      "",
      "準備できたら「READY」とだけ返答せよ。",
    ].join("\n");
    const ready = await standby.ask(resumeText, numSetting("AGENT_WARMUP_TIMEOUT_SEC", { min: 5 }) * 1000);
    if (this.compaction !== job) return; // cancelCompaction が standby を止めて使用量を計上済み
    if (ready.status !== "ok") {
      logger.warn({ status: ready.status }, "Standby main warm-up failed; keeping current main session");
      await this.cancelCompaction();
      return;
    }
    job.resume = { user: resumeText, reply: ready.text };
    job.ready = true;
  }

  /** 新しいメインの準備ができていれば入れ替える（フェーズの頭・試合後の振り返り前に呼ぶ） */
  private maybeSwapToStandby(): void {
    const job = this.compaction;
    if (!job?.ready || !job.standby || !job.resume) return;

    // 要約に含まれていない直近のやり取りは、次のメッセージの冒頭で新しいメインに伝える
    const missed = this.history.slice(job.cut);
    if (missed.length > 0) {
      const recent = missed
        .map((e) => `- ${e.user.split("\n")[0]} → ${extractReplyJson(e.reply) ?? e.reply.slice(0, 200)}`)
        .join("\n");
      this.notices.unshift(`[要約後の直近のやり取り]\n${recent}`);
    }

    const old = this.session;
    const before = old.usage;
    this.retiredMainUsage = addUsage(this.retiredMainUsage, before);
    this.session = job.standby;
    this.history = [job.resume];
    this.compaction = null;
    this.compactions += 1;
    // 古いメインが処理中（タイムアウト後など）でも止めてよい。止まるまでに届いた分も計上する
    void old.stop().then(() => {
      this.retiredMainUsage = addUsage(this.retiredMainUsage, diffUsage(old.usage, before));
    });
    uiBus.pushClaudeEvent({
      context: "in_game",
      kind: "system",
      title: "メインを入れ替え（要約済み）",
      content: `要約 ${this.compactions} 回目。要約後の直近 ${missed.length} 回のやり取りは次のメッセージで引き継ぐ`,
    });
    this.publishUsage();
  }

  private async cancelCompaction(): Promise<void> {
    const job = this.compaction;
    this.compaction = null;
    if (job?.standby) {
      await job.standby.stop();
      this.retiredMainUsage = addUsage(this.retiredMainUsage, job.standby.usage);
    }
  }

  private publishUsage(): void {
    uiBus.patchState({ agentUsage: this.usage() });
  }

  /** 作戦目標への到達・到達不能を検知して作戦を解除し、次のメッセージで知らせる */
  private refreshPlanStatus(worldMap: WorldMap): void {
    if (!this.plan) return;
    const step = worldMap.firstStepTowards(this.plan.target[0], this.plan.target[1]);
    if (step === "here") {
      this.notices.push(`作戦目標 (${this.plan.target.join(",")}) に到達。作戦を解除した`);
      this.plan = null;
    } else if (step === null) {
      this.notices.push(`作戦目標 (${this.plan.target.join(",")}) へ到達できない。作戦を解除した`);
      this.plan = null;
    }
  }

  private formatSubResults(): string {
    const finished = this.sub.takeFinished();
    if (finished.length === 0) return "";
    return finished
      .map((t) => `サブ結果 #${t.id} [${t.status}${t.durationMs ? ` ${Math.round(t.durationMs / 1000)}s` : ""}]: ${t.result ?? ""}`)
      .join("\n");
  }

  private async writeSnapshot(worldMap: WorldMap): Promise<void> {
    mkdirSync(path.dirname(CURRENT_SNAPSHOT_PATH), { recursive: true });
    await Bun.write(CURRENT_SNAPSHOT_PATH, JSON.stringify(worldMap.toSnapshot()));
  }

  private buildTurnMessage(
    ctx: { turn: number; phase: "CMD1" | "CMD2"; worldMap: WorldMap; events: string[] },
    solverNow: SolverDecision,
    legal: readonly string[],
  ): string {
    const ev = ctx.worldMap.evaluateCandidates(ctx.phase);
    const stats = ctx.worldMap.getStats();
    const targets = [
      ...ev.topValueTargets.slice(0, 4).map((t) => `${t.tileLabel}(${t.x},${t.y}) 距離${t.distance} 純益${t.estimatedNetGain}`),
      ...ev.nearestFrontiers.slice(0, 3).map((t) => `未探索(${t.x},${t.y}) 距離${t.distance}`),
    ];
    const lines = [
      `[TURN ${ctx.turn} / ${ctx.phase}] budget=${Math.round(this.turnBudgetMs / 1000)}s`,
      `pos=(${ev.position.join(",")}) est=${stats.estimatedTotalScore} (action ${stats.estimatedActionScore}, item ${stats.estimatedItemScore}) holeRevisits=${stats.holeRevisits}`,
      "map (@=自分, ?=未知):",
      ctx.worldMap.renderAscii(6),
      `現在の作戦: ${this.plan ? `目標(${this.plan.target.join(",")})${this.plan.note ? ` ${this.plan.note}` : ""}` : "なし（ソルバーの貪欲探索）"}`,
      `continue した場合の手: ${solverNow.command} — ${solverNow.reason}`,
      `目標候補: ${targets.join(" / ") || "なし"}`,
    ];
    if (ctx.events.length > 0) lines.push(`イベント: ${ctx.events.join(", ")}`);
    if (this.notices.length > 0) lines.push(...this.notices.splice(0));
    const subResults = this.formatSubResults();
    if (subResults) lines.push(subResults);
    const pending = this.sub.pending();
    if (pending.length > 0) lines.push(`サブ作業中: ${pending.map((t) => `#${t.id}`).join(", ")}`);
    lines.push(`合法手: ${legal.join(",")}`);
    return lines.join("\n");
  }
}

export function parseMainReply(
  text: string,
  turn: number,
  phase: string,
  legal: readonly string[],
): MainReply | null {
  const matches = [...text.matchAll(/\{[^{}]*"action"\s*:\s*"[^"]+"[^{}]*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]![0]) as {
        turn?: number; phase?: string; action?: string; command?: string;
        target?: unknown; note?: string; delegate?: string;
      };
      if (obj.turn !== undefined && obj.turn !== turn) continue;
      if (obj.phase !== undefined && obj.phase !== phase) continue;
      const delegate = typeof obj.delegate === "string" && obj.delegate.trim() ? obj.delegate.trim() : undefined;
      const note = typeof obj.note === "string" ? obj.note : undefined;
      if (obj.action === "continue") return { action: "continue", note, delegate };
      if (obj.action === "command" && obj.command && legal.includes(obj.command)) {
        return { action: "command", command: obj.command, note, delegate };
      }
      if (
        obj.action === "plan" &&
        Array.isArray(obj.target) &&
        obj.target.length === 2 &&
        obj.target.every((v) => Number.isInteger(v))
      ) {
        return { action: "plan", target: [obj.target[0] as number, obj.target[1] as number], note, delegate };
      }
    } catch {
      // 次の候補へ
    }
  }
  return null;
}
