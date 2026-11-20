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
