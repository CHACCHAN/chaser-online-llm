import { boolSetting, numSetting } from "./settings";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifySolverWithReplay } from "./evolution/replay-verifier";
import type { MainAgent } from "./agent/main-agent";
import type { RunSummary } from "./runner";
import { logger } from "./tools";
import { uiBus } from "./ui/event-bus";

import { EVALUATOR_PATH, SOLVER_PATH } from "./paths";
import { backupEvaluator, benchRoom, clearEvaluatorBackup, EVALUATOR_BACKUP_PATH, gateEvaluatorChange, trainAfterMatch, type GateResult } from "./sim/post-match";
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
  const evaluatorBefore = existsSync(EVALUATOR_PATH) ? readFileSync(EVALUATOR_PATH, "utf-8") : null;
  backupEvaluator(evaluatorBefore);
  // 振り返りに渡す: 今の方策の、このルームに似せた地図（本物の地図があれば混ぜる）での成績
  let simInfo = "";
  try {
    const b = await benchRoom(summary.room);
    const official = summary.officialResult?.totalScore ?? null;
    const realPerTurn = official !== null && summary.turns > 0 ? Math.round((official / summary.turns) * 10) / 10 : null;
    simInfo = [
      "## シミュレータでの今の方策（planner）の成績",
      `- このルームに似せた地図 ${b.maps} 枚（うち本物の地図を少し変えたもの ${b.realMaps} 枚）: 平均 ${b.perTurn} 点/ターン、罠 ${b.hazardHits} 回`,
      realPerTurn !== null ? `- この試合の本番: ${realPerTurn} 点/ターン（公式 ${official} / ${summary.turns} ターン）。大きく違えば、シミュレータが本物と違う（地図の作り方・相手・ルール）か、本番の判断に問題がある` : "",
      "- 比べ方: `bun src/cli.ts sim --room <n>`（1試合ずつ）/ `bun src/cli.ts bench --room <n> --evaluator <file>`（評価関数の比較）",
    ].filter(Boolean).join("\n");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "シミュレータの成績を出せなかった");
  }
  const protectedBefore = snapshotProtectedFiles();
  const tokensBefore = mainAgent.usage().totalTokens;
  // 振り返りの途中でハーネスが止まっても、次の起動で検証し直せるように印を残す（recoverInterruptedEvolution）
  markEvolutionPending({ runId: summary.runId, runDir: summary.runDir, startedAt: new Date().toISOString(), stage: "postMatch" }, backupCode);
  const res = await mainAgent.postMatch(
    summary.diagnosis?.markdownReport ?? "(no diagnosis)",
    summary.runDir,
    numSetting("AGENT_POST_MATCH_TIMEOUT_MIN", { min: 1 }) * 60_000,
    simInfo,
  );
  const reverted = restoreProtectedFiles(protectedBefore);
  if (reverted.length > 0) {
    logger.warn({ reverted }, "Post-match edits outside the allowed scope were reverted");
    uiBus.pushClaudeEvent({
      context: "evolution",
      kind: "error",
      title: "編集範囲外の変更を元に戻した",
      content: `振り返りで変更できるのは evaluator.ts・active-solver.ts・knowledge/・agent/tools/ のみ:\n${reverted.join("\n")}`,
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

  // 評価関数（経路探索）を改修していたら、改修前とシミュレータで比べ、弱くなっていれば元に戻す
  const evaluatorChanged = evaluatorBefore !== null && existsSync(EVALUATOR_PATH) && readFileSync(EVALUATOR_PATH, "utf-8") !== evaluatorBefore;
  let evaluatorGate: GateResult | null = null;
  if (evaluatorChanged) {
    uiBus.patchState({ statusMessage: `Run ${summary.runId}: 改修した評価関数をシミュレータで比べています...` });
    evaluatorGate = await gateEvaluatorChange(evaluatorBefore!, summary.room);
    const c = evaluatorGate.comparison;
    const detail = c ? `改修前 ${c.a} → 改修後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}、罠 ${c.hazardsA}→${c.hazardsB}）` : `比べられなかった: ${evaluatorGate.error}`;
    if (!evaluatorGate.ok) {
      writeFileSync(EVALUATOR_PATH, evaluatorBefore!, "utf-8");
      uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: "評価関数の改修を元に戻した（シミュレータで弱くなった）", content: detail });
    } else {
      uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "評価関数の改修を採用（シミュレータで弱くなっていない）", content: detail });
    }
  }
  clearEvaluatorBackup();

  // ここからはレビュー（ソルバーの編集は認めない）。途切れたら検証済みのソルバーへ戻す
  markEvolutionPending(
    { runId: summary.runId, runDir: summary.runDir, startedAt: new Date().toISOString(), stage: "review" },
    existsSync(SOLVER_PATH) ? readFileSync(SOLVER_PATH, "utf-8") : null,
  );
  summary.evolution = {
    solverChanged,
    replayVerified: verification.ok,
    rolledBack,
    ...(evaluatorChanged ? { evaluatorChanged, evaluatorAccepted: evaluatorGate?.ok ?? false } : {}),
  };
  await Bun.write(path.join(summary.runDir, "summary.json"), JSON.stringify(summary, null, 2));

  await Bun.write(
    path.join(summary.runDir, "evolution-report.md"),
    [
      `# Post-Match Evolution Report (${summary.runId})`,
      `- **Agent Result**: ${res.status}${res.status === "ok" ? ` (${Math.round(res.durationMs / 1000)}s)` : ""}`,
      `- **Solver Changed**: ${solverChanged}`,
      `- **Replay Verified**: ${verification.ok} (Turns Tested: ${verification.turnsTested}, Changed CMD1: ${verification.changedCmd1Count}, Changed CMD2: ${verification.changedCmd2Count})`,
      `- **Rolled Back**: ${rolledBack}`,
      evaluatorChanged
        ? `- **Evaluator Changed**: ${evaluatorGate?.ok ? "accepted" : "reverted"}${evaluatorGate?.comparison ? ` (sim ${evaluatorGate.comparison.a} → ${evaluatorGate.comparison.b} pts/turn, diff ${evaluatorGate.comparison.diff}±${evaluatorGate.comparison.se})` : evaluatorGate?.error ? ` (${evaluatorGate.error})` : ""}`
        : "",
      simInfo ? `\n${simInfo}\n` : "",
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
    let review: string | null;
    try {
      review = await mainAgent.reviewHarness(
        { runDir: summary.runDir, reverted, verificationOk: verification.ok, rolledBack },
        numSetting("AGENT_REVIEW_TIMEOUT_SEC", { min: 10 }) * 1000,
      );
    } finally {
      restoreProtectedFiles(guard);
    }
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
  // 評価関数の改修の途中で止まっていたら、比べていない改修は使わない（改修前に戻す）
  if (existsSync(EVALUATOR_BACKUP_PATH)) {
    const before = readFileSync(EVALUATOR_BACKUP_PATH, "utf-8");
    if (existsSync(EVALUATOR_PATH) && readFileSync(EVALUATOR_PATH, "utf-8") !== before) {
      writeFileSync(EVALUATOR_PATH, before, "utf-8");
      uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: "前回の振り返りが途中で止まっていた", content: "シミュレータで比べていない評価関数の改修を、改修前に戻した" });
    }
    clearEvaluatorBackup();
  }
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

/**
 * 試合後の学習（index.ts・play.ts）。シミュレータで方策のパラメータを TRAIN_AFTER_MATCH_MIN 分だけ学習し、
 * 学習に使っていない地図ではっきり良くなった時だけ var/policy/params.json に保存する。結果は evolution-report.md と UI に残す。
 */
export async function runPostMatchTraining(summary: RunSummary): Promise<void> {
  const minTurns = numSetting("AGENT_EVOLVE_MIN_TURNS", { min: 0, integer: true });
  if (summary.turns < minTurns || numSetting("TRAIN_AFTER_MATCH_MIN", { min: 0 }) <= 0) return;
  uiBus.patchState({ status: "evolving", statusMessage: `Run ${summary.runId}: シミュレータで方策を学習中...` });
  try {
    const r = await trainAfterMatch(summary.room, {
      shouldStop: () => uiBus.getState().stopRequested,
      log: (m) => uiBus.patchState({ statusMessage: `学習中: ${m}` }),
    });
    if (!r) return;
    const c = r.comparison;
    const text = `${r.generations} 世代・${r.episodes} 試合。学習に使っていない地図で ${c.a} → ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}）→ ${r.accepted ? "保存した（次の試合から使う）" : "見送り（はっきり良くなっていない）"}`;
    uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "方策の学習（シミュレータ）", content: text });
    const report = path.join(summary.runDir, "evolution-report.md");
    const prev = existsSync(report) ? readFileSync(report, "utf-8") : `# Post-Match Evolution Report (${summary.runId})\n`;
    writeFileSync(report, `${prev}\n\n## 方策の学習（シミュレータ）\n${text}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "方策の学習に失敗");
    uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: "方策の学習に失敗", content: msg });
  }
}
