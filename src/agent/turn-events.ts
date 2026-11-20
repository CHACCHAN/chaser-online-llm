import type { WorldMap } from "../memory/world-map";
import type { SolverDecision } from "../solver/active-solver";

export interface BreakpointAssessment {
  shouldBreak: boolean;
  reasons: string[];
}

export function evaluateBreakpoint(options: {
  turn: number;
  worldMap: WorldMap;
  solverDecision: SolverDecision;
}): BreakpointAssessment {
  const reasons: string[] = [];
  const events = options.worldMap.getLastEventFlags();
  const lastGrid = options.worldMap.getLastGrid();

  if (events.newUnknownTiles.length > 0) {
    reasons.push(`NEW_UNKNOWN_TILES(${events.newUnknownTiles.join(",")})`);
  }

  if (events.warped) {
    reasons.push(`WARPED_TO_SEGMENT_${options.worldMap.getSegmentId()}`);
  }

  if (events.blocked) {
    reasons.push("MOVEMENT_BLOCKED");
  }

  if (lastGrid && lastGrid.some((v, idx) => idx !== 4 && v >= 1000)) {
    reasons.push("OPPONENT_NEARBY");
  }

  if (options.solverDecision.triggerHarness) {
    reasons.push(options.solverDecision.triggerReason ?? "SOLVER_REQUESTED_HARNESS");
  } else if (options.solverDecision.confidence < 0.55) {
    reasons.push(`LOW_SOLVER_CONFIDENCE(${options.solverDecision.confidence.toFixed(2)})`);
  }

  return {
    shouldBreak: reasons.length > 0,
    reasons,
  };
}
