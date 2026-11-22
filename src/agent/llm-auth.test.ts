import { describe, expect, test } from "bun:test";
import { parseExtraHeaders, resolveLlmAuth } from "./llm-auth";

const K = "k-123";
describe("LLM_API_AUTH: 鍵の送り方", () => {
  test("gravitee（既定）は以前と同じ: x-api-key・Bearer・X-Gravitee-Api-Key", () => {
    const a = resolveLlmAuth({ mode: "gravitee", key: K, keyHeader: "", extraHeaders: "" });
    expect(a.problem).toBeNull();
    expect(a.headers).toEqual({ Authorization: `Bearer ${K}`, "x-api-key": K, "X-Gravitee-Api-Key": K });
    expect(a.claudeEnv).toEqual({ ANTHROPIC_API_KEY: K, ANTHROPIC_AUTH_TOKEN: K, ANTHROPIC_CUSTOM_HEADERS: `X-Gravitee-Api-Key: ${K}` });
  });

  test("x-api-key は x-api-key だけ（Bearer・Gravitee のヘッダに鍵を載せない）", () => {
    const a = resolveLlmAuth({ mode: "x-api-key", key: K, keyHeader: "", extraHeaders: "" });
    expect(a.headers).toEqual({ "x-api-key": K });
    expect(a.claudeEnv).toEqual({ ANTHROPIC_API_KEY: K, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_CUSTOM_HEADERS: null });
  });

  test("bearer は Authorization だけ", () => {
    const a = resolveLlmAuth({ mode: "bearer", key: K, keyHeader: "", extraHeaders: "" });
    expect(a.headers).toEqual({ Authorization: `Bearer ${K}` });
    expect(a.claudeEnv.ANTHROPIC_AUTH_TOKEN).toBe(K);
    expect(a.claudeEnv.ANTHROPIC_API_KEY).toBeNull();
  });

  test("header は指定した名前のヘッダだけに鍵を載せ、Claude Code にはダミーの鍵を渡す", () => {
    const a = resolveLlmAuth({ mode: "header", key: K, keyHeader: "Ocp-Apim-Subscription-Key", extraHeaders: "" });
    expect(a.problem).toBeNull();
    expect(a.headers).toEqual({ "Ocp-Apim-Subscription-Key": K });
    expect(a.claudeEnv.ANTHROPIC_CUSTOM_HEADERS).toBe(`Ocp-Apim-Subscription-Key: ${K}`);
    expect(a.claudeEnv.ANTHROPIC_AUTH_TOKEN).not.toBe(K);
    expect(a.claudeEnv.ANTHROPIC_API_KEY).toBeNull();
    expect(resolveLlmAuth({ mode: "header", key: K, keyHeader: "", extraHeaders: "" }).problem).toContain("LLM_API_KEY_HEADER");
  });

  test("none は鍵を送らない。追加のヘッダはどの方式でも足す", () => {
    const a = resolveLlmAuth({ mode: "none", key: "", keyHeader: "", extraHeaders: "X-Tenant: t1; anthropic-beta: foo" });
    expect(a.problem).toBeNull();
    expect(a.headers).toEqual({ "X-Tenant": "t1", "anthropic-beta": "foo" });
    expect(a.claudeEnv.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Tenant: t1\nanthropic-beta: foo");
    const b = resolveLlmAuth({ mode: "bearer", key: K, keyHeader: "", extraHeaders: "X-Tenant: t1" });
    expect(b.headers).toEqual({ Authorization: `Bearer ${K}`, "X-Tenant": "t1" });
  });

  test("知らない方式・鍵なし・ヘッダの書き方の誤りは problem に出す", () => {
    expect(resolveLlmAuth({ mode: "oauth", key: K, keyHeader: "", extraHeaders: "" }).problem).toContain("LLM_API_AUTH=oauth");
    expect(resolveLlmAuth({ mode: "bearer", key: "", keyHeader: "", extraHeaders: "" }).problem).toContain("LLM_API_KEY");
    expect(parseExtraHeaders("bad header: x; ok: 1").problem).toContain("bad header");
    expect(parseExtraHeaders("A: b:c").headers).toEqual([["A", "b:c"]]);
  });
});
