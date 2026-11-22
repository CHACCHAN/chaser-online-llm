import { parseArgs } from "node:util";
import { boolSetting, getNumberSetting, getSetting, numSetting, type SettingKey } from "./settings";

export interface AgentConfig {
  room: number;
  /** メインエージェントのモデル */
  model: string | undefined;
  /** サブエージェントのモデル（未指定ならメインと同じ） */
  /** Claude Code の effort (low/medium/high/xhigh/max) */
  effort: string | undefined;
  /** サブエージェントの effort（未指定ならメインと同じ） */
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

/**
 * 設定の解決順は CLI 引数 > .env > src/settings.ts の既定値。
 * 既定値・説明は src/settings.ts にだけ書く（ここには書かない）。
 */
export function loadAgentConfig(argv: string[] = Bun.argv.slice(2)): AgentConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      room: { type: "string" },
      "max-turns": { type: "string" },
      "max-matches": { type: "string" },
      "retry-ms": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "turn-budget": { type: "string" },
      "solver-only": { type: "boolean" },
      "web-map-url": { type: "string" },
      port: { type: "string" },
    },
    strict: false,
  });

  const cli = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const str = (flag: string, key: SettingKey) => cli(flag) ?? getSetting(key);
  const num = (flag: string, key: SettingKey, opts: { min?: number; integer?: boolean }) => {
    const raw = cli(flag);
    if (raw === undefined) return getNumberSetting(key, opts) ?? null;
    const n = Number(raw);
    if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) || (opts.min !== undefined && n < opts.min)) {
      throw new Error(`Invalid --${flag}: ${raw}`);
    }
    return n;
  };
  const required = (v: number | null, key: SettingKey) => {
    if (v === null) throw new Error(`設定 ${key} が未設定です`);
    return v;
  };

  return {
    room: required(num("room", "CHASER_ROOM", { min: 1, integer: true }), "CHASER_ROOM"),
    model: cli("model") ?? getSetting("LLM_MODEL_NAME") ?? Bun.env.LLM_MODEL,
    effort: str("effort", "LLM_MODEL_EFFORT"),
    turnBudgetSec: required(num("turn-budget", "AGENT_TURN_BUDGET_SEC", { min: 3 }), "AGENT_TURN_BUDGET_SEC"),
    useMainAgent: values["solver-only"] === true ? false : boolSetting("AGENT_USE_MAIN"),
    retryMs: required(num("retry-ms", "CHASER_RETRY_MS", { min: 50 }), "CHASER_RETRY_MS"),
    maxTurns: num("max-turns", "CHASER_MAX_TURNS", { min: 1, integer: true }),
    maxMatches: num("max-matches", "CHASER_MAX_MATCHES", { min: 1, integer: true }),
    webMapUrl: str("web-map-url", "CHASER_WEB_MAP_URL"),
    port: required(num("port", "PORT", { min: 1, integer: true }), "PORT"),
  };
}

/** Web マップを取り直すタイミング */
export function webMapRefreshMode(): "every_turn" | "warp" | "off" {
  const v = getSetting("CHASER_WEB_MAP_REFRESH");
  return v === "warp" || v === "off" ? v : "every_turn";
}

export { numSetting };
