import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CMD1_COMMANDS, CMD1_SPECS, CMD2_COMMANDS, CMD2_SPECS, classifyTileSafety, type WorldMap } from "../memory/world-map";
import { getRoomProfile, knownTotalTurns } from "../memory/knowledge-store";
import { AGENT_DIR, COMMANDS_PATH, OFFICIAL_RULES_PATH, CURRENT_ASK_SUB_PATH, CURRENT_MEMO_PATH, RUNS_DIR, STRATEGY_PATH, VAR_DIR } from "../paths";
import { numSetting } from "../settings";
import type { AgentPlan, SolverDecision } from "../solver/active-solver";
import { uiBus } from "../ui/event-bus";
import type { ClaudeModelSettings } from "./claude-env";
import { type AskResult, ClaudeSession } from "./claude-session";
import { activePolicyPrompt } from "./policy";
import { formatSubTodoLine, SubWorker } from "./sub-worker";
import { addUsage, emptyUsage, totalTokens, type UsageTotals } from "./usage";
import { checkOfficialVersion, type OfficialVersionCheck } from "../perception/official-check";

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
  /** メイン（毎フェーズの問い合わせ＋試合後の振り返り） */
  main: UsageTotals;
  sub: UsageTotals;
  total: UsageTotals;
  totalTokens: number;
  /** 1試合の上限 (0 = 無制限) */
  limitTokens: number;
  limitReached: boolean;
  /** 直近のメイン問い合わせ1回の入力トークン（キャッシュ込み） */
  lastCallInputTokens: number | null;
  /** main に含まれる、予算切れで止めた問い合わせの見積もり分 */
  estimatedTimeoutTokens: number;
}

interface MainReply {
  action: MainAction;
  command?: string;
  target?: [number, number];
  note?: string;
  delegate?: string;
  memo?: string;
  /** メモの末尾に1行足す（全文を書き直さずに済む＝出力が短く速い） */
  memoAdd?: string;
}

function readPrompt(name: string): string {
  return readFileSync(path.join(AGENT_DIR, "prompts", name), "utf-8");
}

/**
 * 試合中の「作戦係＋例外係」のメインエージェント。
 *
 * 毎フェーズ **前の会話を持たない使い捨ての `claude -p`** で問い合わせる（--no-session-persistence, --tools "",
 * --system-prompt で Claude Code 既定のシステムプロンプトとツール定義を外す）。1回あたりのトークンが一定で小さい。
 * 引き継ぐのは、メイン自身が書くメモ・ハーネスが作る直近の経過・現在の状況だけ。
 * 次のフェーズ用のプロセスは裏で先に起動しておく。予算を超えた問い合わせは止めて捨てる（次のフェーズを待たせない）。
 * 時間のかかる仕事は delegate でサブ (SubWorker、ツールあり・仕事ごとに新しいセッション) に投げ、結果は後のフェーズに届く。
 */
export class MainAgent {
  private readonly sub: SubWorker;
  private started = false;
  private plan: AgentPlan | null = null;
  private notices: string[] = [];
  private matchInfo = "";
  /** このルームの1試合の全ターン数（過去の公式結果から。不明なら null） */
  private totalTurns: number | null = null;
  /** 固定のシステムプロンプト（main.md ＋ 作戦方針 ＋ 戦略知識）。試合中は不変なのでキャッシュも効きやすい */
  private systemPrompt = "";
  private memo = "";
  private recent: string[] = [];
  private lastEst: number | null = null;
  /** 次のフェーズ用に先に起動しておくプロセス */
  private next: ClaudeSession | null = null;
  /** 振り返りのセッション（このあとハーネスのレビューを同じ会話で聞くため、すぐには閉じない） */
  private postSession: ClaudeSession | null = null;
  private mainUsage: UsageTotals = emptyUsage();
  private lastCallInputTokens: number | null = null;
  /** 予算切れで止めた問い合わせの見積もり分（実際の使用量は不明） */
  private estimatedTimeoutTokens = 0;
  private limitNotified = false;
  /** 前のフェーズの座標系（ワープで変わったら作戦目標・メモの座標が無効になる） */
  private frameVersion: number | null = null;

  constructor(
    private readonly settings: ClaudeModelSettings,
    private readonly turnBudgetMs: number,
  ) {
    this.sub = new SubWorker(settings);
  }

  get alive(): boolean {
    return this.started;
  }

  get currentPlan(): AgentPlan | null {
    return this.plan;
  }

  get currentMemo(): string {
    return this.memo;
  }

  usage(): AgentUsageReport {
    const sub = this.sub.usage;
    const main = this.postSession ? addUsage(this.mainUsage, this.postSession.usage) : this.mainUsage;
    const total = addUsage(main, sub);
    const limitTokens = numSetting("AGENT_MATCH_TOKEN_LIMIT", { min: 0 });
    return {
      main: { ...main },
      sub,
      total,
      totalTokens: totalTokens(total),
      limitTokens,
      limitReached: limitTokens > 0 && totalTokens(total) >= limitTokens,
      lastCallInputTokens: this.lastCallInputTokens,
      estimatedTimeoutTokens: this.estimatedTimeoutTokens,
    };
  }

  /** 試合開始時: サブを起動し、最初の問い合わせ用プロセスを用意する（モデル呼び出しはしない） */
  /**
   * 試合開始（入室前）。prepared があれば準備フェーズで作ったメモから始める（準備は「開始」より前に runPrepPhase で済ませておく）。
   */
  async begin(
    info: { room: number; stageName: string | null; webMap: boolean; highScore: number; totalTurns?: number | null },
    prepared?: { memo: string; usage: UsageTotals } | null,
  ): Promise<AskResult> {
    this.started = true;
    this.plan = null;
    this.notices = [];
    this.memo = "";
    this.recent = [];
    this.lastEst = null;
    this.frameVersion = null;
    this.totalTurns = info.totalTurns ?? null;
    this.matchInfo = `room=${info.room} stage=${info.stageName ?? "unknown"} webMap=${info.webMap} roomHighScore=${info.highScore} totalTurns=${this.totalTurns ?? "不明（このルームの公式結果がまだない）"}`;
    const policy = activePolicyPrompt();
    const strategy = existsSync(STRATEGY_PATH) ? readFileSync(STRATEGY_PATH, "utf-8") : "";
    // 試合中のメインはツールなしでファイルを読めないので、ルールとコマンドの表はここで中身を入れる（AGENTS.md は付けない）
    const commands = existsSync(COMMANDS_PATH) ? readFileSync(COMMANDS_PATH, "utf-8").trim() : "";
    const rules = existsSync(OFFICIAL_RULES_PATH) ? readFileSync(OFFICIAL_RULES_PATH, "utf-8").trim() : "";
    this.systemPrompt = [
      readPrompt("main.md"),
      rules ? `\n## ゲームのルール（knowledge/official-rules.md）\n${rules.replace(/^# .*\n/, "")}` : "",
      commands ? `\n## ゲームのコマンド（knowledge/commands.md）\n${commands.replace(/^# .*\n/, "")}` : "",
      `\n## この試合\n${this.matchInfo}`,
      policy ? `\n${policy}` : "",
      strategy ? `\n## 戦略知識（knowledge/strategy.md）\n${strategy}` : "",
    ].join("\n");
    if (prepared) {
      this.memo = prepared.memo;
      this.mainUsage = addUsage(this.mainUsage, prepared.usage);
    }
    this.sub.start();
    this.next = this.spawnCall();
    this.publish();
    return { status: "ok", text: "ready", durationMs: 0 };
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
    this.checkFrameChange(ctx.worldMap);
    this.refreshPlanStatus(ctx.worldMap);
    const solverNow = ctx.solve(this.plan);
    const result = await this.ask(ctx, solverNow);
    this.remember(ctx, result);
    this.publish();
    return result;
  }

  /** 試合後: ツールありの新しいセッションで、メモ・経過・診断をもとに振り返りとソルバー改修を行わせる */
  async postMatch(diagnosisMarkdown: string, runDir: string, timeoutMs: number): Promise<AskResult> {
    this.next?.kill();
    this.next = null;
    // 振り返り中にサブが並行して同じファイル（ソルバー・knowledge・tools）を書き換えないよう、先に止める
    await this.sub.stop();
    const session = new ClaudeSession({
      ...this.settings,
      context: "evolution",
      label: "main",
      // main.md は試合中用（ツールなし・毎フェーズ新規）なので渡さない。役割とルールは下の依頼文に書く
      appendSystemPrompt: "あなたは CHaserOnline003 攻略プロジェクトのメインエージェント。試合後の振り返りとソルバー改修を行う。ツールを使ってよい。試合中の役割は agent/prompts/main.md にある。",
    });
    session.start();
    const subResults = this.formatSubResults();
    const policy = activePolicyPrompt();
    const res = await session.ask(
      [
        "[POST-MATCH] 試合が終わった。あなたは試合中のメインエージェント（作戦係）として振り返り、改善せよ。この振り返りではツールを使ってよい。",
        `試合: ${this.matchInfo} / ログ: ${runDir}/turns.jsonl（各ターンの手・観測・判断主体）, ${runDir}/summary.json, ${runDir}/MEMO.md, ${runDir}/ASK_SUB.md（依頼と結果の全文）`,
        "",
        "## 試合中のあなたのメモ（最終）",
        this.memo || "(なし)",
        "",
        "## 直近の経過",
        this.recent.join("\n") || "(なし)",
        "",
        diagnosisMarkdown,
        this.formatSubTodo(),
        subResults ? `\n${subResults}` : "",
        policy ? `\n${policy}\n\nソルバーの改修もこの方針に沿わせること。` : "",
        "",
        "## やること",
        "1. ログを読み、失点原因と、作戦（plan）・直接指定（command）が効いた/効かなかった場面を特定する（必要なら Agent ツールで調査を並行してよい）。",
        "2. `src/solver/active-solver.ts` を改修する（`decideTurnAction(worldMap, phase, turn, plan)` のシグネチャは維持）。編集してよいのは active-solver.ts（とそのテスト）・knowledge/・agent/tools/ だけ。それ以外（runner.ts 等のハーネス）を変えても自動で元に戻される。ハーネスの改善案は報告に書くこと。",
        "3. 判明したタイル得点・ルールは knowledge/ に残す。試合中に作った臨時ツール（`@temporary`）は、ソルバーへ組み込む／正式ツールにする（`@temporary` を外す）／削除する、のどれかに決める。",
        `4. \`bun src/cli.ts verify --run-dir ${runDir}\` と \`bun run typecheck\` が通るまで直す。`,
        "5. 最後に、何を変えたかを3行以内で報告する。",
      ].join("\n"),
      timeoutMs,
    );
    if (res.status === "ok") {
      // 振り返りの経験を持ったまま、このあとハーネスのレビューを聞く（reviewHarness）
      this.postSession = session;
    } else {
      session.kill();
      this.mainUsage = addUsage(this.mainUsage, session.usage);
    }
    this.publish();
    return res;
  }

  /**
   * 振り返りのあと、ハーネス（このプロジェクト）の使い勝手・不具合・欲しい機能を聞く。返答は agent/REVIEW.md に入る（evolve.ts）。
   * 振り返りのセッションが生きていればその続きで聞く（試合と改修の経験を持っている）。無ければ新しいセッションで聞く。
   */
  async reviewHarness(info: { runDir: string; reverted: string[]; verificationOk: boolean; rolledBack: boolean }, timeoutMs: number): Promise<string | null> {
    let session = this.postSession;
    this.postSession = null;
    if (!session?.alive) {
      session?.kill();
      session = new ClaudeSession({ ...this.settings, context: "evolution", label: "review", tools: "Read,Glob,Grep", noSessionPersistence: true });
      session.start();
    }
    const fresh = session.usage.calls === 0;
    const res = await session.ask(
      [
        "[HARNESS REVIEW] 振り返りお疲れさま。最後に、あなた（とサブ・試合中の毎フェーズのあなた）が使った**ハーネス（このプロジェクトの仕組み）**をレビューしてほしい。開発者が次の開発の参考にする。",
        fresh ? `この試合のログ: ${info.runDir}（turns.jsonl の main の判断理由・MEMO.md・ASK_SUB.md・evolution-report.md）。試合中のあなたへの指示は agent/prompts/main.md、サブへの指示は agent/prompts/sub.md。` : "",
        `改修の結果: リプレイ検証 ${info.verificationOk ? "合格" : "不合格"}${info.rolledBack ? "（ソルバーは元に戻された）" : ""}${info.reverted.length > 0 ? ` / 編集範囲外として元に戻されたファイル: ${info.reverted.join(", ")}` : ""}`,
        "これまでのレビューは agent/REVIEW.md にある（同じ指摘の繰り返しは避け、`[対応済み]` の項目が本当に直ったかも確かめる）。このレビューではファイルを編集しない（読むだけ。編集しても元に戻される）。",
        "",
        "観点（ゲームの作戦ではなく、仕組みについて）:",
        "- 毎フェーズ渡される情報（盤面・候補・メモ・直近の経過・サブのTODO）に足りないもの・多すぎるもの・分かりにくいもの",
        "- 返答形式・時間予算・メモの上限・ソルバーとの役割分担で困ったこと",
        "- サブへの依頼・ツール・CLI・ログ・ドキュメント（AGENTS.md 等）の使いにくさ、不具合らしき挙動",
        "- あれば強くなれる機能・情報",
        "",
        "返答はレビュー本文だけを Markdown で（前置き不要、1500字以内）。次の見出しを使い、各項目は1〜2行で、根拠（ターン番号・ファイル）を添える。無い見出しは省く:",
        "### 使いにくかった点\n### 不具合らしきもの\n### 欲しい機能・改善案\n### 対応済みの確認",
      ]
        .filter(Boolean)
        .join("\n"),
      timeoutMs,
    );
    if (res.status === "ok") await session.stop();
    else session.kill();
    this.mainUsage = addUsage(this.mainUsage, session.usage);
    this.publish();
    return res.status === "ok" && res.text.trim() ? res.text.trim() : null;
  }

  async end(): Promise<void> {
    this.next?.kill();
    this.next = null;
    if (this.postSession) {
      this.mainUsage = addUsage(this.mainUsage, this.postSession.usage);
      this.postSession.kill();
      this.postSession = null;
    }
    this.started = false;
    await this.sub.stop();
    this.publish();
  }

  private spawnCall(): ClaudeSession {
    const s = new ClaudeSession({
      ...this.settings,
      context: "in_game",
      label: "main",
      systemPrompt: this.systemPrompt,
      // ファイルを読めないので AGENTS.md（案内）は付けず、コマンドの表の中身を systemPrompt に入れてある（begin）
      agentsGuide: false,
      tools: "",
      noSessionPersistence: true,
      quietLifecycle: true,
    });
    s.start();
    return s;
  }

  private async ask(
    ctx: { turn: number; phase: "CMD1" | "CMD2"; worldMap: WorldMap; solve: (plan: AgentPlan | null) => SolverDecision; events: string[] },
    solverNow: SolverDecision,
  ): Promise<MainDecision> {
    const fallback = (why: string, durationMs: number | null): MainDecision => ({
      decision: solverNow,
      source: "solver",
      action: null,
      durationMs,
      note: why,
      delegated: null,
    });
    if (!this.started) return fallback("main agent not running", null);
    if (this.checkLimit()) return fallback("token limit reached", null);

    await this.writeSnapshot(ctx.worldMap);
    const legal = ctx.phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const message = this.buildTurnMessage(ctx, solverNow, legal);

    // 先に起動しておいたプロセスで聞き、すぐ次のフェーズ用を起動する
    // 先に起動したプロセスが待ち時間の間に終わっていたら（他プレイヤー待ちが長い等）新しく起動する
    let call = this.next;
    if (!call?.alive) {
      call?.kill();
      call = this.spawnCall();
    }
    this.next = this.spawnCall();
    const res = await call.ask(message, this.turnBudgetMs);
    if (res.status === "ok") {
      const u = call.usage;
      this.mainUsage = addUsage(this.mainUsage, u);
      this.lastCallInputTokens = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      void call.stop();
    } else {
      // 予算切れ・異常: 止めて捨てる。使用量は報告されないが入力は送信済みなので、直近の入力量で見積もって上限の判定に含める
      call.kill();
      if (res.status === "timeout") {
        const est = this.lastCallInputTokens ?? Math.ceil((this.systemPrompt.length + message.length) / 2);
        this.mainUsage = addUsage(this.mainUsage, { ...emptyUsage(), calls: 1, inputTokens: est });
        this.estimatedTimeoutTokens += est;
      }
    }

    if (res.status === "timeout") return fallback(`timeout ${res.durationMs}ms`, res.durationMs);
    if (res.status !== "ok") return fallback(res.status === "dead" ? res.error : res.status, null);

    const reply = parseMainReply(res.text, ctx.turn, ctx.phase, legal);
    if (!reply) return fallback("応答に有効な JSON がない", res.durationMs);

    this.applyMemo(reply);
    let delegated: string | null = null;
    if (reply.delegate) {
      const task = this.sub.enqueue(reply.delegate, `T${ctx.turn} ${ctx.phase}`);
      delegated = `#${task.id} ${reply.delegate.slice(0, 80)}`;
    }

    let decision = solverNow;
    let note = "作戦どおり";
    if (reply.action === "plan" && reply.target) {
      this.plan = { target: reply.target, note: reply.note };
      decision = ctx.solve(this.plan);
      note = `作戦変更 → 目標 (${reply.target.join(",")})`;
    } else if (reply.action === "command" && reply.command) {
      // 安全ガード: 行き先が罠・通行不可なのに、ソルバーの手なら避けられる時は却下する（モデルの見落とし対策）
      const danger = landingDanger(ctx.worldMap, reply.command);
      if (danger && !landingDanger(ctx.worldMap, solverNow.command)) {
        note = `手の指定を却下（${reply.command} の行き先は${danger}）→ ソルバー手`;
        this.notices.push(`前のフェーズの指定 ${reply.command} は行き先が${danger}だったので却下し、ソルバー手 ${solverNow.command} を送った。合法手の一覧と周囲のマスを確かめてから指定すること`);
        uiBus.pushClaudeEvent({ context: "in_game", kind: "error", title: "危険な手を却下", content: `T${ctx.turn} ${ctx.phase}: ${reply.command}（行き先が${danger}）→ ${solverNow.command}` });
      } else {
        decision = { command: reply.command as SolverDecision["command"], reason: reply.note ?? "", confidence: 1 };
        note = "手を直接指定";
      }
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

  /** 返答の memo（全文置き換え）・memo_add（末尾に1行）を反映する。上限を超えた時は次のフェーズに知らせる */
  private applyMemo(reply: MainReply): void {
    const max = numSetting("AGENT_MEMO_MAX_CHARS", { min: 100, integer: true });
    if (reply.memo !== undefined) {
      if (reply.memo.length > max) this.notices.push(`memo が上限 ${max} 字を超えたので、${max} 字で切った`);
      this.memo = reply.memo.slice(0, max);
    }
    const add = reply.memoAdd?.trim();
    if (add) {
      const next = this.memo ? `${this.memo}\n${add}` : add;
      if (next.length > max) this.notices.push(`memo_add はメモの上限 ${max} 字を超えるので入らなかった（今 ${this.memo.length} 字）。memo で書き直せば入る`);
      else this.memo = next;
    }
  }

  /** 直近の経過に1行足す（次のフェーズのメインが流れを把握するため） */
  private remember(ctx: { turn: number; phase: "CMD1" | "CMD2"; worldMap: WorldMap }, r: MainDecision): void {
    const [x, y] = ctx.worldMap.getPosition();
    const est = ctx.worldMap.getStats().estimatedTotalScore;
    const delta = this.lastEst === null ? "" : ` (${est - this.lastEst >= 0 ? "+" : ""}${est - this.lastEst})`;
    this.lastEst = est;
    const who = r.source === "main" ? `main/${r.action}` : `solver: ${r.note}`;
    this.recent.push(`T${ctx.turn} ${ctx.phase} pos(${x},${y}) est=${est}${delta} → ${r.decision.command} [${who}]`);
    const keep = numSetting("AGENT_RECENT_PHASES", { min: 0, integer: true });
    if (this.recent.length > keep) this.recent.splice(0, this.recent.length - keep);
  }

  /** 上限超過なら true（残りはソルバーのみ） */
  private checkLimit(): boolean {
    const usage = this.usage();
    if (!usage.limitReached) return false;
    if (!this.limitNotified) {
      this.limitNotified = true;
      this.next?.kill();
      this.next = null;
      uiBus.pushClaudeEvent({
        context: "in_game",
        kind: "error",
        title: "トークン上限に到達",
        content: `この試合で ${usage.totalTokens.toLocaleString()} トークン使用（上限 ${usage.limitTokens.toLocaleString()}、AGENT_MATCH_TOKEN_LIMIT）。残りはソルバーのみで続ける`,
      });
    }
    return true;
  }

  private publish(): void {
    uiBus.patchState({ agentUsage: this.usage(), agentMemo: this.memo });
    try {
      mkdirSync(path.dirname(CURRENT_MEMO_PATH), { recursive: true });
      writeFileSync(CURRENT_MEMO_PATH, `# メインのメモ\n\nハーネスが毎フェーズ書き出す。編集しても試合には反映されない。\n\n${this.memo || "(まだない)"}\n`);
    } catch {
      // 書き出しに失敗しても試合は続ける
    }
  }

  /** 試合の記録フォルダへ MEMO.md / ASK_SUB.md を残す */
  archiveFiles(runDir: string): void {
    for (const f of [CURRENT_MEMO_PATH, CURRENT_ASK_SUB_PATH]) {
      try {
        if (existsSync(f)) copyFileSync(f, path.join(runDir, path.basename(f)));
      } catch {
        // ignore
      }
    }
  }

  /** ワープで座標系が変わったら、古い座標の作戦目標を解除し、メモの座標が古いことを知らせる */
  private checkFrameChange(worldMap: WorldMap): void {
    const v = worldMap.frameVersion;
    if (this.frameVersion !== null && v !== this.frameVersion) {
      if (this.plan) this.notices.push(`ワープで座標系が変わった。作戦目標 (${this.plan.target.join(",")}) は古い座標なので解除した`);
      else this.notices.push("ワープで座標系が変わった");
      this.notices.push("メモ・直近の経過に書かれた座標はワープ前の座標系（今の pos・マップとは対応しない）。必要ならメモを書き直すこと");
      this.plan = null;
      this.recent.push(`--- ワープ（ここより前の座標は古い座標系） ---`);
    }
    this.frameVersion = v;
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

  /** サブに頼んだ仕事の一覧（メインは前の会話を持たないので、同じ依頼の重複を防ぐために毎回渡す） */
  private formatSubTodo(): string {
    const tasks = this.sub.all();
    if (tasks.length === 0) return "";
    const rows = tasks.slice(-numSetting("AGENT_SUB_TODO_ITEMS", { min: 1, integer: true })).map((t) => formatSubTodoLine(t));
    return ["## サブへの依頼（TODO）", ...rows].join("\n");
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
      `[TURN ${ctx.turn}${this.totalTurns ? `/${this.totalTurns}（このターンを含め残り${Math.max(0, this.totalTurns - ctx.turn + 1)}）` : ""} / ${ctx.phase}] budget=${Math.round(this.turnBudgetMs / 1000)}s`,
      `## メモ（前のフェーズまでの自分から。${this.memo.length}/${numSetting("AGENT_MEMO_MAX_CHARS", { min: 100, integer: true })}字）`,
      this.memo || "(まだない)",
      "## 直近の経過",
      this.recent.join("\n") || "(試合開始)",
      "## 現在の状況",
      `pos=(${ev.position.join(",")}) est=${stats.estimatedTotalScore} (action ${stats.estimatedActionScore}, item ${stats.estimatedItemScore}) holeRevisits=${stats.holeRevisits}`,
      ctx.worldMap.renderAgentMap({
        enemies: ctx.worldMap.getEnemySightings().map((e) => ({ x: e.x, y: e.y, stale: e.lastSeenTurn < ctx.turn })),
        planTarget: this.plan?.target ?? null,
      }),
      `現在の作戦: ${this.plan ? `目標(${this.plan.target.join(",")})${this.plan.note ? ` ${this.plan.note}` : ""}` : "なし（ソルバーの貪欲探索）"}`,
      `continue した場合の手: ${solverNow.command} — ${solverNow.reason}`,
      `目標候補: ${targets.join(" / ") || "なし"}`,
    ];
    const enemies = ctx.worldMap.getEnemySightings();
    if (enemies.length > 0) {
      const [px, py] = ev.position;
      lines.push(
        `敵: ${enemies
          .map((e) => `P${e.tileId}(${e.x},${e.y}) 距離${Math.abs(e.x - px) + Math.abs(e.y - py)} T${e.lastSeenTurn}に目撃${e.lastSeenTurn < ctx.turn ? "（古い）" : ""}`)
          .join(" / ")}`,
      );
    }
    if (ctx.events.length > 0) lines.push(`イベント: ${ctx.events.join(", ")}`);
    if (this.notices.length > 0) lines.push(...this.notices.splice(0));
    const subResults = this.formatSubResults();
    if (subResults) lines.push(subResults);
    const todo = this.formatSubTodo();
    if (todo) lines.push(todo);
    lines.push(`合法手: ${legal.join(",")}`);
    return lines.join("\n");
  }
}

export interface PrepResult {
  status: AskResult["status"];
  error: string | null;
  memo: string;
  usage: UsageTotals;
  durationMs: number;
  official: OfficialVersionCheck;
}

/**
 * 準備フェーズ（「開始」より前。ルームには入らない）: 公式のバージョンを確かめ、ツール（読むだけ）ありの新しいセッションで
 * ルール・このルームの過去の試合・作戦方針を調べさせ、試合開始時のメモを作らせる。
 * 試合中のメインは前の会話を持たないので、最初のメモの質がそのまま序盤の判断に効く。
 */
export async function runPrepPhase(settings: ClaudeModelSettings, room: number, signal?: AbortSignal): Promise<PrepResult> {
  const t0 = Date.now();
  const timeoutSec = numSetting("AGENT_PREP_TIMEOUT_SEC", { min: 10 });
  const memoMax = numSetting("AGENT_MEMO_MAX_CHARS", { min: 100, integer: true });
  const official = await checkOfficialVersion();
  const pastRuns = existsSync(RUNS_DIR)
    ? readdirSync(RUNS_DIR)
        .filter((n) => n.endsWith(`_room${room}`))
        .sort()
        .reverse()
        .slice(0, numSetting("AGENT_PREP_PAST_RUNS", { min: 0, integer: true }))
        .map((n) => path.join(RUNS_DIR, n))
    : [];
  const profile = getRoomProfile(room);
  const session = new ClaudeSession({
    ...settings,
    context: "in_game",
    label: "prep",
    appendSystemPrompt: readPrompt("prep.md").replaceAll("{{MEMO_MAX}}", String(memoMax)).replaceAll("{{TIMEOUT}}", String(timeoutSec)),
    tools: "Read,Glob,Grep",
    noSessionPersistence: true,
  });
  session.start();
  signal?.addEventListener("abort", () => session.kill(), { once: true });
  const policy = activePolicyPrompt();
  const officialLine = official.changed
    ? `**公式のバージョンが変わった（記録 ${official.knownVersion} → 公式 ${official.version}）。** アイテムID・コマンド・ルールが変わった可能性がある。資料（AGENTS.md・knowledge/）の内容をうのみにせず、試合中に未知のタイル・通らないコマンド・得点のずれに注意するようメモに書け。`
    : official.version
      ? `公式のバージョン: ${official.version}（記録と一致）`
      : `公式のバージョンを確認できなかった（${official.error ?? "不明"}）`;
  const res = await session.ask(
    [
      "[PREP] 試合開始前の準備フェーズ。資料を読み、試合開始時のメモを作れ。",
      `ルーム: ${room} / ルームの最高得点: ${profile.highScore ?? "なし"} / Webマップ: ${profile.webMapAvailable ?? "不明"} / 1試合の全ターン数: ${knownTotalTurns(room) ?? "不明"}`,
      officialLine,
      "",
      "## ルームの情報（var/room-profiles.json）",
      JSON.stringify({ room: profile.room, highScore: profile.highScore, matchesPlayed: profile.matchesPlayed, webMapAvailable: profile.webMapAvailable, mapDimensions: profile.mapDimensions, discoveredTiles: profile.discoveredTiles, warpLinks: profile.warpLinks.length, tacticalNotes: profile.tacticalNotes }),
      "",
      "## このルームの過去の試合（新しい順）",
      pastRuns.length > 0 ? pastRuns.join("\n") : "(まだない。初めてのルーム)",
      "",
      policy || "(ユーザー定義の作戦方針なし)",
    ].join("\n"),
    timeoutSec * 1000,
  );
  let memo = "";
  if (res.status === "ok") {
    await session.stop();
    memo = parsePrepMemo(res.text).slice(0, memoMax);
  } else {
    session.kill();
  }
  return {
    status: res.status,
    error: res.status === "ok" ? null : res.status === "dead" ? res.error : res.status,
    memo,
    usage: session.usage,
    durationMs: Date.now() - t0,
    official,
  };
}

/** 手の行き先が罠・通行不可なら、その説明（観測済みのマスだけで判定。未観測は危険としない） */
export function landingDanger(worldMap: WorldMap, command: string): string | null {
  const spec = (CMD1_SPECS as Record<string, { move: [number, number] }>)[command] ?? (CMD2_SPECS as Record<string, { move: [number, number] }>)[command];
  if (!spec || (spec.move[0] === 0 && spec.move[1] === 0)) return null;
  const [x, y] = worldMap.getPosition();
  const tile = worldMap.getTile(x + spec.move[0], y + spec.move[1]);
  if (!tile) return null;
  const safety = classifyTileSafety(tile.value);
  if (safety === "HAZARD") return `罠(${tile.value})`;
  if (safety === "BLOCKED") return tile.value >= 1000 ? `他プレイヤー(${tile.value})` : `通行不可(${tile.value})`;
  return null;
}

/** 準備フェーズの返答から最初のメモを取り出す（最後の JSON 行の memo。無ければ本文全体） */
export function parsePrepMemo(text: string): string {
  const lines = text.split("\n").map((l) => l.trim().replace(/^```(?:json)?|```$/g, "").trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.startsWith("{") || !l.endsWith("}")) continue;
    try {
      const obj = JSON.parse(l) as { memo?: unknown };
      if (typeof obj.memo === "string" && obj.memo.trim()) return obj.memo.trim();
    } catch {
      // 次の行へ
    }
  }
  return text.trim();
}

export function parseMainReply(
  text: string,
  turn: number,
  phase: string,
  legal: readonly string[],
): MainReply | null {
  // 最後の行から JSON を探す（memo に { } が入っていても読めるよう、まず行全体を JSON として読む）
  // 後ろから試すので、行全体の候補を最後に置いて優先する
  const candidates = [
    ...[...text.matchAll(/\{[^{}]*"action"\s*:\s*"[^"]+"[^{}]*\}/g)].map((m) => m[0]),
    ...text.split("\n").map((l) => l.trim().replace(/^```(?:json)?|```$/g, "").trim()).filter((l) => l.startsWith("{") && l.endsWith("}")),
  ];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!) as {
        turn?: number; phase?: string; action?: string; command?: string;
        target?: unknown; note?: string; delegate?: string; memo?: unknown; memo_add?: unknown;
      };
      if (obj.turn !== undefined && obj.turn !== turn) continue;
      if (obj.phase !== undefined && obj.phase !== phase) continue;
      const delegate = typeof obj.delegate === "string" && obj.delegate.trim() ? obj.delegate.trim() : undefined;
      const note = typeof obj.note === "string" ? obj.note : undefined;
      const memo = typeof obj.memo === "string" ? obj.memo : undefined;
      const memoAdd = typeof obj.memo_add === "string" && obj.memo_add.trim() ? obj.memo_add : undefined;
      if (obj.action === "continue") return { action: "continue", note, delegate, memo, memoAdd };
      if (obj.action === "command" && obj.command && legal.includes(obj.command)) {
        return { action: "command", command: obj.command, note, delegate, memo, memoAdd };
      }
      if (
        obj.action === "plan" &&
        Array.isArray(obj.target) &&
        obj.target.length === 2 &&
        obj.target.every((v) => Number.isInteger(v))
      ) {
        return { action: "plan", target: [obj.target[0] as number, obj.target[1] as number], note, delegate, memo, memoAdd };
      }
    } catch {
      // 次の候補へ
    }
  }
  return null;
}
