import { getSetting } from "../settings";

/**
 * ハーネスが起動する Claude Code の認証（LLM_AUTH_MODE）。
 * - api          : Anthropic 互換の API（LLM_API_URL。空なら Anthropic API に直接）。送るヘッダは LLM_API_HEADERS に
 *                  "名前: 値; 名前: 値" で書き、{KEY} は LLM_API_KEY に置き換える。LLM_API_KEY が空なら {KEY} を使うヘッダは送らない（鍵の無いローカル LLM）。
 *                  `x-api-key` は ANTHROPIC_API_KEY、`Authorization: Bearer …` は ANTHROPIC_AUTH_TOKEN として Claude Code に渡し、
 *                  それ以外は ANTHROPIC_CUSTOM_HEADERS で送る。
 * - subscription : Claude のサブスクリプション。LLM_OAUTH_TOKEN（`claude setup-token` で作る）を CLAUDE_CODE_OAUTH_TOKEN に渡す。
 *                  空なら var/claude-home にログインした情報を使う（`bun run claude-login`）。
 */
export const LLM_AUTH_MODES = ["api", "subscription"] as const;
export type LlmAuthMode = (typeof LLM_AUTH_MODES)[number];

/** サブスクリプションで選べるモデル（Claude Code の別名。ゲートウェイの /models のような一覧は無い） */
export const SUBSCRIPTION_MODELS = ["opus", "sonnet", "haiku"] as const;

/** Claude Code が自分で送る認証ヘッダを含め、親の環境から引き継がない変数 */
const AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
/** 鍵を Claude Code の仕組み（x-api-key・Bearer）で送らない時に入れる値。Claude Code は鍵が無いとログインを求めるため（ゲートウェイは見ない） */
const PLACEHOLDER_KEY = "unused-see-LLM_API_HEADERS";

export interface LlmAuth {
  mode: LlmAuthMode;
  /** 設定の誤り（あれば）。モデル一覧はこれを返して失敗にする */
  problem: string | null;
  /** api: ハーネスが直接呼ぶ時（モデル一覧）のヘッダ */
  headers: Record<string, string>;
  /** Claude Code に渡す認証の環境変数（AUTH_ENV_KEYS は親の環境から消してからこれを入れる） */
  claudeEnv: Record<string, string>;
  /** api: ANTHROPIC_BASE_URL（空なら Anthropic API に直接） */
  baseUrl: string | null;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** "名前: 値; 名前: 値"（改行区切りも可）を読む */
export function parseHeaders(raw: string): { headers: [string, string][]; problem: string | null } {
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
  return { headers, problem: bad.length ? `LLM_API_HEADERS の書き方が不正（"名前: 値; 名前: 値"）: ${bad.join(", ")}` : null };
}

export interface LlmAuthInput {
  mode?: string;
  url?: string;
  key?: string;
  headers?: string;
  oauthToken?: string;
}

export function resolveLlmAuth(input: LlmAuthInput = {}): LlmAuth {
  const rawMode = (input.mode ?? getSetting("LLM_AUTH_MODE") ?? "api").trim().toLowerCase();
  const problems: string[] = [];
  let mode: LlmAuthMode = "api";
  if ((LLM_AUTH_MODES as readonly string[]).includes(rawMode)) mode = rawMode as LlmAuthMode;
  else problems.push(`LLM_AUTH_MODE=${rawMode} は使えない（${LLM_AUTH_MODES.join(" | ")}）`);

  if (mode === "subscription") {
    const token = (input.oauthToken ?? getSetting("LLM_OAUTH_TOKEN") ?? "").trim();
    return { mode, problem: problems.join("。") || null, headers: {}, claudeEnv: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}, baseUrl: null };
  }

  const key = input.key ?? getSetting("LLM_API_KEY") ?? "";
  const rawHeaders = input.headers ?? getSetting("LLM_API_HEADERS") ?? "x-api-key: {KEY}";
  const parsed = parseHeaders(rawHeaders);
  if (parsed.problem) problems.push(parsed.problem);

  const headers: Record<string, string> = {};
  const claudeEnv: Record<string, string> = {};
  const custom: string[] = [];
  for (const [name, template] of parsed.headers) {
    // 鍵が無い（認証の無いローカル LLM など）なら、{KEY} を使うヘッダは送らない
    if (!key && template.includes("{KEY}")) continue;
    const value = template.replaceAll("{KEY}", key);
    headers[name] = value;
    const lower = name.toLowerCase();
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (lower === "x-api-key") claudeEnv.ANTHROPIC_API_KEY = value;
    else if (lower === "authorization" && bearer) claudeEnv.ANTHROPIC_AUTH_TOKEN = bearer[1]!;
    else custom.push(`${name}: ${value}`);
  }
  if (!claudeEnv.ANTHROPIC_API_KEY && !claudeEnv.ANTHROPIC_AUTH_TOKEN) claudeEnv.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_KEY;
  if (custom.length > 0) claudeEnv.ANTHROPIC_CUSTOM_HEADERS = custom.join("\n");
  const url = (input.url ?? getSetting("LLM_API_URL") ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return { mode, problem: problems.join("。") || null, headers, claudeEnv, baseUrl: url || null };
}

/** 親の環境から認証の変数を消し、選んだ方式のものだけを入れた環境を返す */
export function applyLlmAuthEnv(base: Record<string, string>, auth: LlmAuth): Record<string, string> {
  const env = { ...base };
  for (const k of AUTH_ENV_KEYS) delete env[k];
  Object.assign(env, auth.claudeEnv);
  if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl;
  return env;
}
