import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_HOME_DIR, PROJECT_ROOT } from "../paths";
import { boolSetting, getSetting } from "../settings";
import { applyLlmAuthEnv, resolveLlmAuth } from "./llm-auth";

export const CLAUDE_BINARY = path.join(PROJECT_ROOT, "node_modules/.bin/claude");

export interface ClaudeModelSettings {
  /** メインエージェントのモデル (LLM_API_URL の /models から選択) */
  model?: string;
  /** サブエージェントのモデル。未指定ならメインと同じ */
  subModel?: string;
  /** low | medium | high | xhigh | max */
  effort?: string;
  /** サブエージェントの effort。未指定ならメインと同じ */
  subEffort?: string;
}

/** "32768" / "128k" / "1m" をトークン数にする。読めなければ null */
export function parseTokenCount(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * コンテキストの大きさ・自動コンパクト・出力の上限（LLM_CONTEXT_WINDOW 等）を Claude Code の環境変数にする。
 * 書き方が不正なものは渡さず errors に入れる（Claude Code の既定のまま動く）。
 */
export function llmLimitsEnv(get: (k: "LLM_CONTEXT_WINDOW" | "LLM_AUTO_COMPACT_PCT" | "LLM_MAX_OUTPUT_TOKENS") => string | undefined = getSetting, autoCompact = boolSetting("LLM_AUTO_COMPACT")): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  const win = get("LLM_CONTEXT_WINDOW");
  if (win) {
    const n = parseTokenCount(win);
    if (n) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(n);
    else errors.push(`LLM_CONTEXT_WINDOW=${win} はトークン数（例 32768・128k）で書く`);
  }
  const pct = get("LLM_AUTO_COMPACT_PCT");
  if (pct) {
    const n = Number(pct);
    if (Number.isFinite(n) && n >= 1 && n <= 100) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(n);
    else errors.push(`LLM_AUTO_COMPACT_PCT=${pct} は 1〜100`);
  }
  const out = get("LLM_MAX_OUTPUT_TOKENS");
  if (out) {
    const n = parseTokenCount(out);
    if (n) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(n);
    else errors.push(`LLM_MAX_OUTPUT_TOKENS=${out} はトークン数で書く`);
  }
  if (!autoCompact) env.DISABLE_AUTO_COMPACT = "1";
  return { env, errors };
}

/**
 * ホストの ~/.claude を一切使わないよう、HOME と CLAUDE_CONFIG_DIR を var/claude-home に隔離した env を作る。
 * Claude Code は「ハーネス」として使うだけなので、ゲートウェイ (LLM_API_URL) とモデルはここで全て指定する。
 */
export function buildClaudeEnv(settings: ClaudeModelSettings): Record<string, string> {
  const home = CLAUDE_HOME_DIR;
  const configDir = path.join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(home, ".cache"), { recursive: true });

  const onboarding = JSON.stringify(
    {
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { [PROJECT_ROOT]: { hasTrustDialogAccepted: true } },
    },
    null,
    2,
  );
  for (const f of [path.join(home, ".claude.json"), path.join(configDir, ".claude.json")]) {
    if (!existsSync(f)) writeFileSync(f, onboarding, "utf-8");
  }

  const sub = settings.subModel || settings.model;
  // 認証は LLM_AUTH_MODE（src/agent/llm-auth.ts）。開発者のシェルの ANTHROPIC_*・CLAUDE_CODE_OAUTH_TOKEN は引き継がない
  const auth = resolveLlmAuth();
  const subscription = auth.mode === "subscription";
  // 親の環境（開発者のシェル）の値は使わず、設定の値だけを入れる
  const inherited = applyLlmAuthEnv(process.env as Record<string, string>, auth);
  for (const k of ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "DISABLE_AUTO_COMPACT"]) delete inherited[k];

  return {
    ...inherited,
    ...llmLimitsEnv().env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    CLAUDE_CONFIG_DIR: configDir,
    ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}),
    ...(sub ? { CLAUDE_CODE_SUBAGENT_MODEL: sub } : {}),
    // ゲートウェイに存在しない既定モデル (haiku 等) を裏で呼ばせないよう、エイリアスを全て差し替える
    // （サブスクリプションでは全モデルがあり、opus 等の別名を選ぶので差し替えない）
    ...(sub && !subscription ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: sub, ANTHROPIC_SMALL_FAST_MODEL: sub } : {}),
    ...(settings.model && !subscription
      ? { ANTHROPIC_DEFAULT_SONNET_MODEL: settings.model, ANTHROPIC_DEFAULT_OPUS_MODEL: settings.model }
      : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // CLAUDE.md は開発者向け。エージェントには agent/AGENTS.md を渡す（claude-session.ts）
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  };
}

/** Claude Code 起動時の共通引数 */
export function baseClaudeArgs(settings: ClaudeModelSettings): string[] {
  const args = [
    CLAUDE_BINARY,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
  ];
  if (settings.model) args.push("--model", settings.model);
  if (settings.effort) args.push("--effort", settings.effort);
  return args;
}
