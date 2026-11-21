import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVOLUTION_BACKUP_PATH, EVOLUTION_PENDING_PATH, SOLVER_PATH } from "../paths";
import type { ReplayVerificationResult } from "./replay-verifier";

/**
 * 試合後の振り返りはソルバーを書き換えてからリプレイ検証する。その途中でハーネスが止まる（再起動・落ちる）と、
 * 検証していないソルバーが次の試合で使われてしまう。振り返りの前に印と改修前のソルバーを var/ に残し、
 * 次の起動で印が残っていれば検証し直して、不合格なら改修前に戻す。
 */
export interface EvolutionPending {
  runId: string;
  runDir: string;
  startedAt: string;
  /** postMatch = 振り返り中（未検証）／ review = 検証は済んでレビュー中（backup は検証済みのソルバー） */
  stage: "postMatch" | "review";
}

export interface PendingPaths {
  marker: string;
  backup: string;
  solver: string;
}
const defaultPaths: PendingPaths = { marker: EVOLUTION_PENDING_PATH, backup: EVOLUTION_BACKUP_PATH, solver: SOLVER_PATH };

export function markEvolutionPending(info: EvolutionPending, backupCode: string | null, paths: PendingPaths = defaultPaths): void {
  mkdirSync(path.dirname(paths.marker), { recursive: true });
  if (backupCode !== null) writeFileSync(paths.backup, backupCode, "utf-8");
  else rmSync(paths.backup, { force: true });
  writeFileSync(paths.marker, JSON.stringify(info, null, 2), "utf-8");
}

export function clearEvolutionPending(paths: PendingPaths = defaultPaths): void {
  rmSync(paths.marker, { force: true });
  rmSync(paths.backup, { force: true });
}

export interface RecoveryResult {
  pending: EvolutionPending;
  solverChanged: boolean;
  verified: boolean | null;
  rolledBack: boolean;
  errors: string[];
}

/**
 * 起動時に呼ぶ。途切れた振り返りが無ければ null。ソルバーが改修前と同じなら何もしない。
 * 違えば verify（既定はリプレイ検証）し、不合格・検証できない時は改修前に戻す。
 */
export async function recoverPendingEvolution(
  verify: (runDir: string, baselineCode: string) => Promise<ReplayVerificationResult>,
  paths: PendingPaths = defaultPaths,
): Promise<RecoveryResult | null> {
  if (!existsSync(paths.marker)) return null;
  let pending: EvolutionPending;
  try {
    pending = JSON.parse(readFileSync(paths.marker, "utf-8")) as EvolutionPending;
  } catch {
    clearEvolutionPending(paths);
    return null;
  }
  const backup = existsSync(paths.backup) ? readFileSync(paths.backup, "utf-8") : null;
  const now = existsSync(paths.solver) ? readFileSync(paths.solver, "utf-8") : null;
  const result: RecoveryResult = { pending, solverChanged: backup !== null && now !== backup, verified: null, rolledBack: false, errors: [] };
  if (backup !== null && now !== backup) {
    let ok = false;
    try {
      const v = await verify(pending.runDir, backup);
      ok = v.ok;
      result.errors = v.errors;
    } catch (err) {
      result.errors = [err instanceof Error ? err.message : String(err)];
    }
    result.verified = ok;
    if (!ok) {
      writeFileSync(paths.solver, backup, "utf-8");
      result.rolledBack = true;
    }
  }
  clearEvolutionPending(paths);
  return result;
}
