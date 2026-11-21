import { boolSetting, numSetting } from "./settings";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifySolverWithReplay } from "./evolution/replay-verifier";
import type { MainAgent } from "./agent/main-agent";
import type { RunSummary } from "./runner";
import { logger } from "./tools";
import { uiBus } from "./ui/event-bus";

import { SOLVER_PATH } from "./paths";
import { restoreProtectedFiles, snapshotProtectedFiles } from "./evolution/edit-guard";
import { appendReview } from "./agent/harness-review";
import { clearEvolutionPending, markEvolutionPending, recoverPendingEvolution } from "./evolution/pending";

export interface EvolutionOutcome {
  invoked: boolean;
  ok: boolean;
  replayVerified: boolean;
  rolledBack: boolean;
  summaryText: string;
}


/**
 * 試合後の自己進化。メインエージェント（ツールありの新しいセッションに、試合中のメモ・経過・サブへの依頼を渡す）に振り返りと改修をさせ、
 * リプレイ検証に失敗したら active-solver.ts を自動ロールバックする。
 */
export async function runPostMatchEvolution(
  summary: RunSummary,
  mainAgent: MainAgent | null,
): Promise<EvolutionOutcome> {
  try {
    return await evolveOnce(summary, mainAgent);
  } catch (err) {
    // 途中の例外でも、検証していないソルバーを次の試合に使わない（印が残っていれば検証し直し、不合格なら戻す）
    await recoverInterruptedEvolution().catch(() => undefined);
    throw err;
  }
}

async function evolveOnce(summary: RunSummary, mainAgent: MainAgent | null): Promise<EvolutionOutcome> {
  if (!mainAgent || !mainAgent.alive) {
    return { invoked: false, ok: false, replayVerified: true, rolledBack: false, summaryText: "main agent not running" };
  }
  const minTurns = numSetting("AGENT_EVOLVE_MIN_TURNS", { min: 0, integer: true });
  if (summary.turns < minTurns) {
    // 待機切れ・接続失敗などで試合になっていない。ここから学ぶとソルバーを誤った方向に変えてしまう
    const why = `${summary.turns} ターンで終了（${summary.gameOverReason ?? "理由不明"}）のため振り返りを省略（AGENT_EVOLVE_MIN_TURNS=${minTurns}）`;
    uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "振り返りを省略", content: why });
    return { invoked: false, ok: true, replayVerified: true, rolledBack: false, summaryText: why };
  }
  uiBus.patchState({
    status: "evolving",
    statusMessage: `Run ${summary.runId} の振り返り・ソルバー改修をメインエージェントが実行中...`,
  });

  const backupCode = existsSync(SOLVER_PATH) ? readFileSync(SOLVER_PATH, "utf-8") : null;
  const protectedBefore = snapshotProtectedFiles();
  const tokensBefore = mainAgent.usage().totalTokens;
  // 振り返りの途中でハーネスが止まっても、次の起動で検証し直せるように印を残す（recoverInterruptedEvolution）
  markEvolutionPending({ runId: summary.runId, runDir: summary.runDir, startedAt: new Date().toISOString(), stage: "postMatch" }, backupCode);
  const res = await mainAgent.postMatch(
    summary.diagnosis?.markdownReport ?? "(no diagnosis)",
    summary.runDir,
    numSetting("AGENT_POST_MATCH_TIMEOUT_MIN", { min: 1 }) * 60_000,
  );
  const reverted = restoreProtectedFiles(protectedBefore);
  if (reverted.length > 0) {
    logger.warn({ reverted }, "Post-match edits outside the allowed scope were reverted");
    uiBus.pushClaudeEvent({
      context: "evolution",
      kind: "error",
      title: "編集範囲外の変更を元に戻した",
      content: `振り返りで変更できるのは active-solver.ts・knowledge/・agent/tools/ のみ:\n${reverted.join("\n")}`,
    });
  }
  const outputText = res.status === "ok" ? res.text : `(${res.status}${res.status === "dead" ? `: ${res.error}` : ""})`;
  const solverChanged = backupCode !== null && existsSync(SOLVER_PATH) && readFileSync(SOLVER_PATH, "utf-8") !== backupCode;

  // 改修前のソルバーと比べて、罠と分かっているマスへ動く手が増えていないかも確かめる
  const verification = await verifySolverWithReplay(summary.runDir, { baselineCode: backupCode });
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

    // 最高記録のソルバーは試合直後に runner が保存済み（改修前の、実際に試合で使ったもの）
  }

  // ここからはレビュー（ソルバーの編集は認めない）。途切れたら検証済みのソルバーへ戻す
  markEvolutionPending(
    { runId: summary.runId, runDir: summary.runDir, startedAt: new Date().toISOString(), stage: "review" },
    existsSync(SOLVER_PATH) ? readFileSync(SOLVER_PATH, "utf-8") : null,
  );
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
      `- **Tokens Used (post-match)**: ${(mainAgent.usage().totalTokens - tokensBefore).toLocaleString()}`,
      reverted.length > 0 ? `- **Reverted (out of scope)**: ${reverted.join(", ")}` : "",
      verification.errors.length > 0 ? `- **Errors**: ${verification.errors.join("; ")}` : "",
      "",
      "## Claude Code Output",
      outputText,
    ].join("\n"),
  );

  // ハーネスへのレビュー（使い勝手・不具合・欲しい機能）→ agent/REVIEW.md（開発者が読む）
  if (boolSetting("AGENT_REVIEW")) {
    uiBus.patchState({ statusMessage: `Run ${summary.runId}: エージェントがハーネスをレビュー中...` });
    // レビュー中の編集は認めない（検証済みのソルバーも含めて元に戻す）
    const guard = snapshotProtectedFiles({ includeSolver: true });
    const review = await mainAgent.reviewHarness(
      { runDir: summary.runDir, reverted, verificationOk: verification.ok, rolledBack },
      numSetting("AGENT_REVIEW_TIMEOUT_SEC", { min: 10 }) * 1000,
    );
    restoreProtectedFiles(guard);
    if (review) {
      appendReview({ runId: summary.runId, room: summary.room, model: summary.model ?? null, text: review });
      await Bun.write(path.join(summary.runDir, "harness-review.md"), review);
      uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "ハーネスへのレビュー（agent/REVIEW.md）", content: review });
    }
  }

  clearEvolutionPending();
  return {
    invoked: true,
    ok: res.status === "ok" && verification.ok,
    replayVerified: verification.ok,
    rolledBack,
    summaryText: outputText,
  };
}

/**
 * 起動時に呼ぶ（index.ts・play.ts）。前回の振り返りが途中で止まっていたら、改修後のソルバーをリプレイ検証し直し、
 * 不合格なら改修前に戻す。結果は UI の出来事とその試合の summary.json に残す。
 */
export async function recoverInterruptedEvolution(): Promise<void> {
  const r = await recoverPendingEvolution((runDir, baselineCode) => verifySolverWithReplay(runDir, { baselineCode }));
  if (!r) return;
  const what = !r.solverChanged
    ? "ソルバーは改修前のまま（検証不要）"
    : r.rolledBack
      ? `改修後のソルバーが検証に通らないので改修前に戻した（${r.errors.slice(0, 3).join("; ") || "理由不明"}）`
      : "改修後のソルバーは検証に通った（そのまま使う）";
  logger.warn({ runId: r.pending.runId, stage: r.pending.stage, ...r }, "前回の振り返りが途中で止まっていた");
  uiBus.pushClaudeEvent({
    context: "evolution",
    kind: r.rolledBack ? "error" : "system",
    title: "前回の振り返りが途中で止まっていた",
    content: `Run ${r.pending.runId}（${r.pending.stage === "postMatch" ? "改修中" : "レビュー中"}に停止）: ${what}`,
  });
  const summaryPath = path.join(r.pending.runDir, "summary.json");
  try {
    if (existsSync(summaryPath)) {
      const s = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
      s.evolution = { solverChanged: r.solverChanged, replayVerified: r.verified ?? true, rolledBack: r.rolledBack, interrupted: true };
      writeFileSync(summaryPath, JSON.stringify(s, null, 2));
    }
  } catch {
    // summary が読めなくても検証・戻しは済んでいる
  }
}
