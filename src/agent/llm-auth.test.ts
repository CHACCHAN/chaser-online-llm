import { describe, expect, test } from "bun:test";
import { applyLlmAuthEnv, parseHeaders, resolveLlmAuth } from "./llm-auth";

const K = "k-123";
const api = (headers: string, extra: { url?: string; key?: string } = {}) => resolveLlmAuth({ mode: "api", key: K, url: "", headers, ...extra });

describe("LLM_AUTH_MODE=api: ヘッダは LLM_API_HEADERS のとおり", () => {
  test("既定（x-api-key: {KEY}）は Anthropic API と同じ。Bearer・他のヘッダには載せない", () => {
    const a = api("x-api-key: {KEY}");
    expect(a.problem).toBeNull();
    expect(a.headers).toEqual({ "x-api-key": K });
    expect(a.claudeEnv).toEqual({ ANTHROPIC_API_KEY: K });
    expect(a.baseUrl).toBeNull();
  });

  test("Authorization: Bearer は ANTHROPIC_AUTH_TOKEN、他は ANTHROPIC_CUSTOM_HEADERS に入る（Gravitee の以前の送り方も書ける）", () => {
    const a = api("x-api-key: {KEY}; Authorization: Bearer {KEY}; X-Gravitee-Api-Key: {KEY}", { url: "https://gw.example/v1/" });
    expect(a.headers).toEqual({ "x-api-key": K, Authorization: `Bearer ${K}`, "X-Gravitee-Api-Key": K });
    expect(a.claudeEnv).toEqual({ ANTHROPIC_API_KEY: K, ANTHROPIC_AUTH_TOKEN: K, ANTHROPIC_CUSTOM_HEADERS: `X-Gravitee-Api-Key: ${K}` });
    expect(a.baseUrl).toBe("https://gw.example");
  });

  test("独自のヘッダだけの時は鍵をそのヘッダだけに載せ、Claude Code にはダミーを渡す", () => {
    const a = api("Ocp-Apim-Subscription-Key: {KEY}\nX-Tenant: t1");
    expect(a.headers).toEqual({ "Ocp-Apim-Subscription-Key": K, "X-Tenant": "t1" });
    expect(a.claudeEnv.ANTHROPIC_CUSTOM_HEADERS).toBe(`Ocp-Apim-Subscription-Key: ${K}\nX-Tenant: t1`);
    expect(a.claudeEnv.ANTHROPIC_AUTH_TOKEN).not.toBe(K);
    expect(a.claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("書き方の誤り・鍵なし・知らない方式は problem に出す", () => {
    expect(api("bad header: x").problem).toContain("LLM_API_HEADERS");
    expect(resolveLlmAuth({ mode: "oauth" }).problem).toContain("LLM_AUTH_MODE=oauth");
    expect(parseHeaders("A: b:c").headers).toEqual([["A", "b:c"]]);
  });
});

test("鍵が無い（ローカル LLM など）なら {KEY} を使うヘッダは送らず、エラーにもしない", () => {
  const a = api("x-api-key: {KEY}; X-Local: 1", { key: "", url: "http://localhost:11434" });
  expect(a.problem).toBeNull();
  expect(a.headers).toEqual({ "X-Local": "1" });
  expect(a.claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
  expect(a.claudeEnv.ANTHROPIC_AUTH_TOKEN).toBeDefined(); // Claude Code がログインを求めないためのダミー
  expect(a.claudeEnv.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Local: 1");
  expect(a.baseUrl).toBe("http://localhost:11434");
});

describe("LLM_AUTH_MODE=subscription", () => {
  test("トークンは CLAUDE_CODE_OAUTH_TOKEN に渡し、API の鍵・URL は渡さない", () => {
    const a = resolveLlmAuth({ mode: "subscription", oauthToken: "tok" });
    expect(a.claudeEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    const env = applyLlmAuthEnv({ ANTHROPIC_API_KEY: "shell", ANTHROPIC_BASE_URL: "https://x", PATH: "/bin" }, a);
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok", PATH: "/bin" });
  });

  test("トークンが空ならログインした情報を使う（何も渡さない）", () => {
    expect(resolveLlmAuth({ mode: "subscription", oauthToken: "" }).claudeEnv).toEqual({});
  });
});

describe("コンテキストの大きさ・自動コンパクト", async () => {
  const { llmLimitsEnv, parseTokenCount } = await import("./claude-env");
  test("トークン数の書き方", () => {
    expect(parseTokenCount("32768")).toBe(32768);
    expect(parseTokenCount("128k")).toBe(128000);
    expect(parseTokenCount("1M")).toBe(1_000_000);
    expect(parseTokenCount("abc")).toBeNull();
  });
  test("設定を Claude Code の環境変数にする。不正な値は渡さずエラーにする", () => {
    const vals: Record<string, string> = { LLM_CONTEXT_WINDOW: "32k", LLM_AUTO_COMPACT_PCT: "70", LLM_MAX_OUTPUT_TOKENS: "4096" };
    expect(llmLimitsEnv((k) => vals[k], true)).toEqual({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "32000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096" },
      errors: [],
    });
    expect(llmLimitsEnv(() => undefined, false)).toEqual({ env: { DISABLE_AUTO_COMPACT: "1" }, errors: [] });
    const bad = llmLimitsEnv((k) => ({ LLM_CONTEXT_WINDOW: "big", LLM_AUTO_COMPACT_PCT: "150" })[k as string], true);
    expect(bad.env).toEqual({});
    expect(bad.errors.length).toBe(2);
  });
});
