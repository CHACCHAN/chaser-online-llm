import { numSetting } from "../settings";
import type { OfficialResult } from "../client";
import { getRoomProfile, saveRoomProfile, upsertTileDefinition } from "../memory/knowledge-store";
import { CMD2_SPECS, type Cmd2Command, getTileInfo } from "../memory/world-map";
import type { RunSummary, TurnRecord } from "../runner";

export interface DiagnosticIssue {
  code:
    | "HOLE_REVISIT_LOSS"
    | "HIGH_FATIGUE_OVERUSE"
    | "MISSED_DOUBLE_COLLECT"
    | "CMD1_HOLE_STEP"
    | "HAZARD_HIT"
    | "ITEM_SCORE_DISCREPANCY"
    | "ACTION_SCORE_DISCREPANCY"
    | "UNKNOWN_TILES_ENCOUNTERED"
    | "FALLBACK_TRIGGERED";
  severity: "high" | "medium" | "low";
  estimatedPointLoss: number;
  description: string;
  affectedTurns: number[];
  recommendation: string;
}

export interface DiagnosticReport {
  runId: string;
  room: number;
  turns: number;
  officialTotalScore: number | null;
  estimatedTotalScore: number;
  itemPointDiff: number | null;
  actionPointDiff: number | null;
  inferredTiles: { tileValue: number; inferredScore: number }[];
  issues: DiagnosticIssue[];
  markdownReport: string;
}

export function analyzeMatchRun(
  summary: RunSummary,
  turns: TurnRecord[],
  official: OfficialResult | null,
): DiagnosticReport {
  const issues: DiagnosticIssue[] = [];
  const inferredTiles: { tileValue: number; inferredScore: number }[] = [];

  if (summary.holeRevisits > 0) {
    const holeLoss = summary.holeRevisits * 20;
    issues.push({
      code: "HOLE_REVISIT_LOSS",
      severity: holeLoss >= 200 ? "high" : "medium",
      estimatedPointLoss: holeLoss,
      description: `Stepped on visited hole (0) tiles ${summary.holeRevisits} times (-20 pts each + action cost).`,
      affectedTurns: [],
      recommendation:
        "In src/solver/active-solver.ts, increase penalty for revisiting tile 0 or look further ahead in findPathTargets to prefer one-way sweeps through unexplored frontiers.",
    });
  }

  const highFatigueTurns: number[] = [];
  for (const t of turns) {
    if (!t.cmd2) continue;
    const spec = CMD2_SPECS[t.cmd2 as Cmd2Command];
    if (spec?.highFatigue) {
      highFatigueTurns.push(t.turn);
    }
  }
  if (highFatigueTurns.length > 0) {
    const fatigueLoss = highFatigueTurns.length * 990;
    issues.push({
      code: "HIGH_FATIGUE_OVERUSE",
      severity: highFatigueTurns.length >= 2 ? "high" : "low",
      estimatedPointLoss: fatigueLoss,
      description: `Used high-fatigue put&walk (-1000) CMD2 commands ${highFatigueTurns.length} times on turns: ${highFatigueTurns.join(", ")}.`,
      affectedTurns: highFatigueTurns,
      recommendation:
        "Restrict high-fatigue commands (kei*, d*, p*) strictly to situations where immediate tile gain >= +250 or all 4 cardinal directions are blocked/hazards.",
    });
  }

  const missedDoubleTurns: number[] = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i];
    if (!prev || !cur || cur.cmd1 !== "gr") continue;
    const grid = prev.cmd2Values;
    if (!grid || grid.length < 9) continue;
    const cardinalIndices = [1, 3, 5, 7];
    const hadPositiveCardinal = cardinalIndices.some((idx) => {
      const v = grid[idx];
      if (v === undefined) return false;
      const info = getTileInfo(v);
      return info.known && info.passable && !info.hazard && info.score > 0;
    });
    if (hadPositiveCardinal) {
      missedDoubleTurns.push(cur.turn);
    }
  }
  if (missedDoubleTurns.length > 0) {
    issues.push({
      code: "MISSED_DOUBLE_COLLECT",
      severity: missedDoubleTurns.length >= 3 ? "high" : "medium",
      estimatedPointLoss: missedDoubleTurns.length * 15,
      description: `Selected stationary 'gr' on ${missedDoubleTurns.length} turns even though an adjacent cardinal tile had positive points.`,
      affectedTurns: missedDoubleTurns,
      recommendation:
        "Ensure CMD1 selects gru/grd/grl/grr whenever any adjacent cardinal tile is known, safe, and has score > 0.",
    });
  }

  if (summary.hazardHits > 0) {
    issues.push({
      code: "HAZARD_HIT",
      severity: "high",
      estimatedPointLoss: summary.hazardHits * 800,
      description: `Hit hazard tiles (4 Geode / 12 Abyss) ${summary.hazardHits} times.`,
      affectedTurns: [],
      recommendation:
        "Never move onto tiles 4 or 12, and never blindly move with gr* or kei* onto unseen tiles when safe tiles exist.",
    });
  }

  let itemPointDiff: number | null = null;
  let actionPointDiff: number | null = null;

  if (official) {
    itemPointDiff = official.itemPoint - summary.estimatedScore.estimatedItemScore;
    actionPointDiff = official.actionPoint - summary.estimatedScore.estimatedActionScore;

    if (Math.abs(itemPointDiff) > 5) {
      issues.push({
        code: "ITEM_SCORE_DISCREPANCY",
        severity: Math.abs(itemPointDiff) >= 100 ? "high" : "medium",
        estimatedPointLoss: Math.max(0, -itemPointDiff),
        description: `Official itemPoint (${official.itemPoint}) differs from estimatedItemScore (${summary.estimatedScore.estimatedItemScore}) by ${itemPointDiff}.`,
        affectedTurns: [],
        recommendation:
          "Check pickups for unknown tiles or warp landing score discrepancies and update knowledge/tiles.json.",
      });

      const unknownPicked = Object.entries(summary.tilePickups).filter(([k, count]) => {
        const info = getTileInfo(Number(k));
        return !info.known && count > 0;
      });
      if (unknownPicked.length === 1) {
        const [tileKey, count] = unknownPicked[0]!;
        const tileVal = Number(tileKey);
        const inferredScore = Math.round(itemPointDiff / count);
        inferredTiles.push({ tileValue: tileVal, inferredScore });
        upsertTileDefinition(tileVal, {
          name: `inferred_${tileVal}`,
          label: `推論タイル(${tileVal})`,
          score: inferredScore,
          passable: true,
          hazard: inferredScore <= -200,
          symbol: inferredScore > 0 ? "+" : "!",
          known: true,
          source: "inferred",
          notes: `Auto-inferred from run ${summary.runId} (itemPointDiff=${itemPointDiff}, count=${count})`,
        });
      }
    }

    if (Math.abs(actionPointDiff) > 30) {
      issues.push({
        code: "ACTION_SCORE_DISCREPANCY",
        severity: "low",
        estimatedPointLoss: Math.max(0, -actionPointDiff),
        description: `Official actionPoint (${official.actionPoint}) differs from estimatedActionScore (${summary.estimatedScore.estimatedActionScore}) by ${actionPointDiff}.`,
        affectedTurns: [],
        recommendation:
          "Review commandCounts vs fatigue cost table in src/memory/world-map.ts.",
      });
    }
  }

  if (summary.unknownTiles.length > 0) {
    issues.push({
      code: "UNKNOWN_TILES_ENCOUNTERED",
      severity: "medium",
      estimatedPointLoss: 0,
      description: `Encountered unknown tile IDs during match: ${summary.unknownTiles.join(", ")}.`,
      affectedTurns: [],
      recommendation:
        "Use `bun src/cli.ts reference --tile <id>` or inspect itemPointDiff to register these tile IDs in knowledge/tiles.json.",
    });
  }

  if (summary.fallbackTurns > 0) {
    issues.push({
      code: "FALLBACK_TRIGGERED",
      severity: "medium",
      estimatedPointLoss: summary.fallbackTurns * 20,
      description: `Fallback safety move was triggered on ${summary.fallbackTurns} turns.`,
      affectedTurns: turns.filter((t) => t.usedFallback).map((t) => t.turn),
      recommendation:
        "Ensure solver and breakpoint interventions return valid commands promptly.",
    });
  }

  const profile = getRoomProfile(summary.room);
  profile.matchesPlayed += 1;
  const achievedScore = official?.totalScore ?? summary.estimatedScore.estimatedTotalScore;
  // 試合になっていない（待機切れ等）回は最高記録として扱わない
  const isRealMatch = summary.turns >= numSetting("AGENT_EVOLVE_MIN_TURNS", { min: 0, integer: true });
  if (isRealMatch && (profile.highScore === null || achievedScore > profile.highScore)) {
    profile.highScore = achievedScore;
    profile.bestRunId = summary.runId;
  }
  for (const u of summary.unknownTiles) {
    if (!profile.discoveredTiles.includes(u)) {
      profile.discoveredTiles.push(u);
    }
  }
  saveRoomProfile(profile);

  const mdLines: string[] = [
    `# Match Root-Cause Diagnosis (${summary.runId})`,
    `- **Room**: ${summary.room} | **Turns**: ${summary.turns} | **Game Over Reason**: ${summary.gameOverReason ?? "N/A"}`,
    `- **Official Total Score**: ${official?.totalScore ?? "N/A"} (Action: ${official?.actionPoint ?? "N/A"}, Item: ${official?.itemPoint ?? "N/A"}, Put: ${official?.putPoint ?? "N/A"})`,
    `- **Estimated Total Score**: ${summary.estimatedScore.estimatedTotalScore} (Action: ${summary.estimatedScore.estimatedActionScore}, Item: ${summary.estimatedScore.estimatedItemScore})`,
    `- **Room High Score So Far**: ${profile.highScore ?? "N/A"} (Best Run: ${profile.bestRunId ?? "N/A"})`,
    `- **Pickups**: ${JSON.stringify(summary.tilePickups)}`,
    `- **Command Counts**: ${JSON.stringify(summary.commandCounts)}`,
    "",
    "## Identified Issues & Improvement Targets",
  ];

  if (issues.length === 0) {
    mdLines.push("- No major point-loss anomalies detected. Focus on route optimization and higher-value cluster collection.");
  } else {
    for (const iss of issues) {
      mdLines.push(
        `- **[${iss.severity.toUpperCase()}] ${iss.code}** (Est. Loss: ~${iss.estimatedPointLoss} pts): ${iss.description}`,
        `  - *Actionable Fix*: ${iss.recommendation}`,
      );
    }
  }

  if (inferredTiles.length > 0) {
    mdLines.push(
      "",
      "## Auto-Inferred Tiles Registered to tiles.json",
      ...inferredTiles.map((t) => `- Tile \`${t.tileValue}\` -> inferred score \`${t.inferredScore}\``),
    );
  }

  return {
    runId: summary.runId,
    room: summary.room,
    turns: summary.turns,
    officialTotalScore: official?.totalScore ?? null,
    estimatedTotalScore: summary.estimatedScore.estimatedTotalScore,
    itemPointDiff,
    actionPointDiff,
    inferredTiles,
    issues,
    markdownReport: mdLines.join("\n"),
  };
}
