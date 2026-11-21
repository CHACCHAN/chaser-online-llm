import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SOLVER_PATH } from "../paths";
import {
  CMD1_COMMANDS,
  CMD1_SPECS,
  CMD2_COMMANDS,
  CMD2_SPECS,
  classifyTileSafety,
  WorldMap,
} from "../memory/world-map";
import type { TurnRecord } from "../runner";
import type { SolverDecision } from "../solver/active-solver";

export interface ReplayVerificationResult {
  ok: boolean;
  turnsTested: number;
  changedCmd1Count: number;
  changedCmd2Count: number;
  errors: string[];
  /** 新しいソルバーが、その時点の地図で罠と分かっているマスへ動く手を選んだ回数 */
  hazardLandings?: number;
  /** 比べる元のソルバー（改修前・その試合で使ったもの）の同じ回数。新しい方が多ければ不合格 */
  baselineHazardLandings?: number;
  /** 罠へ動く手を選んだフェーズ（新しいソルバーだけのもの、最大10件） */
  hazardExamples?: string[];
}

type DecideFn = (wm: WorldMap, phase: "CMD1" | "CMD2", turn: number) => SolverDecision;

/** その時点の地図で、手の行き先が罠と分かっているか */
function landsOnHazard(wm: WorldMap, command: string): boolean {
  const spec = (CMD1_SPECS as Record<string, { move: [number, number] }>)[command] ?? (CMD2_SPECS as Record<string, { move: [number, number] }>)[command];
  if (!spec || (spec.move[0] === 0 && spec.move[1] === 0)) return false;
  const [x, y] = wm.getPosition();
  const t = wm.getTile(x + spec.move[0], y + spec.move[1]);
  return !!t && classifyTileSafety(t.value) === "HAZARD";
}

/** 比べる元のソルバーのコードを、相対 import が効くよう src/solver/ に一時ファイルとして置いて読み込む */
async function loadBaseline(code: string): Promise<DecideFn | null> {
  const tmp = path.join(path.dirname(SOLVER_PATH), `.baseline-${process.pid}-${Date.now()}.ts`);
  try {
    writeFileSync(tmp, code);
    const mod = (await import(tmp)) as { decideTurnAction?: DecideFn };
    return typeof mod.decideTurnAction === "function" ? mod.decideTurnAction : null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 試合の記録（turns.jsonl）の観測を順に流し、ソルバーが例外を出さず合法手を返すかを確かめる。
 * baselineCode（改修前のソルバー）があれば、同じ地図で両方に手を選ばせ、罠と分かっているマスへ動く手の回数を比べる（増えたら不合格）。
 * 当時の Webマップ・作戦目標は復元しない（両方とも同じ条件）。
 */
export async function verifySolverWithReplay(
  runDir: string,
  opts: { baselineCode?: string | null } = {},
): Promise<ReplayVerificationResult> {
  const solverPath = SOLVER_PATH;
  const turnsPath = path.join(runDir, "turns.jsonl");

  const errors: string[] = [];
  let decideFn: ((wm: WorldMap, phase: "CMD1" | "CMD2", turn: number) => SolverDecision) | null = null;

  try {
    const mod = (await import(`${solverPath}?t=${Date.now()}`)) as {
      decideTurnAction?: (wm: WorldMap, phase: "CMD1" | "CMD2", turn: number) => SolverDecision;
    };
    if (typeof mod.decideTurnAction !== "function") {
      return {
        ok: false,
        turnsTested: 0,
        changedCmd1Count: 0,
        changedCmd2Count: 0,
        errors: ["active-solver.ts does not export a function named decideTurnAction"],
      };
    }
    decideFn = mod.decideTurnAction;
  } catch (err) {
    return {
      ok: false,
      turnsTested: 0,
      changedCmd1Count: 0,
      changedCmd2Count: 0,
      errors: [`Failed to import active-solver.ts: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!existsSync(turnsPath)) {
    try {
      const dummyMap = new WorldMap();
      const d1 = decideFn(dummyMap, "CMD1", 1);
      if (!CMD1_COMMANDS.includes(d1.command as (typeof CMD1_COMMANDS)[number])) {
        errors.push(`Invalid CMD1 returned on smoke test: ${d1.command}`);
      }
      dummyMap.applyObservation("CMD1", "gr", [2, 2, 2, 2, 0, 2, 2, 2, 2], 1);
      const d2 = decideFn(dummyMap, "CMD2", 1);
      if (!CMD2_COMMANDS.includes(d2.command as (typeof CMD2_COMMANDS)[number])) {
        errors.push(`Invalid CMD2 returned on smoke test: ${d2.command}`);
      }
      return {
        ok: errors.length === 0,
        turnsTested: 1,
        changedCmd1Count: 0,
        changedCmd2Count: 0,
        errors,
      };
    } catch (err) {
      return {
        ok: false,
        turnsTested: 0,
        changedCmd1Count: 0,
        changedCmd2Count: 0,
        errors: [`Smoke test threw exception: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  const lines = readFileSync(turnsPath, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const records: TurnRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TurnRecord);
    } catch {
      // skip malformed line
    }
  }

  const worldMap = new WorldMap();
  let changedCmd1Count = 0;
  let changedCmd2Count = 0;
  const baseline = opts.baselineCode ? await loadBaseline(opts.baselineCode) : null;
  if (opts.baselineCode && !baseline) errors.push("比べる元のソルバーを読み込めなかった（罠の比較はしない）");
  let hazardLandings = 0;
  let baselineHazardLandings = 0;
  const hazardExamples: string[] = [];
  const checkHazard = (phase: "CMD1" | "CMD2", turn: number, command: string) => {
    if (!landsOnHazard(worldMap, command)) return;
    hazardLandings += 1;
    let baseCmd: string | null = null;
    try {
      baseCmd = baseline ? baseline(worldMap, phase, turn).command : null;
    } catch {
      baseCmd = null;
    }
    if (hazardExamples.length < 10 && (!baseCmd || !landsOnHazard(worldMap, baseCmd))) hazardExamples.push(`T${turn} ${phase}: ${command}`);
  };
  const checkBaseline = (phase: "CMD1" | "CMD2", turn: number) => {
    if (!baseline) return;
    try {
      if (landsOnHazard(worldMap, baseline(worldMap, phase, turn).command)) baselineHazardLandings += 1;
    } catch {
      // 元のソルバーの例外は比較に数えない
    }
  };

  for (const rec of records) {
    try {
      const d1 = decideFn(worldMap, "CMD1", rec.turn);
      if (!CMD1_COMMANDS.includes(d1.command as (typeof CMD1_COMMANDS)[number])) {
        errors.push(`Turn ${rec.turn}: Invalid CMD1 command '${d1.command}'`);
      }
      checkHazard("CMD1", rec.turn, d1.command);
      checkBaseline("CMD1", rec.turn);
      if (rec.cmd1 && d1.command !== rec.cmd1) {
        changedCmd1Count += 1;
      }

      if (rec.cmd1) {
        worldMap.applyObservation("CMD1", rec.cmd1, rec.cmd1Values, rec.turn);
      }

      const d2 = decideFn(worldMap, "CMD2", rec.turn);
      if (!CMD2_COMMANDS.includes(d2.command as (typeof CMD2_COMMANDS)[number])) {
        errors.push(`Turn ${rec.turn}: Invalid CMD2 command '${d2.command}'`);
      }
      checkHazard("CMD2", rec.turn, d2.command);
      checkBaseline("CMD2", rec.turn);
      if (rec.cmd2 && d2.command !== rec.cmd2) {
        changedCmd2Count += 1;
      }

      if (rec.cmd2) {
        worldMap.applyObservation("CMD2", rec.cmd2, rec.cmd2Values, rec.turn);
      }
    } catch (err) {
      errors.push(
        `Turn ${rec.turn} threw exception: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }

  if (baseline && hazardLandings > baselineHazardLandings) {
    errors.push(`罠と分かっているマスへ動く手が増えた（改修前 ${baselineHazardLandings} 回 → ${hazardLandings} 回。例: ${hazardExamples.join(", ")}）`);
  }
  const loadFailed = !!opts.baselineCode && !baseline;
  return {
    ok: errors.filter((e) => !(loadFailed && e.startsWith("比べる元のソルバーを読み込めなかった"))).length === 0,
    turnsTested: records.length,
    changedCmd1Count,
    changedCmd2Count,
    errors,
    hazardLandings,
    ...(baseline ? { baselineHazardLandings } : {}),
    hazardExamples,
  };
}
