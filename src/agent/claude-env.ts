import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_HOME_DIR, PROJECT_ROOT } from "../paths";

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

  const apiKey = Bun.env.LLM_API_KEY ?? "";
  const baseUrl = (Bun.env.LLM_API_URL ?? "").replace(/\/v1\/?$/, "");
  const sub = settings.subModel || settings.model;

  return {
    ...(process.env as Record<string, string>),
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    ...(apiKey ? { ANTHROPIC_CUSTOM_HEADERS: `X-Gravitee-Api-Key: ${apiKey}` } : {}),
    ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}),
    // ゲートウェイに存在しない既定モデル (haiku 等) を裏で呼ばせないよう、エイリアスを全て差し替える
    ...(sub
      ? {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: sub,
          ANTHROPIC_SMALL_FAST_MODEL: sub,
          CLAUDE_CODE_SUBAGENT_MODEL: sub,
        }
      : {}),
    ...(settings.model
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
