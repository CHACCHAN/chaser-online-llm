import { getSetting } from "../settings";

/**
 * LLM のゲートウェイへの認証の渡し方（LLM_API_AUTH）。
 * - gravitee : x-api-key と Authorization: Bearer に加えて X-Gravitee-Api-Key ヘッダにも鍵を載せる（以前からの動作・既定）
 * - x-api-key: x-api-key ヘッダだけ（Anthropic API に直接・x-api-key で受けるゲートウェイ）
 * - bearer   : Authorization: Bearer だけ（LiteLLM・OpenRouter など多くのゲートウェイ）
 * - header   : LLM_API_KEY_HEADER で指定した名前のヘッダだけに鍵を載せる（Azure API Management の Ocp-Apim-Subscription-Key・Kong の apikey など）
 * - none     : 鍵を送らない（認証の無いローカルのプロキシなど）
 * どの方式でも LLM_API_EXTRA_HEADERS（"名前: 値; 名前: 値"）を足して送る。
 */
export const LLM_AUTH_MODES = ["gravitee", "x-api-key", "bearer", "header", "none"] as const;
export type LlmAuthMode = (typeof LLM_AUTH_MODES)[number];

/** Claude Code は鍵が無いと起動時にログインを求めるので、鍵を Claude Code の仕組みで送らない方式ではこれを入れる（ゲートウェイは見ない値） */
const PLACEHOLDER_TOKEN = "unused-see-LLM_API_AUTH";

export interface LlmAuth {
  mode: LlmAuthMode;
  /** 設定の誤り（あれば）。モデル一覧の取得はこれを返して失敗にする */
  problem: string | null;
  /** ハーネスが直接呼ぶ時（モデル一覧）に付けるヘッダ */
  headers: Record<string, string>;
  /** Claude Code に渡す環境変数（ANTHROPIC_*）。値が null のものは親の環境から消す */
  claudeEnv: Record<string, string | null>;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** "名前: 値; 名前: 値"（改行区切りも可）を読む。名前が不正なものは problem に入れる */
export function parseExtraHeaders(raw: string): { headers: [string, string][]; problem: string | null } {
  const headers: [string, string][] = [];
  const bad: string[] = [];
  for (const part of raw.split(/[;\n]/)) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    const name = i > 0 ? s.slice(0, i).trim() : "";
    if (!name || !HEADER_NAME.test(name)) bad.push(s.slice(0, 20));
    else headers.push([name, s.slice(i + 1).trim()]);
  }
  return { headers, problem: bad.length ? `LLM_API_EXTRA_HEADERS の書き方が不正（"名前: 値; 名前: 値"）: ${bad.join(", ")}` : null };
}

export function resolveLlmAuth(env: { mode?: string; key?: string; keyHeader?: string; extraHeaders?: string } = {}): LlmAuth {
  const rawMode = (env.mode ?? getSetting("LLM_API_AUTH") ?? "gravitee").trim().toLowerCase();
  const key = env.key ?? getSetting("LLM_API_KEY") ?? "";
  const keyHeader = (env.keyHeader ?? getSetting("LLM_API_KEY_HEADER") ?? "").trim();
  const extra = parseExtraHeaders(env.extraHeaders ?? getSetting("LLM_API_EXTRA_HEADERS") ?? "");
  const problems: string[] = [];
  if (extra.problem) problems.push(extra.problem);

  let mode: LlmAuthMode = "gravitee";
  if ((LLM_AUTH_MODES as readonly string[]).includes(rawMode)) mode = rawMode as LlmAuthMode;
  else problems.push(`LLM_API_AUTH=${rawMode} は使えない（${LLM_AUTH_MODES.join(" | ")}）`);
  if (mode === "header" && !HEADER_NAME.test(keyHeader)) problems.push("LLM_API_AUTH=header には LLM_API_KEY_HEADER（鍵を載せるヘッダ名）が必要");
  if (mode !== "none" && !key) problems.push("LLM_API_KEY が未設定");

  const headers: Record<string, string> = {};
  const claudeEnv: Record<string, string | null> = { ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_CUSTOM_HEADERS: null };
  const custom: [string, string][] = [];
  if (key) {
    switch (mode) {
      case "gravitee":
        headers.Authorization = `Bearer ${key}`;
        headers["x-api-key"] = key;
        headers["X-Gravitee-Api-Key"] = key;
        claudeEnv.ANTHROPIC_API_KEY = key;
        claudeEnv.ANTHROPIC_AUTH_TOKEN = key;
        custom.push(["X-Gravitee-Api-Key", key]);
        break;
      case "x-api-key":
        headers["x-api-key"] = key;
        claudeEnv.ANTHROPIC_API_KEY = key;
        break;
      case "bearer":
        headers.Authorization = `Bearer ${key}`;
        claudeEnv.ANTHROPIC_AUTH_TOKEN = key;
        break;
      case "header":
        if (HEADER_NAME.test(keyHeader)) {
          headers[keyHeader] = key;
          custom.push([keyHeader, key]);
        }
        claudeEnv.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_TOKEN;
        break;
      case "none":
        claudeEnv.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_TOKEN;
        break;
    }
  } else {
    claudeEnv.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_TOKEN;
  }
  for (const [n, v] of extra.headers) {
    headers[n] = v;
    custom.push([n, v]);
  }
  if (custom.length > 0) claudeEnv.ANTHROPIC_CUSTOM_HEADERS = custom.map(([n, v]) => `${n}: ${v}`).join("\n");
  return { mode, problem: problems.length ? problems.join("。") : null, headers, claudeEnv };
}
