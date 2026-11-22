import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CMD1_COMMANDS, CMD1_SPECS, CMD2_COMMANDS, CMD2_SPECS, type WorldMap } from "../memory/world-map";
import { getRoomProfile, knownTotalTurns, roomCells } from "../memory/knowledge-store";
import { AGENT_DIR, COMMANDS_PATH, CURRENT_SNAPSHOT_PATH, OFFICIAL_RULES_PATH, CURRENT_MEMO_PATH, isRunDirName, RUNS_DIR, STRATEGY_PATH, VAR_DIR } from "../paths";
import { numSetting } from "../settings";
import type { AgentPlan, SolverDecision } from "../solver/types";
import { uiBus } from "../ui/event-bus";
import type { ClaudeModelSettings } from "./claude-env";
import { AGENT_WORK_TOOLS, type AskResult, ClaudeSession } from "./claude-session";
import { activePolicyPrompt } from "./policy";
import { addUsage, emptyUsage, totalTokens, type UsageTotals } from "./usage";
import { checkOfficialVersion, type OfficialVersionCheck } from "../perception/official-check";


export type MainAction = "continue" | "plan";

export interface MainDecision {
  decision: SolverDecision;
  /** main = LLM の返答を反映 (continue/plan) / solver = 時間切れ・不正応答・上限超過で方策だけ */
  source: "main" | "solver";
  action: MainAction | null;
  durationMs: number | null;
  note: string;
  /** 作戦目標があった時、送る手が目標に向かっているか（followed）・目標へ経路が無い（no_route）・ソルバーが別の手を選んだ（other） */
  planStatus?: "followed" | "no_route" | "other";
}

/** 作戦目標に対して、送る手が向かっているか */
function planFollowStatus(worldMap: WorldMap, plan: AgentPlan | null, command: string): MainDecision["planStatus"] {
  if (!plan) return undefined;
  const step = worldMap.firstStepTowards(plan.target[0], plan.target[1]);
  if (step === null) return "no_route";
  if (step === "here") return "followed";
  const spec = (CMD1_SPECS as Record<string, { walkDir?: string }>)[command] ?? (CMD2_SPECS as Record<string, { walkDir?: string }>)[command];
  return spec?.walkDir === step.dir ? "followed" : "other";
}

const PLAN_STATUS_LABEL = { followed: "目標へ向かう手", no_route: "目標へ経路なし→方策の手", other: "方策は目標と別の手" } as const;

/** 試合中のエージェント使用量（UI と summary.json に出す） */
export interface AgentUsageReport {
  /** LLM（毎フェーズの問い合わせ＋試合後の振り返り） */
  main: UsageTotals;
  total: UsageTotals;
  totalTokens: number;
  /** 1試合の上限 (0 = 無制限) */
  limitTokens: number;
  limitReached: boolean;
  /** 直近のメイン問い合わせ1回の入力トークン（キャッシュ込み） */
  lastCallInputTokens: number | null;
  /** main に含まれる、予算切れで止めた問い合わせの見積もり分 */
  estimatedTimeoutTokens: number;
  /** AGENT_HEDGE_SEC で2つ目のプロセスにも送った回数 */
  hedges: number;
}

interface MainReply {
  action: MainAction;
  target?: [number, number];
  note?: string;
  memo?: string;
  /** メモの末尾に1行足す（全文を書き直さずに済む＝出力が短く速い） */
  memoAdd?: string;
  /** メモの行を番号で書き換える（"" で削除）。番号は依頼文に表示した行番号 */
  memoSet?: Record<number, string>;
}

/** 依頼文で付けた行番号（"3| "）をモデルが書き写しても、メモに残さない */
function stripLineNo(text: string): string {
  return text.replace(/^[ \t]*\d+\|[ \t]?/gm, "");
}

function readPrompt(name: string): string {
  return readFileSync(path.join(AGENT_DIR, "prompts", name), "utf-8");
}

/**
 * 試合中の LLM（作戦係）。手は方策（経路探索）が毎フェーズすぐ決め、LLM は裏で盤面を読んで作戦目標（plan）を出す。
 *
 * 毎回 **前の会話を持たない使い捨ての `claude -p`** で問い合わせる（--no-session-persistence, --tools "",
 * --system-prompt で Claude Code 既定のシステムプロンプトとツール定義を外す）。1回あたりのトークンが一定で小さい。
 * 引き継ぐのは、LLM 自身が書くメモ・ハーネスが作る直近の経過・現在の状況だけ。
 * 次の問い合わせ用のプロセスは裏で先に起動しておく。上限を超えた問い合わせは止めて捨てる。
 */
export class MainAgent {
  private started = false;
  private plan: AgentPlan | null = null;
  private notices: string[] = [];
  private matchInfo = "";
  /** このルームの1試合の全ターン数（過去の公式結果から。不明なら null） */
  private totalTurns: number | null = null;
  private room: number | null = null;
  /** 固定のシステムプロンプト（main.md ＋ ルール ＋ 作戦方針 ＋ 戦略知識）。試合中は不変なのでキャッシュも効きやすい */
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
  private hedgeCount = 0;
  /** 前のフェーズの座標系（ワープで変わったら作戦目標・メモの座標が無効になる） */
  private frameVersion: number | null = null;

  constructor(
    private readonly settings: ClaudeModelSettings,
    /** 1回の問い合わせの上限（AGENT_TURN_BUDGET_SEC） */
    private readonly turnBudgetMs: number,
  ) {}

  /** 試合中に全ターン数が分かった時（Webマップの残りターン数から）に呼ぶ。見出しの「残り」に使う */
  setTotalTurns(total: number): void {
    if (total > 0) this.totalTurns = total;
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
    const main = this.postSession ? addUsage(this.mainUsage, this.postSession.usage) : this.mainUsage;
    const total = main;
    const limitTokens = numSetting("AGENT_MATCH_TOKEN_LIMIT", { min: 0 });
    return {
      main: { ...main },
      total: { ...total },
      totalTokens: totalTokens(total),
      limitTokens,
      limitReached: limitTokens > 0 && totalTokens(total) >= limitTokens,
      lastCallInputTokens: this.lastCallInputTokens,
      estimatedTimeoutTokens: this.estimatedTimeoutTokens,
      hedges: this.hedgeCount,
    };
  }

  /**
   * 試合開始（入室前）。最初の問い合わせ用プロセスを用意する（モデル呼び出しはしない）。
   * prepared があれば準備フェーズで作ったメモから始める（準備は「開始」より前に runPrepPhase で済ませておく）。
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
    this.room = info.room;
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
    this.next = this.spawnCall();
    this.publish();
    return { status: "ok", text: "ready", durationMs: 0 };
  }

  /** 裏で考えている問い合わせ */
  private inflight: Promise<void> | null = null;

  get thinking(): boolean {
    return this.inflight !== null;
  }

  /**
   * 毎フェーズ呼ぶ: 座標系の変化・作戦目標への到達を反映する（考え中でも、手は今の作戦で決めるため）。
   */
  syncFrame(worldMap: WorldMap): void {
    this.checkFrameChange(worldMap);
    this.refreshPlanStatus(worldMap);
  }

  /**
   * 手を待たせずに裏で LLM に聞く。考え中なら何もしない（false）。
   * 返答の作戦（plan）・メモは届いた時に反映する。
   * 聞いてから返答までにワープで座標系が変わっていたら、返答の作戦の座標は古いので使わない。
   */
  startBackground(
    ctx: { turn: number; phase: "CMD1" | "CMD2"; worldMap: WorldMap; solve: (plan: AgentPlan | null) => SolverDecision; events: string[] },
    onDone: (r: MainDecision | null, error?: string) => void,
  ): boolean {
    if (this.inflight || !this.started) return false;
    this.syncFrame(ctx.worldMap);
    const solverNow = ctx.solve(this.plan);
    const askedFrame = ctx.worldMap.frameVersion;
    const planBefore = this.plan;
    this.inflight = (async () => {
      try {
        const result = await this.ask(ctx, solverNow);
        if (ctx.worldMap.frameVersion !== askedFrame && this.plan !== planBefore && this.plan) {
          this.notices.push(`T${ctx.turn} ${ctx.phase} の返答の作戦目標 (${this.plan.target.join(",")}) は、考えている間にワープして座標系が変わったので使わなかった`);
          this.plan = null;
        }
        this.remember(ctx, result);
        this.publish();
        onDone(result);
      } catch (err) {
        onDone(null, err instanceof Error ? err.message : String(err));
      } finally {
        this.inflight = null;
      }
    })();
    return true;
  }

  /** 裏の問い合わせが終わるのを待つ（試合の終わり。上限を過ぎたら待たない） */
  async settleBackground(timeoutMs: number): Promise<void> {
    if (!this.inflight) return;
    await Promise.race([this.inflight, Bun.sleep(timeoutMs)]);
  }

  /** 試合後: ツールありの新しいセッションで、メモ・経過・診断をもとに振り返りと評価関数の改修を行わせる */
  async postMatch(diagnosisMarkdown: string, runDir: string, timeoutMs: number, simInfo = ""): Promise<AskResult> {
    this.next?.kill();
    this.next = null;
    const session = new ClaudeSession({
      ...this.settings,
      context: "evolution",
      label: "main",
      tools: AGENT_WORK_TOOLS,
      // main.md は試合中用（ツールなし・毎フェーズ新規）なので渡さない。役割とルールは下の依頼文に書く
      appendSystemPrompt: "あなたは CHaserOnline003 攻略プロジェクトの試合中の LLM（作戦係）。試合後の振り返りと方策の改修を行う。ツールを使ってよい。試合中の役割は agent/prompts/main.md にある。",
    });
    session.start();
    const policy = activePolicyPrompt();
    const res = await session.ask(
      [
        "[POST-MATCH] 試合が終わった。あなたは試合中の LLM（作戦係）として振り返り、改善せよ。この振り返りではツールを使ってよい。",
        `試合: ${this.matchInfo} / ログ: ${runDir}/turns.jsonl（各ターンの手・観測・方策の理由・あなたの返答）, ${runDir}/summary.json, ${runDir}/MEMO.md`,
        "",
        "## 試合中のあなたのメモ（最終）",
        this.memo || "(なし)",
        "",
        "## 直近の経過",
        this.recent.join("\n") || "(なし)",
        "",
        diagnosisMarkdown,
        policy ? `\n${policy}\n\n方策の改修もこの方針に沿わせること。` : "",
        simInfo ? `\n${simInfo}` : "",
        "",
        "## やること",
        "1. ログを読み、失点原因と、作戦（plan）が効いた/効かなかった場面を特定する。",
        "2. 方策を改修する。手を決めたのは方策（経路探索 planner.ts ＋ 評価関数 evaluator.ts ＋ 学習したパラメータ）。",
        "   - `src/solver/evaluator.ts`（マスの価値・通る手間・学習する重み PARAM_SPACE）を直す。探索の仕組み（planner.ts）は変えられない。新しい特徴は PARAM_SPACE に重みを足して使う（学習が値を合わせる）。`bun src/cli.ts bench --room <n> --evaluator <改修前の写し>` で比べられる。改修後はハーネスが、この試合の記録の盤面で確かめ（例外・罠へ動く手が増えていないか）、シミュレータで改修前と比べ、どちらかに落ちたら元に戻す。",
        "   - シミュレータが本物と違う所（地図の作り方 `knowledge/sim-profiles.json`、ルール）に気づいたら、sim-profiles.json を直すか報告に書く。",
        "   編集してよいのは evaluator.ts・knowledge/・agent/tools/ だけ。それ以外（runner.ts・planner.ts 等のハーネス）を変えても自動で元に戻される。ハーネスの改善案は報告に書くこと。",
        "3. 判明したタイル得点・ルールは knowledge/ に残す。",
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
  async reviewHarness(info: { runDir: string; reverted: string[]; evaluatorChanged: boolean; rolledBack: boolean }, timeoutMs: number): Promise<string | null> {
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
        "[HARNESS REVIEW] 振り返りお疲れさま。最後に、あなた（と試合中の毎回のあなた）が使った**ハーネス（このプロジェクトの仕組み）**をレビューしてほしい。開発者が次の開発の参考にする。",
        fresh ? `この試合のログ: ${info.runDir}（turns.jsonl・MEMO.md・evolution-report.md）。試合中のあなたへの指示は agent/prompts/main.md。` : "",
        `改修の結果: ${info.evaluatorChanged ? (info.rolledBack ? "評価関数の改修は確かめに落ちて元に戻された" : "評価関数の改修は採用された") : "評価関数の改修なし"}${info.reverted.length > 0 ? ` / 編集範囲外として元に戻されたファイル: ${info.reverted.join(", ")}` : ""}`,
        "これまでのレビューは agent/REVIEW.md にある（同じ指摘の繰り返しは避け、`[対応済み]` の項目が本当に直ったかも確かめる）。このレビューではファイルを編集しない（読むだけ。編集しても元に戻される）。",
        "",
        "観点（ゲームの作戦ではなく、仕組みについて）:",
        "- 毎回渡される情報（盤面・候補・メモ・直近の経過）に足りないもの・多すぎるもの・分かりにくいもの",
        "- 返答形式・返答の上限時間・メモの上限・方策との役割分担で困ったこと",
        "- ツール・CLI・ログ・ドキュメント（AGENTS.md 等）の使いにくさ、不具合らしき挙動",
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
    });
    if (!this.started) return fallback("main agent not running", null);
    if (this.checkLimit()) return fallback("token limit reached", null);

    await this.writeSnapshot(ctx.worldMap);
    const legal = ctx.phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const { message, shownNotices } = this.buildTurnMessage(ctx, solverNow, legal);

    // 先に起動しておいたプロセスで聞き、すぐ次のフェーズ用を起動する
    // 先に起動したプロセスが待ち時間の間に終わっていたら（他プレイヤー待ちが長い等）新しく起動する
    let call = this.next;
    if (!call?.alive) {
      call?.kill();
      call = this.spawnCall();
    }
    this.next = this.spawnCall();
    const { res, winner, hedged } = await this.askWithHedge(call, message);
    call = winner;
    if (hedged) this.hedgeCount += 1;
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
    // 正常に返答したので、このフェーズで見せた通知を届けたことにする
    this.notices.splice(0, shownNotices);

    this.applyMemo(reply);

    let decision = solverNow;
    let note = "作戦どおり";
    if (reply.action === "plan" && reply.target) {
      this.plan = { target: reply.target, note: reply.note };
      decision = ctx.solve(this.plan);
      const st = planFollowStatus(ctx.worldMap, this.plan, decision.command)!;
      note = `作戦変更 → 目標 (${reply.target.join(",")})：${PLAN_STATUS_LABEL[st]}`;
    }
    const planStatus = planFollowStatus(ctx.worldMap, this.plan, decision.command);
    if (reply.action === "continue" && planStatus) note = `作戦どおり（${PLAN_STATUS_LABEL[planStatus]}）`;
    return {
      decision: { ...decision, reason: `${decision.reason}${reply.note ? ` / ${reply.note}` : ""}` },
      source: "main",
      action: reply.action,
      durationMs: res.durationMs,
      note,
      ...(planStatus ? { planStatus } : {}),
    };
  }

  /** 返答の memo（全文置き換え）・memo_add（末尾に1行）を反映する。上限を超えた時は次のフェーズに知らせる */
  private applyMemo(reply: MainReply): void {
    const max = numSetting("AGENT_MEMO_MAX_CHARS", { min: 100, integer: true });
    if (reply.memo !== undefined) {
      const memo = stripLineNo(reply.memo);
      if (memo.length > max) this.notices.push(`memo が上限 ${max} 字を超えたので、${max} 字で切った`);
      this.memo = memo.slice(0, max);
      if (reply.memoSet) this.notices.push("memo（全文の書き直し）と一緒に来た memo_set は使わなかった");
    } else if (reply.memoSet) {
      const lines = this.memo.split("\n");
      const bad: number[] = [];
      for (const [k, v] of Object.entries(reply.memoSet)) {
        const i = Number(k) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= lines.length) bad.push(Number(k));
        else lines[i] = stripLineNo(v);
      }
      const next = lines.filter((l, i) => !(l.trim() === "" && Object.hasOwn(reply.memoSet!, String(i + 1)))).join("\n");
      if (next.length > max) this.notices.push(`memo_set の結果がメモの上限 ${max} 字を超えるので使わなかった`);
      else this.memo = next;
      if (bad.length > 0) this.notices.push(`memo_set の行番号 ${bad.join(",")} はメモに無い（1〜${lines.length}）`);
    }
    const add = reply.memoAdd ? stripLineNo(reply.memoAdd).trim() : "";
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
    const who = r.source === "main" ? `LLM/${r.action}${r.planStatus && r.planStatus !== "followed" ? ` ${PLAN_STATUS_LABEL[r.planStatus]}` : ""}` : `方策: ${r.note}`;
    this.recent.push(`T${ctx.turn} ${ctx.phase} pos(${x},${y}) est=${est}${delta} → ${r.decision.command} [${who}]`);
    const keep = numSetting("AGENT_RECENT_PHASES", { min: 0, integer: true });
    if (this.recent.length > keep) this.recent.splice(0, this.recent.length - keep);
  }

  /** 上限超過なら true（残りは方策だけ） */
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
        content: `この試合で ${usage.totalTokens.toLocaleString()} トークン使用（上限 ${usage.limitTokens.toLocaleString()}、AGENT_MATCH_TOKEN_LIMIT）。残りは方策だけで続ける`,
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

  /** 試合の記録フォルダへ MEMO.md を残す */
  archiveFiles(runDir: string): void {
    for (const f of [CURRENT_MEMO_PATH]) {
      try {
        if (existsSync(f)) copyFileSync(f, path.join(runDir, path.basename(f)));
      } catch {
        // ignore
      }
    }
  }

/**
   * 近くの既知のワープ・マスのメモ。座標は今の pos と同じ座標系、[ ] は絶対座標（Webマップの列・行）。
   * Webマップで位置合わせできていない時は、この試合で入ったワープ（今の区画）だけ。
   */
  private knownCellLines(worldMap: WorldMap): string[] {
    const off = worldMap.getGlobalOffset();
    const radius = numSetting("AGENT_KNOWN_CELLS_RADIUS", { min: 0, integer: true });
    const lines: string[] = [];
    if (off && this.room !== null) {
      const g = worldMap.getGlobalPosition();
      const cells = roomCells(this.room, g, radius);
      const loc = (p: [number, number]) => `(${p[0] - off[0]},${p[1] - off[1]})[${p[0]},${p[1]}]`;
      if (cells.warps.length > 0) {
        lines.push(`既知のワープ（過去の試合も含む実測）: ${cells.warps.slice(0, 8).map((w) => `${loc(w.from)} ${w.tile >= 0 ? `${w.tile}番` : "ワープ"}→${loc(w.to)} ${w.count}回`).join(" / ")}`);
      }
      if (cells.notes.length > 0) {
        lines.push(`マスのメモ: ${cells.notes.slice(0, 8).map((n) => `${loc([n.x, n.y])} ${n.notes.map((t) => (t.length > 80 ? `${t.slice(0, 80)}…` : t)).join("; ")}`).join(" / ")}`);
      }
      return lines;
    }
    const seg = worldMap.getSegmentIndex();
    const here = worldMap.getWarpLinks().filter((l) => l.fromSegment === seg);
    if (here.length > 0) {
      lines.push(`この試合で入ったワープ（今の区画）: ${here.slice(-8).map((l) => `(${l.fromPos.join(",")}) ${l.tileValue >= 0 ? `${l.tileValue}番` : "ワープ"}→${l.toSegment === seg ? `(${l.toPos.join(",")})` : "別の区画"}`).join(" / ")}`);
    }
    return lines;
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

  /**
   * 1つのプロセスに聞き、AGENT_HEDGE_SEC たっても返らなければ、先に起動しておいたもう1つのプロセスにも同じ問い合わせを送る。
   * 先に正常に返った方を使い、もう一方は止める（ゲートウェイの詰まりで 60 秒の時間切れになり、作戦・メモがまとめて失われていた）
   */
  private async askWithHedge(call: ClaudeSession, message: string): Promise<{ res: AskResult; winner: ClaudeSession; hedged: boolean }> {
    const hedgeMs = numSetting("AGENT_HEDGE_SEC", { min: 0 }) * 1000;
    const first = call.ask(message, this.turnBudgetMs).then((res) => ({ res, s: call }));
    if (hedgeMs <= 0 || hedgeMs >= this.turnBudgetMs - 1000) {
      const r = await first;
      return { res: r.res, winner: r.s, hedged: false };
    }
    const quick = await Promise.race([first, Bun.sleep(hedgeMs).then(() => null)]);
    if (quick) return { res: quick.res, winner: quick.s, hedged: false };
    let second = this.next?.alive ? this.next : this.spawnCall();
    if (second === this.next) this.next = this.spawnCall();
    const t0 = Date.now();
    const other = second.ask(message, this.turnBudgetMs - hedgeMs).then((res) => ({ res, s: second }));
    // 先に「正常に」返った方。片方が異常終了したら、もう一方を待つ
    const pending = [first, other];
    let winnerResult: { res: AskResult; s: ClaudeSession } | null = null;
    while (pending.length > 0) {
      const r = await Promise.race(pending.map((p, i) => p.then((v) => ({ v, i }))));
      pending.splice(r.i, 1);
      if (r.v.res.status === "ok" || pending.length === 0) {
        winnerResult = r.v;
        break;
      }
    }
    const loser = winnerResult!.s === call ? second : call;
    // 負けた方は止める。入力は送信済みなので、直近の入力量で見積もって使用量に含める
    const est = this.lastCallInputTokens ?? 0;
    this.mainUsage = addUsage(this.mainUsage, { ...emptyUsage(), calls: 1, inputTokens: est });
    loser.kill();
    void t0;
    return { res: winnerResult!.res, winner: winnerResult!.s, hedged: true };
  }

  private async writeSnapshot(worldMap: WorldMap): Promise<void> {
    mkdirSync(path.dirname(CURRENT_SNAPSHOT_PATH), { recursive: true });
    await Bun.write(CURRENT_SNAPSHOT_PATH, JSON.stringify(worldMap.toSnapshot()));
  }

  private buildTurnMessage(
    ctx: { turn: number; phase: "CMD1" | "CMD2"; worldMap: WorldMap; events: string[] },
    solverNow: SolverDecision,
    legal: readonly string[],
  ): { message: string; shownNotices: number } {
    const ev = ctx.worldMap.evaluateCandidates(ctx.phase);
    const stats = ctx.worldMap.getStats();
    const targets = [
      ...ev.topValueTargets.slice(0, 4).map((t) => `${t.tileLabel}(${t.x},${t.y}) 距離${t.distance} 純益${t.estimatedNetGain}`),
      ...ev.nearestFrontiers.slice(0, 3).map((t) => `未探索(${t.x},${t.y}) 距離${t.distance}`),
    ];
    const lines = [
      `[TURN ${ctx.turn}${this.totalTurns ? `/${this.totalTurns}（このターンを含め残り${Math.max(0, this.totalTurns - ctx.turn + 1)}）` : ""} / ${ctx.phase}]`,
      `## メモ（前のフェーズまでの自分から。${this.memo.length}/${numSetting("AGENT_MEMO_MAX_CHARS", { min: 100, integer: true })}字）`,
      this.memo ? this.memo.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n") : "(まだない)",
      "## 直近の経過",
      this.recent.join("\n") || "(試合開始)",
      "## 現在の状況",
      `pos=(${ev.position.join(",")}) est=${stats.estimatedTotalScore} (action ${stats.estimatedActionScore}, item ${stats.estimatedItemScore}) holeRevisits=${stats.holeRevisits}`,
      ctx.worldMap.renderAgentMap({
        enemies: ctx.worldMap.getEnemySightings().map((e) => ({ x: e.x, y: e.y, stale: e.lastSeenTurn < ctx.turn })),
        planTarget: this.plan?.target ?? null,
      }),
      `現在の作戦: ${this.plan ? `目標(${this.plan.target.join(",")})${this.plan.note ? ` ${this.plan.note}` : ""}` : "なし（方策が自分で狙いを選ぶ）"}`,
      `方策の今の手: ${solverNow.command} — ${solverNow.reason}`,
      `目標候補: ${targets.join(" / ") || "なし"}`,
      ...this.knownCellLines(ctx.worldMap),
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
    // 通知は、LLM が正常に返答した時に届けたことにする（時間切れなら次の問い合わせにもう一度出す）。溜まりすぎたら古いものから捨てる
    if (this.notices.length > 20) this.notices.splice(0, this.notices.length - 20);
    const shownNotices = this.notices.length;
    if (shownNotices > 0) lines.push(...this.notices);
    if (ctx.worldMap.getLastEventFlags().warpPending && !ctx.worldMap.getGlobalPosition()) {
      lines.push("ワープを踏んだ直後で、着地先のまわりはまだ分からない");
    }
    void legal;
    return { message: lines.join("\n"), shownNotices };
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
  // バージョン確認の間に止められたら、セッションを起こさずに終える（abort の登録は起動の後なので、ここで確かめる）
  if (signal?.aborted) {
    return { status: "dead", error: "中止", memo: "", usage: emptyUsage(), durationMs: Date.now() - t0, official };
  }
  const pastRuns = existsSync(RUNS_DIR)
    ? readdirSync(RUNS_DIR)
        .filter((n) => isRunDirName(n) && n.endsWith(`_room${room}`))
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
  if (signal?.aborted) session.kill();
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
      JSON.stringify({ room: profile.room, highScore: profile.highScore, matchesPlayed: profile.matchesPlayed, webMapAvailable: profile.webMapAvailable, mapDimensions: profile.mapDimensions, discoveredTiles: profile.discoveredTiles, warps: (profile.warps ?? []).length, cellNotes: Object.keys(profile.cellNotes ?? {}).length }),
      (profile.warps ?? []).length > 0 ? `ワープの記録・マスのメモ（絶対座標）は var/room-profiles.json の warps・cellNotes にある` : "",
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

/** memo_set は {"行番号": "新しい内容"}。文字列でない値・番号でないキーは捨てる */
function parseMemoSet(v: unknown): Record<number, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<number, string> = {};
  for (const [k, val] of Object.entries(v)) if (/^\d+$/.test(k) && typeof val === "string") out[Number(k)] = val;
  return Object.keys(out).length > 0 ? out : undefined;
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
        turn?: number; phase?: string; action?: string;
        target?: unknown; note?: string; memo?: unknown; memo_add?: unknown;
      };
      if (obj.turn !== undefined && obj.turn !== turn) continue;
      if (obj.phase !== undefined && obj.phase !== phase) continue;
      const note = typeof obj.note === "string" ? obj.note : undefined;
      const memo = typeof obj.memo === "string" ? obj.memo : undefined;
      // 1行のはずだが、配列で返すモデルもあるので行をつなげて受け取る
      const rawAdd = Array.isArray(obj.memo_add) ? obj.memo_add.filter((v) => typeof v === "string").join("\n") : obj.memo_add;
      const memoAdd = typeof rawAdd === "string" && rawAdd.trim() ? rawAdd : undefined;
      const memoSet = parseMemoSet((obj as { memo_set?: unknown }).memo_set);
      if (obj.action === "continue") return { action: "continue", note, memo, memoAdd, memoSet };
      if (
        obj.action === "plan" &&
        Array.isArray(obj.target) &&
        obj.target.length === 2 &&
        obj.target.every((v) => Number.isInteger(v))
      ) {
        return { action: "plan", target: [obj.target[0] as number, obj.target[1] as number], note, memo, memoAdd, memoSet };
      }
    } catch {
      // 次の候補へ
    }
  }
  return null;
}
