import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";
import { parseDotEnv } from "./ui/env-store";

/**
 * 設定は `.env` だけから読む（WebUI の設定画面も `.env` に書く）。
 * Bun は `.env.local` などを `.env` より優先して読むので、古い `.env.local` が残っていると、
 * 設定画面で変えた値が効かない（例: `.env` は subscription なのに `.env.local` の api で動く）。
 * ここで、`.env.local` などから来た値を `.env` の値に戻す。シェルで渡した値（`HOST_URL=… bun …`）はそのまま。
 * 起動の入口（index.ts・play.ts・cli.ts）の最初に読み込む。
 */
const SHADOW_FILES = [".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

export function preferProjectDotEnv(root = PROJECT_ROOT, env: Record<string, string | undefined> = Bun.env): { file: string; keys: string[] }[] {
  if (env.NODE_ENV === "test" && env === Bun.env) return [];
  const main = path.join(root, ".env");
  if (!existsSync(main)) return [];
  const base = parseDotEnv(readFileSync(main, "utf-8"));
  const fixed: { file: string; keys: string[] }[] = [];
  for (const name of SHADOW_FILES) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const keys: string[] = [];
    for (const [key, val] of parseDotEnv(readFileSync(file, "utf-8"))) {
      if (!base.has(key) || env[key] !== val || base.get(key) === val) continue;
      env[key] = base.get(key)!;
      if (env === Bun.env) process.env[key] = base.get(key)!;
      keys.push(key);
    }
    if (keys.length) fixed.push({ file: name, keys });
  }
  return fixed;
}

const fixed = preferProjectDotEnv();
for (const f of fixed) console.warn(`${f.file} の ${f.keys.join(", ")} は使わず、.env の値を使います（設定は .env だけ。${f.file} は消してかまいません）`);
