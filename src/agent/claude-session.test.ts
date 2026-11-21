import { expect, test } from "bun:test";
import { ClaudeSession } from "./claude-session";

test("assistant イベントに usage が無いゲートウェイでも、result の入力量から会話の大きさと使用量を取る", () => {
  const s = new ClaudeSession({ label: "t" }) as unknown as { onStdout(l: string): void; contextSize: number | null; usage: { calls: number; cacheReadTokens: number } };
  s.onStdout(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }));
  s.onStdout(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 3000, cache_read_input_tokens: 80000, output_tokens: 90 } }));
  expect(s.contextSize).toBe(83000);
  expect(s.usage.calls).toBe(1);
  expect(s.usage.cacheReadTokens).toBe(80000);
});

test("API エラーの result は応答として扱わず dead で返す", async () => {
  const s = new ClaudeSession({ label: "t" }) as unknown as {
    onStdout(l: string): void;
    pending: { resolve: (r: unknown) => void; startedAt: number; timedOut: boolean } | null;
    busyFlag: boolean;
  };
  const got = new Promise((resolve) => {
    s.pending = { resolve, startedAt: Date.now(), timedOut: false };
    s.busyFlag = true;
  });
  s.onStdout(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 400 Invalid model name", usage: { input_tokens: 0 } }));
  expect(await got).toEqual({ status: "dead", error: "API Error: 400 Invalid model name" });
});

test("送る直前にプロセスが終わっていても例外にせず dead を返す", async () => {
  const s = new ClaudeSession({ label: "t" }) as unknown as { proc: unknown; ask(t: string, ms: number): Promise<{ status: string }> };
  s.proc = { stdin: { write: () => { throw new Error("EPIPE"); }, flush: () => {} } };
  expect((await s.ask("x", 1000)).status).toBe("dead");
});

test("全セッションに agent/AGENTS.md を渡し、CLAUDE.md は読ませない", async () => {
  const { agentsGuide } = await import("./claude-session");
  const { buildClaudeEnv } = await import("./claude-env");
  const guide = agentsGuide();
  expect(guide).toContain("AGENTS.md");
  const sys = new ClaudeSession({ label: "t", systemPrompt: "SYS" }).buildArgs();
  expect(sys[sys.indexOf("--system-prompt") + 1]).toBe(`SYS\n\n${guide}`);
  const app = new ClaudeSession({ label: "t", appendSystemPrompt: "APP" }).buildArgs();
  expect(app[app.indexOf("--append-system-prompt") + 1]).toBe(`APP\n\n${guide}`);
  expect(buildClaudeEnv({}).CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
});
