import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS, type SettingGroup } from "../settings";

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

export interface EnvEntry {
  key: string;
  value: string;
  group: SettingGroup;
  secret: boolean;
  description: string;
}

/** 既知の設定は src/settings.ts から生成する（説明・既定値の二重管理をしない） */
const KNOWN_ENV_META: Record<string, { group: SettingGroup; secret: boolean; description: string; defaultValue: string }> =
  Object.fromEntries(
    Object.entries(SETTINGS).map(([k, d]) => [k, { group: d.group, secret: "secret" in d && d.secret === true, description: d.description, defaultValue: d.defaultValue }]),
  );

function unquoteEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatEnvValue(val: string): string {
  if (/[\s#"']/.test(val)) {
    return JSON.stringify(val);
  }
  return val;
}

export function parseDotEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = unquoteEnvValue(line.slice(eqIdx + 1));
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      map.set(key, val);
    }
  }
  return map;
}

export function loadProjectEnvEntries(): EnvEntry[] {
  const fileMap = existsSync(ENV_PATH)
    ? parseDotEnv(readFileSync(ENV_PATH, "utf-8"))
    : new Map<string, string>();

  const entries: EnvEntry[] = [];
  const seen = new Set<string>();

  for (const [key, meta] of Object.entries(KNOWN_ENV_META)) {
    seen.add(key);
    const val = fileMap.has(key)
      ? (fileMap.get(key) ?? "")
      : (Bun.env[key] ?? meta.defaultValue);
    entries.push({
      key,
      value: val,
      group: meta.group,
      secret: meta.secret,
      description: meta.description,
    });
  }

  for (const [key, val] of fileMap.entries()) {
    if (seen.has(key)) continue;
    entries.push({
      key,
      value: val,
      group: "other",
      secret: /KEY|PASS|SECRET|TOKEN/i.test(key),
      description: "カスタム環境変数",
    });
  }

  return entries;
}

/** .env の1項目だけを書き換える（他の行・コメントはそのまま）。実行中の Bun.env にも即時反映 */
export function setProjectEnvValue(key: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid key: ${key}`);
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8").split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  const line = `${key}=${formatEnvValue(value)}`;
  if (idx >= 0) lines[idx] = line;
  else {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line);
  }
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
  process.env[key] = value;
  Bun.env[key] = value;
}

/**
 * `.env` ファイルへ保存し、同時に現在実行中の `process.env` / `Bun.env` へも即時反映する。
 */
export function saveProjectEnvEntries(
  inputs: Array<{ key: string; value: string }>,
): { updatedKeys: string[] } {
  const cleanMap = new Map<string, string>();

  for (const item of inputs) {
    const key = item.key.trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    cleanMap.set(key, String(item.value ?? ""));
  }

  const lines: string[] = [];
  for (const [key, val] of cleanMap.entries()) {
    lines.push(`${key}=${formatEnvValue(val)}`);
    process.env[key] = val;
    Bun.env[key] = val;
  }

  writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");

  return {
    updatedKeys: [...cleanMap.keys()],
  };
}
