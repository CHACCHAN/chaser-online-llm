import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CMD1_COMMANDS, CMD2_COMMANDS, type WorldMap } from "../memory/world-map";
import { AGENT_DIR, VAR_DIR } from "../paths";
import type { SolverDecision } from "../solver/active-solver";
import type { ClaudeModelSettings } from "./claude-env";
import { type AskResult, ClaudeSession } from "./claude-session";

export const CURRENT_SNAPSHOT_PATH = path.join(VAR_DIR, "current/snapshot.json");

export interface MainDecision {
  decision: SolverDecision;
  /** main = メインエージェントが決定 / solver = 時間切れ・多忙・不正応答でソルバー手を採用 */
  source: "main" | "solver";
  durationMs: number | null;
  note: string;
}

interface SkippedTurn {
  turn: number;
  phase: "CMD1" | "CMD2";
  command: string;
  why: string;
}

function readPrompt(name: string): string {
  return readFileSync(path.join(AGENT_DIR, "prompts", name), "utf-8");
}

/**
 * 試合中に常駐し、毎ターン「観測 + ソルバー候補」を受けて手を決めるメインエージェント。
 * 汎用サブエージェント `sub` は Claude Code の Agent ツール経由でメインが自分で呼ぶ。
 */
export class MainAgent {
  private readonly session: ClaudeSession;
  private skipped: SkippedTurn[] = [];

  constructor(
    settings: ClaudeModelSettings,
    private readonly turnBudgetMs: number,
  ) {
    this.session = new ClaudeSession({
      ...settings,
      context: "in_game",
      appendSystemPrompt: readPrompt("main.md"),
      agents: {
        sub: {
          description: "汎用サブエージェント。ログ分析・タイル調査・公式サイト調査・素材収集・agent/tools のツール作成を任せる。",
          prompt: readPrompt("sub.md"),
          model: "haiku", // claude-env で ANTHROPIC_DEFAULT_HAIKU_MODEL を選択中のサブモデルに差し替え済み
        },
      },
    });
  }

  get alive(): boolean {
    return this.session.alive;
  }

  /** 試合開始時: セッションを起動し、ルーム情報を渡して準備させる */
  async begin(info: { room: number; stageName: string | null; webMap: boolean; highScore: number }): Promise<AskResult> {
    this.session.start();
    this.skipped = [];
    return this.session.ask(
      [
        `[MATCH START] room=${info.room} stage=${info.stageName ?? "unknown"} webMap=${info.webMap} roomHighScore=${info.highScore}`,
        "knowledge/strategy.md と knowledge/tiles.json に目を通して準備し、準備できたら「READY」とだけ返答せよ。",
      ].join("\n"),
      90_000,
    );
  }

  async decide(ctx: {
    turn: number;
    phase: "CMD1" | "CMD2";
    worldMap: WorldMap;
    solver: SolverDecision;
    events: string[];
  }): Promise<MainDecision> {
    const fallback = (why: string, durationMs: number | null): MainDecision => {
      this.skipped.push({ turn: ctx.turn, phase: ctx.phase, command: ctx.solver.command, why });
      return { decision: ctx.solver, source: "solver", durationMs, note: why };
    };

    if (!this.session.alive) return fallback("main agent not running", null);
    if (this.session.busy) return fallback("main agent busy (前の調査を継続中)", null);

    await this.writeSnapshot(ctx.worldMap);
    const legal = ctx.phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const res = await this.session.ask(this.buildTurnMessage(ctx, legal), this.turnBudgetMs);

    if (res.status === "timeout") return fallback(`timeout ${res.durationMs}ms`, res.durationMs);
    if (res.status !== "ok") return fallback(res.status === "dead" ? res.error : res.status, null);

    const parsed = parseDecision(res.text, ctx.turn, ctx.phase, legal);
    if (!parsed) return fallback("応答に有効な JSON がない", res.durationMs);

    this.skipped = [];
    return {
      decision: { command: parsed.command as SolverDecision["command"], reason: parsed.reason, confidence: 1 },
      source: "main",
      durationMs: res.durationMs,
      note: parsed.command === ctx.solver.command ? "ソルバー手を承認" : `ソルバー手 ${ctx.solver.command} を変更`,
    };
  }

  /** 試合後: 同じセッション (試合の文脈を保持) で振り返り・ソルバー改修を行わせる */
  async postMatch(diagnosisMarkdown: string, runDir: string, timeoutMs: number): Promise<AskResult> {
    if (!this.session.alive) return { status: "dead", error: "main agent not running" };
    // 試合中の調査が残っていれば終わるまで待つ（最大 timeoutMs）
    const waitUntil = Date.now() + timeoutMs;
    while (this.session.busy && Date.now() < waitUntil) await Bun.sleep(1000);
    return this.session.ask(
      [
        "[POST-MATCH] 試合が終わった。以下の診断と、この試合で自分が見た盤面の記憶をもとに改善せよ。",
        "",
        diagnosisMarkdown,
        "",
        "## やること",
        "1. 失点原因を特定する（必要なら sub に turns.jsonl の分析を任せる）。",
        "2. `src/solver/active-solver.ts` を改修する（`decideTurnAction(worldMap, phase, turn)` のシグネチャは維持）。",
        "3. 判明したタイル得点・ルールは knowledge/ に、再利用できる処理は agent/tools/ に残す。",
        `4. \`bun src/cli.ts verify --run-dir ${runDir}\` と \`bun run typecheck\` が通るまで直す。`,
        "5. 最後に、何を変えたかを3行以内で報告する。",
      ].join("\n"),
      timeoutMs,
    );
  }

  async end(): Promise<void> {
    await this.session.stop();
  }

  private async writeSnapshot(worldMap: WorldMap): Promise<void> {
    mkdirSync(path.dirname(CURRENT_SNAPSHOT_PATH), { recursive: true });
    await Bun.write(CURRENT_SNAPSHOT_PATH, JSON.stringify(worldMap.toSnapshot()));
  }

  private buildTurnMessage(
    ctx: { turn: number; phase: "CMD1" | "CMD2"; worldMap: WorldMap; solver: SolverDecision; events: string[] },
    legal: readonly string[],
  ): string {
    const ev = ctx.worldMap.evaluateCandidates(ctx.phase);
    const stats = ctx.worldMap.getStats();
    const cands = [...ev.candidates]
      .filter((c) => c.safety !== "HAZARD" && c.safety !== "BLOCKED")
      .sort((a, b) => b.estimatedNetImmediate - a.estimatedNetImmediate)
      .slice(0, 6)
      .map((c) => `${c.command}(${c.estimatedNetImmediate}${c.note ? `,${c.note}` : ""})`)
      .join(" ");
    const target = ev.topValueTargets[0];
    const frontier = ev.nearestFrontiers[0];
    const lines = [
      `[TURN ${ctx.turn} / ${ctx.phase}] budget=${Math.round(this.turnBudgetMs / 1000)}s`,
      `pos=${JSON.stringify(ev.position)} global=${JSON.stringify(ev.globalPosition)} est=${stats.estimatedTotalScore} (action ${stats.estimatedActionScore}, item ${stats.estimatedItemScore}) holeRevisits=${stats.holeRevisits}`,
      "map (@=自分, ?=未知):",
      ctx.worldMap.renderAscii(5),
      `solver推奨: ${ctx.solver.command} — ${ctx.solver.reason}`,
      `候補(即時得点): ${cands}`,
      target ? `高得点目標: ${target.tileLabel}@[${target.x},${target.y}] 距離${target.distance} 純益${target.estimatedNetGain} 初手${target.firstStep}` : "高得点目標: なし",
      frontier ? `最寄り未探索: 距離${frontier.distance} 初手${frontier.firstStep}` : "最寄り未探索: なし",
    ];
    if (ctx.events.length > 0) lines.push(`イベント: ${ctx.events.join(", ")}`);
    if (this.skipped.length > 0) {
      lines.push(
        `前回の返答以降にソルバーが打った手: ${this.skipped
          .slice(-10)
          .map((s) => `T${s.turn}${s.phase}=${s.command}(${s.why})`)
          .join(" ")}`,
      );
    }
    lines.push(`合法手: ${legal.join(",")}`);
    return lines.join("\n");
  }
}

export function parseDecision(
  text: string,
  turn: number,
  phase: string,
  legal: readonly string[],
): { command: string; reason: string } | null {
  const matches = [...text.matchAll(/\{[^{}]*"command"\s*:\s*"[^"]+"[^{}]*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]![0]) as { turn?: number; phase?: string; command?: string; reason?: string };
      if (!obj.command || !legal.includes(obj.command)) continue;
      if (obj.turn !== undefined && obj.turn !== turn) continue;
      if (obj.phase !== undefined && obj.phase !== phase) continue;
      return { command: obj.command, reason: obj.reason ?? "" };
    } catch {
      // 次の候補へ
    }
  }
  return null;
}
