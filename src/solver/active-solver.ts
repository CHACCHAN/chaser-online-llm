import {
  CMD1_SPECS,
  CMD2_SPECS,
  classifyTileSafety,
  DIR_DELTA,
  DIRS,
  getHoleRevisitPenalty,
  getPathUtility,
  getTileInfo,
  OPPOSITE_DIR,
  type Cmd1Command,
  type Cmd2Command,
  type Dir,
  type WorldMap,
} from "../memory/world-map";

/** メインエージェントが決める作戦。ソルバーは目標マスへ向かう手を優先する */
export interface AgentPlan {
  target: [number, number];
  note?: string;
}

export interface SolverDecision {
  command: Cmd1Command | Cmd2Command;
  reason: string;
  confidence: number;
  triggerHarness?: boolean;
  triggerReason?: string;
}

/**
 * ハーネス自身が試合中または試合後のメタ進化フェーズで書き換えて進化できる主力ソルバー。
 * 訪問回数ペナルティにより穴(0)同士の往復ループを防ぎ、ワープ/ブラックスターも脱出先として評価する。
 */
export function decideTurnAction(
  worldMap: WorldMap,
  phase: "CMD1" | "CMD2",
  _turn: number,
  plan: AgentPlan | null = null,
): SolverDecision {
  const [x, y] = worldMap.getPosition();
  // 初手も既知の安全マスがあれば通常の経路選択へ。地図がなければ移動せず観測する。
  if (phase === "CMD1" && _turn === 1 && !worldMap.getLastGrid() && !DIRS.some(dir => {
    const [dx, dy] = DIR_DELTA[dir];
    const rec = worldMap.getTile(x + dx, y + dy);
    if (!rec) return false;
    const info = getTileInfo(rec.value);
    return info.known && info.passable && !info.hazard;
  })) {
    return { command: "gr", reason: "Initial scan: no known safe neighbor", confidence: 1 };
  }
  const planStepRaw = plan ? worldMap.firstStepTowards(plan.target[0], plan.target[1]) : null;
  const planStep = planStepRaw && planStepRaw !== "here" ? planStepRaw : null;
  const planTag = plan && planStep ? `plan(@${plan.target[0]},${plan.target[1]} d=${planStep.distance})` : null;
  const events = worldMap.getLastEventFlags();

  if (events.newUnknownTiles.length > 0) {
    const fallback = worldMap.pickSafeFallback(phase) as Cmd1Command | Cmd2Command;
    return {
      command: fallback,
      reason: `New unknown tile(s) detected: ${events.newUnknownTiles.join(",")}`,
      confidence: 0.2,
      triggerHarness: true,
      triggerReason: `UNKNOWN_TILE:${events.newUnknownTiles.join(",")}`,
    };
  }

  const { topValueTargets, nearestFrontiers } = worldMap.findPathTargets();

  if (phase === "CMD1") {
    let bestDir: Dir | null = null;
    // 静止 gr は -40。訪問罰は探索上の優先度であって、静止との得点比較には使わない。
    const stayCost = CMD1_SPECS.gr.estActionCost + getTileInfo(0).score;
    let bestScore = -Infinity;
    let bestIsRouted = false;

    const preferredFirstStep =
      planStep?.dir ??
      (topValueTargets[0] && getPathUtility(topValueTargets[0]) > -35
        ? topValueTargets[0].firstStep
        : nearestFrontiers[0]?.firstStep ?? null);

    for (const dir of DIRS) {
      const [dx, dy] = DIR_DELTA[dir];
      const nx = x + dx;
      const ny = y + dy;
      const rec = worldMap.getTile(nx, ny);
      if (!rec) continue;

      const info = getTileInfo(rec.value);
      if (!info.passable || info.hazard || !info.known) continue;

      // 目標がなければ未踏の安全マスを優先。既訪の穴が唯一の出口でも静止しない。
      const routed = info.score > 0 || preferredFirstStep === dir;
      if (bestIsRouted && !routed) continue;
      let score = info.score + CMD1_SPECS[`gr${dir}`].estActionCost - getHoleRevisitPenalty(rec);
      if (preferredFirstStep === dir) score += 8;
      if (DIRS.some((d2) => {
        if (d2 === OPPOSITE_DIR[dir]) return false;
        const [dx2, dy2] = DIR_DELTA[d2];
        const next = worldMap.getTile(nx + dx2, ny + dy2);
        if (!next) return true; // Observation opportunity, not permission to land there.
        const nextInfo = getTileInfo(next.value);
        return next.visitedCount === 0 && nextInfo.known && nextInfo.passable && !nextInfo.hazard;
      })) score += 12;
      if ((routed && !bestIsRouted) || score > bestScore) {
        bestScore = score;
        bestIsRouted = routed;
        bestDir = dir;
      }
    }

    if (bestDir) {
      const cmd = `gr${bestDir}` as Cmd1Command;
      return {
        command: cmd,
        reason: `${planTag && preferredFirstStep === bestDir ? `${planTag} ` : ""}Forward ${cmd} (priority=${bestScore})`,
        confidence: 0.92,
      };
    }

    return {
      command: "gr",
      reason: `Stay and scan with gr (cost ${stayCost}); no safe forward step beats staying`,
      confidence: 0.9,
    };
  }

  // === CMD2 ===
  const lastDir = worldMap.getLastMoveDir();
  const dirOrder: Dir[] = lastDir
    ? [
        lastDir,
        ...DIRS.filter((d) => d !== lastDir && d !== OPPOSITE_DIR[lastDir]),
        OPPOSITE_DIR[lastDir],
      ]
    : DIRS;

  const bestTarget =
    topValueTargets[0] && getPathUtility(topValueTargets[0]) > -80
      ? topValueTargets[0]
      : null;
  const bestFrontier = nearestFrontiers[0] ?? null;

  let chosenWalk: Cmd2Command | null = null;
  let chosenScore = -Infinity;
  let chosenReason = "";
  let allNeighborsAreHolesOrBlocked = true;

  for (let i = 0; i < dirOrder.length; i++) {
    const dir = dirOrder[i]!;
    const [dx, dy] = DIR_DELTA[dir];
    const rec = worldMap.getTile(x + dx, y + dy);
    const val = rec?.value ?? null;
    const safety = classifyTileSafety(val);

    if (safety === "HAZARD" || safety === "BLOCKED") continue;

    if (val === null || (val !== 0 && getTileInfo(val).score > 0)) {
      allNeighborsAreHolesOrBlocked = false;
    }

    const immediateScore = val !== null ? getTileInfo(val).score + CMD2_SPECS[`w${dir}` as Cmd2Command].estActionCost : 0;
    let routeBonus = 0;
    let reasonTag = "walk";

    if (planStep && planStep.dir === dir) {
      routeBonus += 400;
      reasonTag = planTag!;
    } else if (bestTarget && bestTarget.firstStep === dir) {
      routeBonus += 260 + Math.max(-60, bestTarget.estimatedNetGain);
      reasonTag = `target(${bestTarget.tileLabel}@${bestTarget.x},${bestTarget.y} d=${bestTarget.distance})`;
    } else if (bestFrontier && bestFrontier.firstStep === dir) {
      routeBonus += 130 - bestFrontier.distance * 5;
      reasonTag = `frontier(@${bestFrontier.x},${bestFrontier.y} d=${bestFrontier.distance})`;
    }

    // 訪問回数が多いマスへの再突入と直前の逆走を抑止して往復振動を防ぐ
    const revisitPenalty = getHoleRevisitPenalty(rec);
    const reversePenalty = lastDir && dir === OPPOSITE_DIR[lastDir] ? 12 : 0;
    const inertiaBonus = (dirOrder.length - i) * 0.5;
    const total = immediateScore + routeBonus + inertiaBonus - revisitPenalty - reversePenalty;

    if (total > chosenScore) {
      chosenScore = total;
      chosenWalk = `w${dir}` as Cmd2Command;
      chosenReason = `${reasonTag} immediate=${immediateScore}`;
    }
  }

  if (allNeighborsAreHolesOrBlocked) {
    for (const keiCmd of ["keilu", "keiru", "keild", "keird"] as Cmd2Command[]) {
      const [kdx, kdy] = CMD2_SPECS[keiCmd].move;
      const kRec = worldMap.getTile(x + kdx, y + kdy);
      if (!kRec) continue;
      const kInfo = getTileInfo(kRec.value);
      if (kInfo.passable && !kInfo.hazard && kInfo.score >= 150) {
        return {
          command: keiCmd,
          reason: `Knight jump ${keiCmd} over holes/traps onto high-value ${kInfo.label}(+${kInfo.score})`,
          confidence: 0.85,
        };
      }
    }
  }

  if (chosenWalk) {
    const stuckInHoles = !bestTarget && !bestFrontier && allNeighborsAreHolesOrBlocked;
    return {
      command: chosenWalk,
      reason: chosenReason,
      confidence: stuckInHoles ? 0.35 : 0.9,
      triggerHarness: stuckInHoles,
      triggerReason: stuckInHoles ? "STUCK_IN_HOLES_NO_FRONTIER" : undefined,
    };
  }

  for (const keiCmd of ["keilu", "keiru", "keild", "keird"] as Cmd2Command[]) {
    const [kdx, kdy] = CMD2_SPECS[keiCmd].move;
    const kRec = worldMap.getTile(x + kdx, y + kdy);
    const safety = classifyTileSafety(kRec?.value ?? null);
    if (safety !== "HAZARD" && safety !== "BLOCKED") {
      return {
        command: keiCmd,
        reason: `Emergency knight escape ${keiCmd} from surrounded position`,
        confidence: 0.4,
        triggerHarness: true,
        triggerReason: "SURROUNDED_BY_HAZARDS",
      };
    }
  }

  return {
    command: "du",
    reason: "Completely blocked; stationary remote scan du",
    confidence: 0.3,
    triggerHarness: true,
    triggerReason: "COMPLETELY_BLOCKED",
  };
}
