import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { noteUserEdit } from "../evolution/edit-guard";
import path from "node:path";
import { POLICIES_DIR } from "../paths";
import { getSetting } from "../settings";

/**
 * ユーザーが書く「作戦方針」（agent/policies/<name>.md）。
 * どれを使うかは .env の AGENT_POLICY（既定 default）。試合ごとに読み直すので、編集は次の試合から効く。
 */
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isValidPolicyName(name: string): boolean {
  return NAME_RE.test(name);
}

export function listPolicies(): string[] {
  if (!existsSync(POLICIES_DIR)) return [];
  return readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter(isValidPolicyName)
    .sort();
}

export function activePolicyName(): string {
  const name = getSetting("AGENT_POLICY") ?? "default";
  return isValidPolicyName(name) ? name : "default";
}

export function readPolicy(name: string): string | null {
  if (!isValidPolicyName(name)) return null;
  const file = path.join(POLICIES_DIR, `${name}.md`);
  return existsSync(file) ? readFileSync(file, "utf-8") : null;
}

export function writePolicy(name: string, text: string): void {
  if (!isValidPolicyName(name)) throw new Error(`方針名は英数字・_・- のみ（40字以内）: ${name}`);
  mkdirSync(POLICIES_DIR, { recursive: true });
  const file = path.join(POLICIES_DIR, `${name}.md`);
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf-8");
  noteUserEdit(file);
}

/** メインエージェントに渡す形（HTML コメントは除く）。方針ファイルが無ければ空文字 */
export function activePolicyPrompt(): string {
  const name = activePolicyName();
  const text = readPolicy(name)?.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!text) return "";
  return [
    `## ユーザー定義の作戦方針（${name}）— 最優先で従う`,
    "以下はユーザーが決めた判断の方針。knowledge/ の一般則やソルバーの手と食い違う場合はこちらを優先する。",
    "",
    text,
  ].join("\n");
}
