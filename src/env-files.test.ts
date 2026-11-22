import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { preferProjectDotEnv } from "./env-files";

test(".env.local から来た値は .env の値に戻し、シェルで渡した値はそのまま", () => {
  const root = mkdtempSync(path.join(tmpdir(), "envfiles-"));
  writeFileSync(path.join(root, ".env"), "LLM_AUTH_MODE=subscription\nHOST_URL=http://a\nPORT=3456\n");
  writeFileSync(path.join(root, ".env.local"), "LLM_AUTH_MODE=api\nHOST_URL=http://old\nLLM_API_URL=http://gw\nPORT=3456\n");
  // Bun が読んだ後の状態: .env.local が勝っている。HOST_URL はシェルで渡した
  const env: Record<string, string | undefined> = { LLM_AUTH_MODE: "api", HOST_URL: "http://shell", LLM_API_URL: "http://gw", PORT: "3456" };
  const fixed = preferProjectDotEnv(root, env);
  expect(env.LLM_AUTH_MODE).toBe("subscription");
  expect(env.HOST_URL).toBe("http://shell");
  expect(env.LLM_API_URL).toBe("http://gw"); // .env に無いものは触らない
  expect(fixed).toEqual([{ file: ".env.local", keys: ["LLM_AUTH_MODE"] }]);
});
