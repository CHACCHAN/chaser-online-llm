import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CMD1_COMMANDS, CMD2_COMMANDS, type WorldMap } from "../memory/world-map";
import { AGENT_DIR, VAR_DIR } from "../paths";
import { numSetting } from "../settings";
import type { AgentPlan, SolverDecision } from "../solver/active-solver";
import type { ClaudeModelSettings } from "./claude-env";
import { type AskResult, ClaudeSession } from "./claude-session";
import { SubWorker } from "./sub-worker";

export const CURRENT_SNAPSHOT_PATH = path.join(VAR_DIR, "current/snapshot.json");

export type MainAction = "continue" | "plan" | "command";

export interface MainDecision {
  decision: SolverDecision;
  /** main = メインの判断を反映 (continue/plan/command) / solver = 時間切れ・不正応答でソルバー単独 */
  source: "main" | "solver";
  action: MainAction | null;
  durationMs: number | null;
  note: string;
  delegated: string | null;
}

interface MainReply {
  action: MainAction;
  command?: string;
  target?: [number, number];
  note?: string;
  delegate?: string;
}

function readPrompt(name: string): string {
  return readFileSync(path.join(AGENT_DIR, "prompts", name), "utf-8");
}

/**
 * 試合中に常駐する「作戦係＋例外係」のメインエージェント。
 * 毎フェーズ状況を受け取り、continue（今の作戦のまま）/ plan（目標マスを変える）/ command（手を直接指定）で返す。
 * 時間のかかる仕事は delegate でサブ (SubWorker) に投げ、結果は次のターンに届く。メイン自身は待たない。
 */
export class MainAgent {
  private readonly session: ClaudeSession;
  private readonly sub: SubWorker;
  private plan: AgentPlan | null = null;
  private notices: string[] = [];

  constructor(
    settings: ClaudeModelSettings,
    private readonly turnBudgetMs: number,
  ) {
    this.session = new ClaudeSession({
      ...settings,
      context: "in_game",
      label: "main",
      appendSystemPrompt: readPrompt("main.md"),
    });
    this.sub = new SubWorker(settings);
  }

  get alive(): boolean {
    return this.session.alive;
  }

  get currentPlan(): AgentPlan | null {
    return this.plan;
  }

  /** 試合開始時: メインとサブを起動し、ルーム情報を渡して準備させる */
  async begin(info: { room: number; stageName: string | null; webMap: boolean; highScore: number }): Promise<AskResult> {
    this.session.start();
    this.sub.start();
    this.plan = null;
    this.notices = [];
    return this.session.ask(
      [
        `[MATCH START] room=${info.room} stage=${info.stageName ?? "unknown"} webMap=${info.webMap} roomHighScore=${info.highScore}`,
        "knowledge/strategy.md と knowledge/tiles.json に目を通して準備し、準備できたら「READY」とだけ返答せよ。",
      ].join("\n"),
      numSetting("AGENT_WARMUP_TIMEOUT_SEC", { min: 5 }) * 1000,
    );
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

    if (!this.session.alive) return fallback("main agent not running", null);
    if (this.session.busy) return fallback("main agent busy", null);

    await this.writeSnapshot(ctx.worldMap);
    const legal = ctx.phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const res = await this.session.ask(this.buildTurnMessage(ctx, solverNow, legal), this.turnBudgetMs);
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
    if (!this.session.alive) return { status: "dead", error: "main agent not running" };
    const waitUntil = Date.now() + timeoutMs;
    while (this.session.busy && Date.now() < waitUntil) await Bun.sleep(1000);
    const subResults = this.formatSubResults();
    return this.session.ask(
      [
        "[POST-MATCH] 試合が終わった。以下の診断と、この試合で自分が見た盤面・立てた作戦の記憶をもとに改善せよ。",
        "",
        diagnosisMarkdown,
        subResults ? `\n${subResults}` : "",
        "",
        "## やること",
        "1. 失点原因と、作戦（plan）が効いた/効かなかった場面を特定する（必要なら Agent ツールで調査を並行してよい）。",
        "2. `src/solver/active-solver.ts` を改修する（`decideTurnAction(worldMap, phase, turn, plan)` のシグネチャは維持）。",
        "3. 判明したタイル得点・ルールは knowledge/ に残す。試合中に作った臨時ツール（`@temporary`）は、ソルバーへ組み込む／正式ツールにする（`@temporary` を外す）／削除する、のどれかに決める。",
        `4. \`bun src/cli.ts verify --run-dir ${runDir}\` と \`bun run typecheck\` が通るまで直す。`,
        "5. 最後に、何を変えたかを3行以内で報告する。",
      ].join("\n"),
      timeoutMs,
    );
  }

  async end(): Promise<void> {
    await Promise.all([this.session.stop(), this.sub.stop()]);
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
