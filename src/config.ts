import { parseArgs } from "node:util";

export interface AgentConfig {
  room: number;
  /** メインエージェントのモデル */
  model: string | undefined;
  /** サブエージェントのモデル（未指定ならメインと同じ） */
  subModel: string | undefined;
  /** Claude Code の effort (low/medium/high/xhigh/max) */
  effort: string | undefined;
  /** サブエージェントの effort（未指定ならメインと同じ） */
  subEffort: string | undefined;
  /** メインエージェントの1フェーズあたりの思考時間予算（秒）。超えたらソルバー手を送る */
  turnBudgetSec: number;
  /** false ならメインエージェントを使わずソルバーのみでプレイ */
  useMainAgent: boolean;
  retryMs: number;
  maxTurns: number | null;
  maxMatches: number | null;
  webMapUrl: string | undefined;
  port: number;
}

export function loadAgentConfig(argv: string[] = Bun.argv.slice(2)): AgentConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      room: { type: "string" },
      "max-turns": { type: "string" },
      "max-matches": { type: "string" },
      "retry-ms": { type: "string" },
      model: { type: "string" },
      "sub-model": { type: "string" },
      effort: { type: "string" },
      "sub-effort": { type: "string" },
      "turn-budget": { type: "string" },
      "solver-only": { type: "boolean" },
      "web-map-url": { type: "string" },
      port: { type: "string" },
    },
    strict: false,
  });

  const roomRaw = typeof values.room === "string" ? values.room : (Bun.env.CHASER_ROOM ?? "3");
  const room = Number(roomRaw);
  if (!Number.isInteger(room) || room <= 0) {
    throw new Error(`Invalid room number: ${roomRaw}`);
  }

  const model =
    typeof values.model === "string"
      ? values.model
      : (Bun.env.LLM_MODEL_NAME ?? Bun.env.LLM_MODEL);

  const retryRaw = typeof values["retry-ms"] === "string" ? values["retry-ms"] : "250";
  const retryMs = Number(retryRaw);
  if (!Number.isFinite(retryMs) || retryMs < 50) {
    throw new Error(`Invalid --retry-ms: ${retryRaw}`);
  }

  const maxTurnsRaw =
    typeof values["max-turns"] === "string" ? values["max-turns"] : undefined;
  const maxTurns = maxTurnsRaw !== undefined ? Number(maxTurnsRaw) : null;
  if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
    throw new Error(`Invalid --max-turns: ${maxTurnsRaw}`);
  }

  const maxMatchesRaw =
    typeof values["max-matches"] === "string" ? values["max-matches"] : undefined;
  const maxMatches = maxMatchesRaw !== undefined ? Number(maxMatchesRaw) : null;
  if (maxMatches !== null && (!Number.isInteger(maxMatches) || maxMatches <= 0)) {
    throw new Error(`Invalid --max-matches: ${maxMatchesRaw}`);
  }

  const portRaw =
    typeof values.port === "string" ? values.port : (Bun.env.PORT ?? "3456");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port: ${portRaw}`);
  }

  const webMapUrl =
    typeof values["web-map-url"] === "string"
      ? values["web-map-url"]
      : Bun.env.CHASER_WEB_MAP_URL;

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const turnBudgetSec = Number(str(values["turn-budget"]) ?? Bun.env.AGENT_TURN_BUDGET_SEC ?? "20");
  if (!Number.isFinite(turnBudgetSec) || turnBudgetSec < 3) {
    throw new Error(`Invalid --turn-budget: ${turnBudgetSec}`);
  }

  return {
    room,
    model,
    subModel: str(values["sub-model"]) ?? str(Bun.env.LLM_SUB_MODEL_NAME),
    effort: str(values.effort) ?? str(Bun.env.LLM_MODEL_EFFORT),
    subEffort: str(values["sub-effort"]) ?? str(Bun.env.LLM_SUB_MODEL_EFFORT),
    turnBudgetSec,
    useMainAgent: values["solver-only"] !== true,
    retryMs,
    maxTurns,
    maxMatches,
    webMapUrl,
    port,
  };
}
