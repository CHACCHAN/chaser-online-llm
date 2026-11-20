import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

export interface EnvEntry {
  key: string;
  value: string;
  group: "chaser" | "llm" | "other";
  secret: boolean;
  description: string;
}

const KNOWN_ENV_META: Record<
  string,
  { group: "chaser" | "llm" | "other"; secret: boolean; description: string; defaultValue: string }
> = {
  HOST_URL: {
    group: "chaser",
    secret: false,
    description: "CHaserOnline ユーザ接続ベースURL",
    defaultValue: "http://www7019ug.sakura.ne.jp/CHaserOnline003/user/",
  },
  CHASER_USER: {
    group: "chaser",
    secret: false,
    description: "CHaserOnline ログインユーザ名",
    defaultValue: "",
  },
  CHASER_PASS: {
    group: "chaser",
    secret: true,
    description: "CHaserOnline ログインパスワード",
    defaultValue: "",
  },
  CHASER_ROOM: {
    group: "chaser",
    secret: false,
    description: "デフォルトのルーム番号",
    defaultValue: "3",
  },
  CHASER_WEB_MAP_URL: {
    group: "chaser",
    secret: false,
    description: "Webマップ明示指定URL（空欄で MapView.jsp を自動探索）",
    defaultValue: "",
  },
  LLM_API_URL: {
    group: "llm",
    secret: false,
    description: "LiteLLM / Gravitee ゲートウェイ URL",
    defaultValue: "",
  },
  LLM_API_KEY: {
    group: "llm",
    secret: true,
    description: "API キー (ANTHROPIC_API_KEY / X-Gravitee-Api-Key として送信)",
    defaultValue: "",
  },
  LLM_MODEL_NAME: {
    group: "llm",
    secret: false,
    description: "メインエージェントのモデル（ゲートウェイの /models から選択）",
    defaultValue: "",
  },
  LLM_SUB_MODEL_NAME: {
    group: "llm",
    secret: false,
    description: "サブエージェントのモデル（空ならメインと同じ）",
    defaultValue: "",
  },
  LLM_MODEL_EFFORT: {
    group: "llm",
    secret: false,
    description: "effort: low | medium | high | xhigh | max",
    defaultValue: "medium",
  },
  LLM_SUB_MODEL_EFFORT: {
    group: "llm",
    secret: false,
    description: "サブエージェントの effort（空ならメインと同じ）",
    defaultValue: "",
  },
  AGENT_TURN_BUDGET_SEC: {
    group: "llm",
    secret: false,
    description: "メインエージェントの1フェーズあたりの思考予算（秒）",
    defaultValue: "20",
  },
};

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatEnvValue(val: string): string {
  if (/[\s#"']/.test(val)) {
    return JSON.stringify(val);
  }
  return val;
}

export function parseDotEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = unquoteEnvValue(line.slice(eqIdx + 1));
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      map.set(key, val);
    }
  }
  return map;
}

export function loadProjectEnvEntries(): EnvEntry[] {
  const fileMap = existsSync(ENV_PATH)
    ? parseDotEnv(readFileSync(ENV_PATH, "utf-8"))
    : new Map<string, string>();

  const entries: EnvEntry[] = [];
  const seen = new Set<string>();

  for (const [key, meta] of Object.entries(KNOWN_ENV_META)) {
    seen.add(key);
    const val = fileMap.has(key)
      ? (fileMap.get(key) ?? "")
      : (Bun.env[key] ?? meta.defaultValue);
    entries.push({
      key,
      value: val,
      group: meta.group,
      secret: meta.secret,
      description: meta.description,
    });
  }

  for (const [key, val] of fileMap.entries()) {
    if (seen.has(key)) continue;
    entries.push({
      key,
      value: val,
      group: "other",
      secret: /KEY|PASS|SECRET|TOKEN/i.test(key),
      description: "カスタム環境変数",
    });
  }

  return entries;
}

/**
 * `.env` ファイルへ保存し、同時に現在実行中の `process.env` / `Bun.env` へも即時反映する。
 */
export function saveProjectEnvEntries(
  inputs: Array<{ key: string; value: string }>,
): { updatedKeys: string[] } {
  const cleanMap = new Map<string, string>();

  for (const item of inputs) {
    const key = item.key.trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    cleanMap.set(key, String(item.value ?? ""));
  }

  const lines: string[] = [];
  for (const [key, val] of cleanMap.entries()) {
    lines.push(`${key}=${formatEnvValue(val)}`);
    process.env[key] = val;
    Bun.env[key] = val;
  }

  writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");

  return {
    updatedKeys: [...cleanMap.keys()],
  };
}
