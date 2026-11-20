import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS } from "./settings";

test(".env.example が src/settings.ts の全項目を含む（bun scripts/gen-env-example.ts で再生成）", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf-8");
  for (const key of Object.keys(SETTINGS)) expect(example).toContain(`\n${key}=`);
});

test("src に既定ホスト URL のハードコードが残っていない（src/settings.ts に一本化）", async () => {
  const glob = new Bun.Glob("src/**/*.ts");
  const offenders: string[] = [];
  for await (const f of glob.scan(".")) {
    if (f.endsWith(".test.ts") || f === "src/settings.ts" || f.endsWith("env.d.ts")) continue;
    const s = readFileSync(f, "utf-8");
    if (/sakura\.ne\.jp/.test(s)) offenders.push(`${f}: ホスト URL`);
  }
  expect(offenders).toEqual([]);
});
