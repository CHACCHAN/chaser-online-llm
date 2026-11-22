import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeLoginManager } from "./claude-login";

/** `claude auth login` の代わり: URL を出してコードを1行読み、good なら成功 */
const fakeClaude = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1 $2" = "auth login" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
  printf "Paste code here if prompted > "
  read code
  if [ "$code" = "good" ]; then echo "Login successful."; exit 0; fi
  echo "Couldn't log in: That code wasn't accepted."; exit 1
fi
if [ "$1 $2" = "auth status" ]; then echo '{"loggedIn": false, "authMethod": "none"}'; exit 0; fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return new ClaudeLoginManager(bin, () => ({ ...(process.env as Record<string, string>) }));
};

describe("WebUI からの Claude ログイン", () => {
  test("URL を出し、正しいコードでログインできる", async () => {
    const m = fakeClaude();
    const l = await m.start();
    expect(l.state).toBe("waiting_code");
    expect(l.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
    const r = await m.submitCode("good");
    expect(r.state).toBe("done");
    expect(r.error).toBeNull();
  });

  test("間違ったコードは理由を出して失敗にする。始める前のコードは受けない", async () => {
    const m = fakeClaude();
    expect((await m.submitCode("x")).error).toContain("先に");
    await m.start();
    expect((await m.submitCode("a b")).error).toContain("空白");
    const r = await m.submitCode("bad");
    expect(r.state).toBe("failed");
    expect(r.error).toContain("wasn't accepted");
  });

  test("やめると待機に戻る。状態はログインしていない", async () => {
    const m = fakeClaude();
    await m.start();
    m.cancel();
    expect(m.login.state).toBe("idle");
    const st = await m.status();
    expect(st.loggedIn).toBe(false);
  });
});
