import { boolSetting, numSetting } from "./settings";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ReplayVerificationResult, verifyPolicyWithReplay } from "./evolution/replay-verifier";
import type { MainAgent } from "./agent/main-agent";
import type { RunSummary } from "./runner";
import { logger } from "./tools";
import { uiBus } from "./ui/event-bus";

import { EVALUATOR_PATH, TACTICS_PATH } from "./paths";
import { backupEvaluator, backupTactics, benchRoom, clearEvaluatorBackup, EVALUATOR_BACKUP_PATH, gateEvaluatorChange, gateTacticsChange, type GateResult, TACTICS_BACKUP_PATH } from "./sim/post-match";
import { checkTacticsFile } from "./sim/tactics-check";
import { lab } from "./sim/lab";
import { restoreProtectedFiles, snapshotProtectedFiles } from "./evolution/edit-guard";
import { appendReview } from "./agent/harness-review";
import { beginEvaluatorEdit, endEvaluatorEdit } from "./evolution/post-match-queue";

export interface EvolutionOutcome {
  invoked: boolean;
  ok: boolean;
  /** 改修した評価関数が試合の記録での確かめに通ったか（改修していなければ true） */
  replayVerified: boolean;
  /** 改修した評価関数を元に戻したか */
  rolledBack: boolean;
  summaryText: string;
}

/**
 * 試合後の振り返り。試合中の LLM（ツールありの新しいセッションに、試合中のメモ・経過を渡す）に振り返りと改修をさせる。
 * 評価関数を改修していたら、試合の記録の盤面で確かめ（例外・罠へ動く手が増えていないか）、シミュレータで改修前と比べ、どちらかに落ちたら元に戻す。
 */
/** 進み具合の知らせ方（裏で行う時は試合の状態を上書きしない。post-match-queue.ts） */
export type Say = (message: string) => void;
const sayStatus: Say = (message) => uiBus.patchState({ status: "evolving", statusMessage: message });

export async function runPostMatchEvolution(summary: RunSummary, mainAgent: MainAgent | null, say: Say = sayStatus): Promise<EvolutionOutcome> {
  // 書き換えている間に始まった試合は、書き換える前の評価関数を使う
  beginEvaluatorEdit();
  try {
    return await evolveOnce(summary, mainAgent, say);
  } catch (err) {
    // 途中の例外でも、確かめていない評価関数を次の試合に使わない
    await recoverInterruptedEvolution().catch(() => undefined);
    throw err;
  } finally {
    endEvaluatorEdit();
  }
}

async function evolveOnce(summary: RunSummary, mainAgent: MainAgent | null, say: Say): Promise<EvolutionOutcome> {
  if (!mainAgent || !mainAgent.alive) {
    return { invoked: false, ok: false, replayVerified: true, rolledBack: false, summaryText: "main agent not running" };
  }
  const minTurns = numSetting("AGENT_EVOLVE_MIN_TURNS", { min: 0, integer: true });
  if (summary.turns < minTurns) {
    // 待機切れ・接続失敗などで試合になっていない。ここから学ぶと方策を誤った方向に変えてしまう
    const why = `${summary.turns} ターンで終了（${summary.gameOverReason ?? "理由不明"}）のため振り返りを省略（AGENT_EVOLVE_MIN_TURNS=${minTurns}）`;
    uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "振り返りを省略", content: why });
    return { invoked: false, ok: true, replayVerified: true, rolledBack: false, summaryText: why };
  }
  say(`Run ${summary.runId} の振り返りを LLM が実行中...`);

  const evaluatorBefore = existsSync(EVALUATOR_PATH) ? readFileSync(EVALUATOR_PATH, "utf-8") : null;
  // 振り返りの途中でハーネスが止まっても、次の起動で改修前に戻せるように控えておく（recoverInterruptedEvolution）
  backupEvaluator(evaluatorBefore);
  const tacticsBefore = existsSync(TACTICS_PATH) ? readFileSync(TACTICS_PATH, "utf-8") : null;
  backupTactics(tacticsBefore);
  // 振り返りに渡す: 今の方策の、このルームに似せた地図（本物の地図があれば混ぜる）での成績
  let simInfo = "";
  try {
    const b = await benchRoom(summary.room);
    const official = summary.officialResult?.totalScore ?? null;
    const realPerTurn = official !== null && summary.turns > 0 ? Math.round((official / summary.turns) * 10) / 10 : null;
    simInfo = [
      "## シミュレータでの今の方策の成績",
      `- このルームに似せた地図 ${b.maps} 枚（うち本物の地図を少し変えたもの ${b.realMaps} 枚）: 平均 ${b.perTurn} 点/ターン、罠 ${b.hazardHits} 回`,
      realPerTurn !== null ? `- この試合の本番: ${realPerTurn} 点/ターン（公式 ${official} / ${summary.turns} ターン）。大きく違えば、シミュレータが本物と違う（地図の作り方・相手・ルール）か、本番の判断に問題がある` : "",
      "- 比べ方: `bun src/cli.ts sim --room <n>`（1試合ずつ）/ `bun src/cli.ts bench --room <n> --evaluator <file>`（評価関数の比較）/ `bun src/cli.ts bench --room <n> --tactics <file>`（作戦スクリプトの比較）/ `bun src/cli.ts tactics-check`",
    ].filter(Boolean).join("\n");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "シミュレータの成績を出せなかった");
  }
  const protectedBefore = snapshotProtectedFiles();
  const tokensBefore = mainAgent.usage().totalTokens;
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
      content: `振り返りで変更できるのは evaluator.ts・tactics.ts・knowledge/・agent/tools/ のみ:\n${reverted.join("\n")}`,
    });
  }
  // 時間切れでも、それまでに出た文とツールの回数は残す（REVIEW 2026-11-23: 振り返りの本文が残らない）
  const outputText =
    res.status === "ok"
      ? res.text
      : res.status === "timeout"
        ? `(時間切れ ${Math.round(res.durationMs / 60000)} 分・ツール ${res.toolUses ?? 0} 回。AGENT_POST_MATCH_TIMEOUT_MIN を延ばすか、振り返りの範囲を絞る)\n\n${res.partial ? `時間切れまでに出た文（最後の部分）:\n${res.partial}` : "（文は出ていなかった）"}`
        : `(${res.status}${res.status === "dead" ? `: ${res.error}` : ""})`;

  // 評価関数を改修していたら: 試合の記録の盤面で確かめ（例外・罠へ動く手が増えていないか）、シミュレータで改修前と比べる。どちらかに落ちたら戻す
  const evaluatorChanged = evaluatorBefore !== null && existsSync(EVALUATOR_PATH) && readFileSync(EVALUATOR_PATH, "utf-8") !== evaluatorBefore;
  let verification: ReplayVerificationResult | null = null;
  let evaluatorGate: GateResult | null = null;
  let rolledBack = false;
  if (evaluatorChanged) {
    say(`Run ${summary.runId}: 改修した評価関数を試合の記録とシミュレータで確かめています...`);
    verification = await verifyPolicyWithReplay(summary.runDir, { baselineEvaluatorCode: evaluatorBefore });
    if (verification.ok) evaluatorGate = await gateEvaluatorChange(evaluatorBefore!, summary.room);
    const c = evaluatorGate?.comparison;
    const detail = !verification.ok
      ? `試合の記録での確かめに落ちた: ${verification.errors.slice(0, 3).join("; ")}`
      : c
        ? `改修前 ${c.a} → 改修後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}、罠 ${c.hazardsA}→${c.hazardsB}）`
        : `比べられなかった: ${evaluatorGate?.error}`;
    if (!verification.ok || !evaluatorGate?.ok) {
      writeFileSync(EVALUATOR_PATH, evaluatorBefore!, "utf-8");
      rolledBack = true;
      uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: "評価関数の改修を元に戻した", content: detail });
    } else {
      uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "評価関数の改修を採用（試合の記録で確かめ、シミュレータで弱くなっていない）", content: detail });
    }
  }
  const replayVerified = verification?.ok ?? true;

  // 作戦スクリプトを改修していたら: 短い試合で確かめ（例外・時間。別プロセスで時間を切る）、シミュレータで改修前と比べる。どちらかに落ちたら戻す
  const tacticsChanged = tacticsBefore !== null && existsSync(TACTICS_PATH) && readFileSync(TACTICS_PATH, "utf-8") !== tacticsBefore;
  let tacticsOutcome: TacticsOutcome | null = null;
  if (tacticsChanged) {
    say(`Run ${summary.runId}: 改修した作戦スクリプトを確かめています...`);
    tacticsOutcome = await gateTactics(tacticsBefore!, summary.room);
  }

  summary.evolution = {
    replayVerified,
    rolledBack,
    ...(evaluatorChanged ? { evaluatorChanged, evaluatorAccepted: !rolledBack } : {}),
    ...(tacticsOutcome ? { tacticsChanged: true, tacticsAccepted: tacticsOutcome.accepted } : {}),
  };
  await Bun.write(path.join(summary.runDir, "summary.json"), JSON.stringify(summary, null, 2));

  await Bun.write(
    path.join(summary.runDir, "evolution-report.md"),
    [
      `# Post-Match Evolution Report (${summary.runId})`,
      `- **Agent Result**: ${res.status}${res.status === "ok" ? ` (${Math.round(res.durationMs / 1000)}s)` : ""}`,
      `- **Evaluator Changed**: ${evaluatorChanged ? (rolledBack ? "reverted" : "accepted") : "no"}`,
      `- **Tactics Changed**: ${tacticsOutcome ? `${tacticsOutcome.accepted ? "accepted" : "reverted"} (${tacticsOutcome.detail})` : "no"}`,
      verification ? `- **Replay Verified**: ${verification.ok} (Turns Tested: ${verification.turnsTested}, hazards ${verification.baselineHazardLandings ?? "-"} → ${verification.hazardLandings ?? "-"})` : "",
      evaluatorGate?.comparison ? `- **Simulator**: ${evaluatorGate.comparison.a} → ${evaluatorGate.comparison.b} pts/turn, diff ${evaluatorGate.comparison.diff}±${evaluatorGate.comparison.se}` : evaluatorGate?.error ? `- **Simulator**: ${evaluatorGate.error}` : "",
      simInfo ? `\n${simInfo}\n` : "",
      `- **Tokens Used (post-match)**: ${res.status === "timeout" ? "不明（時間切れで使用量が報告されない）" : (mainAgent.usage().totalTokens - tokensBefore).toLocaleString()}`,
      reverted.length > 0 ? `- **Reverted (out of scope)**: ${reverted.join(", ")}` : "",
      verification && verification.errors.length > 0 ? `- **Errors**: ${verification.errors.join("; ")}` : "",
      "",
      "## Claude Code Output",
      outputText,
    ].filter((l) => l !== "").join("\n"),
  );

  // ハーネスへのレビュー（使い勝手・不具合・欲しい機能）→ agent/REVIEW.md（開発者が読む）
  if (boolSetting("AGENT_REVIEW")) {
    say(`Run ${summary.runId}: LLM がハーネスをレビュー中...`);
    // レビュー中の編集は認めない（確かめ済みの評価関数も含めて元に戻す）。途中で止まっても戻せるよう控える
    backupEvaluator(existsSync(EVALUATOR_PATH) ? readFileSync(EVALUATOR_PATH, "utf-8") : null);
    backupTactics(existsSync(TACTICS_PATH) ? readFileSync(TACTICS_PATH, "utf-8") : null);
    const guard = snapshotProtectedFiles({ includeEvaluator: true });
    let review: string | null;
    try {
      review = await mainAgent.reviewHarness({ runDir: summary.runDir, reverted, evaluatorChanged, rolledBack }, numSetting("AGENT_REVIEW_TIMEOUT_SEC", { min: 10 }) * 1000);
    } finally {
      restoreProtectedFiles(guard);
    }
    if (review) {
      appendReview({ runId: summary.runId, room: summary.room, model: summary.model ?? null, text: review });
      await Bun.write(path.join(summary.runDir, "harness-review.md"), review);
      uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "ハーネスへのレビュー（agent/REVIEW.md）", content: review });
    }
  }
  clearEvaluatorBackup();

  return { invoked: true, ok: res.status === "ok", replayVerified, rolledBack, summaryText: outputText };
}

/**
 * 起動時に呼ぶ（index.ts・play.ts）。前回の振り返りが途中で止まっていたら、確かめていない評価関数の改修を改修前に戻す。
 */
export async function recoverInterruptedEvolution(): Promise<void> {
  for (const [backup, file, what] of [
    [EVALUATOR_BACKUP_PATH, EVALUATOR_PATH, "評価関数"],
    [TACTICS_BACKUP_PATH, TACTICS_PATH, "作戦スクリプト"],
  ] as const) {
    if (!existsSync(backup)) continue;
    const before = readFileSync(backup, "utf-8");
    if (existsSync(file) && readFileSync(file, "utf-8") !== before) {
      writeFileSync(file, before, "utf-8");
      logger.warn(`前回の振り返りが途中で止まっていた。確かめていない${what}の改修を戻した`);
      uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: "前回の振り返りが途中で止まっていた", content: `確かめていない${what}の改修を、改修前に戻した` });
    }
  }
  clearEvaluatorBackup();
}

export interface TacticsOutcome {
  accepted: boolean;
  detail: string;
}

/**
 * 改修した作戦スクリプトを確かめる（振り返り・学習の LLM の後）: 別プロセスで短い試合（例外・時間）→ シミュレータで改修前と比べる。
 * 落ちたら改修前に戻す
 */
export async function gateTactics(before: string, room: number | null): Promise<TacticsOutcome> {
  const check = await checkTacticsFile();
  let accepted = check.ok;
  let detail = check.ok ? "" : `短い試合での確かめに落ちた: ${check.problem}${check.lastError ? `（${check.lastError}）` : ""}`;
  if (check.ok) {
    const g = await gateTacticsChange(before, room);
    const c = g.comparison;
    accepted = g.ok;
    detail = c
      ? `改修前 ${c.a} → 改修後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}）、モデルの切り替え ${g.switches.before} → ${g.switches.after} 回${g.error ? `。${g.error}` : ""}`
      : `比べられなかった: ${g.error}`;
  }
  if (!accepted) writeFileSync(TACTICS_PATH, before, "utf-8");
  uiBus.pushClaudeEvent({ context: "evolution", kind: accepted ? "system" : "error", title: accepted ? "作戦スクリプトの改修を採用（シミュレータで弱くなっていない）" : "作戦スクリプトの改修を元に戻した", content: detail });
  return { accepted, detail };
}

/**
 * 試合後の学習（index.ts・play.ts）。シミュレータで方策のパラメータを TRAIN_AFTER_MATCH_MIN 分だけ学習し、
 * 学習に使っていない地図ではっきり良くなった時だけ var/policy/params.json に保存する。結果は evolution-report.md と UI に残す。
 */
export async function runPostMatchTraining(summary: RunSummary, say: Say = sayStatus): Promise<void> {
  const minTurns = numSetting("AGENT_EVOLVE_MIN_TURNS", { min: 0, integer: true });
  const minutes = numSetting("TRAIN_AFTER_MATCH_MIN", { min: 0 });
  if (summary.turns < minTurns || minutes <= 0) return;
  say(`Run ${summary.runId}: シミュレータで方策を学習中（WebUI の「学習」で進み具合が見える）...`);
  // 停止ボタンで学習も止める
  const watch = setInterval(() => {
    if (uiBus.getState().stopRequested) lab.stop();
  }, 1000);
  try {
    if (lab.busy && lab.state().job?.trigger !== "idle") {
      uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "方策の学習（シミュレータ）", content: "「学習」画面の仕事が動いているので、試合後の学習は行いませんでした" });
      return;
    }
    // 試合で使ったモデルを育てる
    const r = await lab.train({ room: summary.room, minutes, trigger: "post-match", ...(summary.policyModel ? { model: summary.policyModel } : {}) });
    if (!r) return;
    const c = r.comparison;
    const text = `${r.modelName}: ${r.generations} 世代・${r.episodes} 試合。学習に使っていない地図で ${c.a} → ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}）→ ${r.accepted ? "保存した（次の試合から使う）" : "見送り（はっきり良くなっていない）"}`;
    uiBus.pushClaudeEvent({ context: "evolution", kind: "system", title: "方策の学習（シミュレータ）", content: text });
    const report = path.join(summary.runDir, "evolution-report.md");
    const prev = existsSync(report) ? readFileSync(report, "utf-8") : `# Post-Match Evolution Report (${summary.runId})\n`;
    writeFileSync(report, `${prev}\n\n## 方策の学習（シミュレータ）\n${text}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "方策の学習に失敗");
    uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: "方策の学習に失敗", content: msg });
  } finally {
    clearInterval(watch);
  }
}
