import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SOLVER_PATH } from "../paths";
import {
  CMD1_COMMANDS,
  CMD2_COMMANDS,
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
}

export async function verifySolverWithReplay(
  runDir: string,
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

  for (const rec of records) {
    try {
      const d1 = decideFn(worldMap, "CMD1", rec.turn);
      if (!CMD1_COMMANDS.includes(d1.command as (typeof CMD1_COMMANDS)[number])) {
        errors.push(`Turn ${rec.turn}: Invalid CMD1 command '${d1.command}'`);
      }
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

  return {
    ok: errors.length === 0,
    turnsTested: records.length,
    changedCmd1Count,
    changedCmd2Count,
    errors,
  };
}
