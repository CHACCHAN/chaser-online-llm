import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifySolverWithReplay } from "./evolution/replay-verifier";
import type { MainAgent } from "./agent/main-agent";
import { getRoomProfile, saveRoomProfile } from "./memory/knowledge-store";
import type { RunSummary } from "./runner";
import { logger } from "./tools";
import { uiBus } from "./ui/event-bus";

import { BEST_SOLVERS_DIR, SOLVER_PATH } from "./paths";

export interface EvolutionOutcome {
  invoked: boolean;
  ok: boolean;
  replayVerified: boolean;
  rolledBack: boolean;
  summaryText: string;
}

const POST_MATCH_TIMEOUT_MS = 15 * 60_000;

/**
 * 試合後の自己進化。試合中ずっと常駐していたメインエージェント（試合の文脈を保持）に振り返りと改修をさせ、
 * リプレイ検証に失敗したら active-solver.ts を自動ロールバックする。
 */
export async function runPostMatchEvolution(
  summary: RunSummary,
  mainAgent: MainAgent | null,
): Promise<EvolutionOutcome> {
  if (!mainAgent || !mainAgent.alive) {
    return { invoked: false, ok: false, replayVerified: true, rolledBack: false, summaryText: "main agent not running" };
  }
  uiBus.patchState({
    status: "evolving",
    statusMessage: `Run ${summary.runId} の振り返り・ソルバー改修をメインエージェントが実行中...`,
  });

  const backupCode = existsSync(SOLVER_PATH) ? readFileSync(SOLVER_PATH, "utf-8") : null;
  const res = await mainAgent.postMatch(
    summary.diagnosis?.markdownReport ?? "(no diagnosis)",
    summary.runDir,
    POST_MATCH_TIMEOUT_MS,
  );
  const outputText = res.status === "ok" ? res.text : `(${res.status}${res.status === "dead" ? `: ${res.error}` : ""})`;
  const solverChanged = backupCode !== null && existsSync(SOLVER_PATH) && readFileSync(SOLVER_PATH, "utf-8") !== backupCode;

  const verification = await verifySolverWithReplay(summary.runDir);
  let rolledBack = false;

  if (!verification.ok) {
    logger.warn(
      { errors: verification.errors },
      "Updated solver failed replay verification; rolling back active-solver.ts to safe backup",
    );
    uiBus.pushClaudeEvent({
      context: "evolution",
      kind: "error",
      title: "Replay Verification Failed (Auto Rollback)",
      content: verification.errors.join("\n"),
    });
    if (backupCode !== null) {
      writeFileSync(SOLVER_PATH, backupCode, "utf-8");
      rolledBack = true;
    }
  } else {
    logger.info(
      {
        turnsTested: verification.turnsTested,
        changedCmd1Count: verification.changedCmd1Count,
        changedCmd2Count: verification.changedCmd2Count,
      },
      "Updated solver passed replay verification",
    );
    uiBus.pushClaudeEvent({
      context: "evolution",
      kind: "system",
      title: "Replay Verification Passed",
      content: `Turns tested: ${verification.turnsTested}, Improved CMD1: ${verification.changedCmd1Count}, Improved CMD2: ${verification.changedCmd2Count}`,
    });

    const profile = getRoomProfile(summary.room);
    if (profile.bestRunId === summary.runId && existsSync(SOLVER_PATH)) {
      const bestSolverPath = path.join(BEST_SOLVERS_DIR, `room${summary.room}.ts`);
      mkdirSync(BEST_SOLVERS_DIR, { recursive: true });
      copyFileSync(SOLVER_PATH, bestSolverPath);
      profile.bestSolverFile = bestSolverPath;
      saveRoomProfile(profile);
    }
  }

  summary.evolution = { solverChanged, replayVerified: verification.ok, rolledBack };
  await Bun.write(path.join(summary.runDir, "summary.json"), JSON.stringify(summary, null, 2));

  await Bun.write(
    path.join(summary.runDir, "evolution-report.md"),
    [
      `# Post-Match Evolution Report (${summary.runId})`,
      `- **Agent Result**: ${res.status}${res.status === "ok" ? ` (${Math.round(res.durationMs / 1000)}s)` : ""}`,
      `- **Solver Changed**: ${solverChanged}`,
      `- **Replay Verified**: ${verification.ok} (Turns Tested: ${verification.turnsTested}, Changed CMD1: ${verification.changedCmd1Count}, Changed CMD2: ${verification.changedCmd2Count})`,
      `- **Rolled Back**: ${rolledBack}`,
      verification.errors.length > 0 ? `- **Errors**: ${verification.errors.join("; ")}` : "",
      "",
      "## Claude Code Output",
      outputText,
    ].join("\n"),
  );

  return {
    invoked: true,
    ok: res.status === "ok" && verification.ok,
    replayVerified: verification.ok,
    rolledBack,
    summaryText: outputText,
  };
}
