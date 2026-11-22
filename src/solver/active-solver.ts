import {
  CMD2_SPECS,
  DIR_DELTA,
  DIRS,
  getHoleRevisitPenalty,
  getTileInfo,
  OPPOSITE_DIR,
  type Cmd1Command,
  type Cmd2Command,
  type Dir,
  type WorldMap,
} from "../memory/world-map";

/** メインエージェントが指定する、現在の区画の経由点。 */
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

const key = (x: number, y: number) => `${x},${y}`;
const isPortal = (value: number) => {
  const name = getTileInfo(value).name;
  return name === "warp" || name === "blackstar";
};
const DIGS = ["du", "dr", "dd", "dl"] as const;
const KNIGHTS = ["keilu", "keiru", "keild", "keird"] as const;
const PUTS = (Object.keys(CMD2_SPECS) as Cmd2Command[]).filter(cmd =>
  CMD2_SPECS[cmd].putDir || CMD2_SPECS[cmd].put3Dir);

interface Route {
  x: number;
  y: number;
  steps: number;
  cost: number;
  first: Dir | null;
  value: number;
}

export function decideTurnAction(
  worldMap: WorldMap,
  phase: "CMD1" | "CMD2",
  turn: number,
  plan: AgentPlan | null = null,
): SolverDecision {
  const [x, y] = worldMap.getPosition();
  const grid = worldMap.getLastGrid();
  const events = worldMap.getLastEventFlags();
  const walk = (dir: Dir, reason: string): SolverDecision => ({
    command: phase === "CMD1" ? `gr${dir}` : `w${dir}`, reason, confidence: 0.92,
  });
  const scan = (reason: string, triggerReason?: string): SolverDecision => ({
    command: phase === "CMD1" ? "gr" : DIGS.reduce((best, cmd) =>
      unknownScanCells(cmd) > unknownScanCells(best) ? cmd : best, DIGS[0] as typeof DIGS[number]),
    reason, confidence: 0.5, triggerHarness: !!triggerReason, triggerReason,
  });
  const unknownScanCells = (cmd: typeof DIGS[number]) => {
    const [dx, dy] = CMD2_SPECS[cmd].obsOffset;
    let unseen = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if (!worldMap.getTile(x + dx + ox, y + dy + oy)) unseen++;
    }
    return unseen;
  };

  // CMD1 の中心が入口番号なら、周囲3×3も入口側の可能性がある。
  // 見た目が一致してワープ検出が遅れる場合も、座標つきの手を続けない。
  if (grid?.[4] !== undefined && isPortal(grid[4])) {
    return scan("Portal center: position not confirmed; observe without moving", "PORTAL_POSITION_UNCONFIRMED");
  }
  const warped = events.warped;
  const enemies = warped ? [] : worldMap.getEnemySightings().filter(e => {
    const dx = e.x - x, dy = e.y - y;
    if ((!dx && !dy) || e.lastSeenTurn > turn || e.lastSeenTurn < turn - (phase === "CMD1" ? 1 : 0)) return false;
    const observed = phase === "CMD2" && Math.abs(dx) <= 1 && Math.abs(dy) <= 1
      ? grid?.[(dy + 1) * 3 + dx + 1] : undefined;
    return observed === undefined || observed === e.tileId;
  });
  const occupied = new Set(enemies.map(e => key(e.x, e.y)));
  const tileValue = (tx: number, ty: number) => {
    const dx = tx - x;
    const dy = ty - y;
    // CMD1 の中心付き観測は、帰還区画やWebマップの古いマスより優先する。
    if (phase === "CMD2" && (dx || dy) && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const observed = grid?.[(dy + 1) * 3 + dx + 1];
      if (observed !== undefined) return observed;
      if (warped) return undefined;
    }
    return worldMap.getTile(tx, ty)?.value;
  };
  const safeValue = (tx: number, ty: number) => {
    if (occupied.has(key(tx, ty))) return undefined;
    const value = tileValue(tx, ty);
    if (value === undefined || value >= 1000) return undefined;
    const info = getTileInfo(value);
    return info.known && info.passable && !info.hazard ? value : undefined;
  };

  let put: Cmd2Command | undefined;
  let putScore = -Infinity;
  for (const cmd of PUTS) {
    const spec = CMD2_SPECS[cmd];
    const [dx, dy] = DIR_DELTA[(spec.putDir ?? spec.put3Dir)!];
    if (!occupied.has(key(x + dx, y + dy))) continue;
    const [mx, my] = spec.move;
    const value = safeValue(x + mx, y + my);
    if (value === undefined || isPortal(value)) continue;
    const score = getTileInfo(value).score + spec.estActionCost;
    if (score > putScore) { put = cmd; putScore = score; }
  }
  if (put) return phase === "CMD2"
    ? { command: put, reason: "Put toward fresh adjacent opponent with safe landing", confidence: 0.95 }
    : { command: "gr", reason: "Recheck adjacent opponent before CMD2 put", confidence: 0.9 };

  const origin: Route = { x, y, steps: 0, cost: 0, first: null, value: 0 };
  const lastDir = worldMap.getLastMoveDir();
  const dirs = lastDir ? [lastDir, ...DIRS.filter(d => d !== lastDir)] : DIRS;
  if (enemies.some(e => Math.abs(e.x - x) + Math.abs(e.y - y) <= 5)) {
    // BFS to a square adjacent to the enemy; never route through its square or a portal.
    const queue = [origin];
    const seen = new Set([key(x, y)]);
    for (const node of queue) {
      if (node.first && DIRS.some(d => {
        const [dx, dy] = DIR_DELTA[d];
        return occupied.has(key(node.x + dx, node.y + dy));
      })) return walk(node.first, `Pursue nearby opponent (${node.steps} steps to adjacency)`);
      if (node.steps >= 4) continue;
      for (const dir of dirs) {
        const [dx, dy] = DIR_DELTA[dir];
        const nx = node.x + dx, ny = node.y + dy, id = key(nx, ny);
        const value = safeValue(nx, ny);
        if (seen.has(id) || value === undefined || isPortal(value)) continue;
        seen.add(id);
        queue.push({ x: nx, y: ny, steps: node.steps + 1, cost: 0, first: node.first ?? dir, value });
      }
    }
  }

  // ワープ直後は、同じ座標に見えても前区画の経路を使わない。
  if (warped) plan = null;
  const targets = new Map([[key(x, y), origin]]);
  const queue = [origin];
  let reward: Route | null = null, frontier: Route | null = null;
  let portal: Route | null = null, fallback: Route | null = null, pickup: Route | null = null;
  let rewardScore = 0, frontierScore = -Infinity;
  const targetKey = plan ? key(...plan.target) : null;
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.steps - b.steps);
    const node = queue.shift()!;
    const id = key(node.x, node.y);
    if (targets.get(id) !== node) continue;
    if (node.first && id === targetKey) {
      return walk(node.first, `plan(@${id} d=${node.steps})`);
    }
    if (node.first && isPortal(node.value)) {
      portal ??= node;
      continue; // portals are terminal waypoints, never shortcuts through the current frame
    }
    const remaining = DIRS.map(dir => {
      const [dx, dy] = DIR_DELTA[dir];
      return [node.x + dx, node.y + dy, dir] as const;
    });
    if (node.first) {
      fallback ??= node;
      const gain = getTileInfo(node.value).score;
      if (node.steps === 1 && gain > 0 && (!pickup || gain > getTileInfo(pickup.value).score)) pickup = node;
      // Nearby onward rewards beat a similar isolated pickup. Charge for revisits
      // and for exiting a dead end, without treating holes as walls.
      let onward = 0;
      let exits = 0;
      for (const [nx, ny] of remaining) {
        const v = safeValue(nx, ny);
        if (v === undefined || isPortal(v) || (nx === x && ny === y)) continue;
        exits++;
        if ((worldMap.getTile(nx, ny)?.visitedCount ?? 0) === 0) onward = Math.max(onward, getTileInfo(v).score);
      }
      const utility = gain - node.cost + (gain > 0 ? Math.min(80, onward / 4) - (exits ? 0 : 15) : 0);
      if (gain > 0 && utility > rewardScore) { reward = node; rewardScore = utility; }
      const unknown = remaining.filter(([nx, ny]) => tileValue(nx, ny) === undefined && !occupied.has(key(nx, ny)));
      if (unknown.length) {
        const openSide = unknown.some(([nx, ny]) => !DIRS.some(dir => {
          const [dx, dy] = DIR_DELTA[dir];
          return tileValue(nx + dx, ny + dy) === 12 && tileValue(nx + 2 * dx, ny + 2 * dy) === 12;
        }));
        const priority = -node.cost + (openSide ? 1 : 0);
        if (priority > frontierScore) { frontier = node; frontierScore = priority; }
      }
    }
    if (node.steps >= (warped ? 1 : plan ? 60 : 35)) continue;
    for (const [nx, ny, dir] of remaining) {
      const value = safeValue(nx, ny);
      if (value === undefined) continue;
      const rec = worldMap.getTile(nx, ny);
      const reverse = !node.first && lastDir && dir === OPPOSITE_DIR[lastDir] ? 8 : 0;
      const cost = node.cost + 10 + Math.max(0, -getTileInfo(value).score) +
        (value === 0 && rec?.value === 0 ? 2 * getHoleRevisitPenalty(rec) : 0) + reverse;
      const id = key(nx, ny);
      if (cost >= (targets.get(id)?.cost ?? Infinity)) continue;
      const next = { x: nx, y: ny, steps: node.steps + 1, cost, first: node.first ?? dir, value };
      targets.set(id, next);
      queue.push(next);
    }
  }

  const route = reward ?? pickup ?? frontier ?? (!warped ? portal : null);
  if (route?.first) return walk(route.first,
    `${route === reward || route === pickup ? "Collect" : route === frontier ? "Observe frontier from" : "Exit via portal"} @${route.x},${route.y}`);

  if (phase === "CMD2" && !warped) {
    let best: { cmd: Cmd2Command; score: number } | null = null;
    for (const cmd of KNIGHTS) {
      const [dx, dy] = CMD2_SPECS[cmd].move;
      const value = safeValue(x + dx, y + dy);
      if (value === undefined || isPortal(value)) continue;
      const rec = worldMap.getTile(x + dx, y + dy);
      const gain = getTileInfo(value).score;
      if (fallback && gain < 400) continue;
      const score = gain + CMD2_SPECS[cmd].estActionCost - getHoleRevisitPenalty(rec);
      if (!best || score > best.score) best = { cmd, score };
    }
    if (best) return { command: best.cmd, reason: "Knight jump onto known safe tile", confidence: 0.8 };
  }
  if (fallback?.first) return { ...walk(fallback.first, "Known safe exit; no reachable reward or frontier"),
    triggerHarness: true, triggerReason: "STUCK_IN_HOLES_NO_FRONTIER" };
  return scan("No confirmed safe move; observe without moving", "COMPLETELY_BLOCKED");
}
