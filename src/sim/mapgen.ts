import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRoomProfile, knownTotalTurns } from "../memory/knowledge-store";
import { getTileInfo } from "../memory/world-map";
import { SIM_MAPS_DIR, SIM_PROFILES_PATH } from "../paths";
import { isPortalTile, warpDelta } from "./engine";
import { pick, pickWeighted, randInt, type Rng } from "./rng";

/**
 * シミュレータの地図を作る。毎回ランダムに作り（同じ seed なら同じ地図）、本物の地図（試合中の Webマップから保存）も混ぜる。
 * 作り方の設定は knowledge/sim-profiles.json（エージェントが本物と見比べて直してよい）。
 */

type Range = [number, number];

export interface MapProfile {
  size: Range;
  turns: Range;
  players: Range;
  /** 全体マップ（Webマップ）が見える割合 */
  webMap: number;
  /** 本物の地図を使う割合（その部屋の本物が保存されている時） */
  realMapShare: number;
  fill: Record<string, number>;
  blobs: { tiles: number[]; count: Range; radius: Range; density: number }[];
  lines: { tiles: number[]; count: Range; length: Range; width: Range }[];
  warps: Range;
  blackstars: number;
}

/** 1試合分の設定（地図・開始位置・ターン数） */
export interface Scenario {
  name: string;
  grid: number[][];
  starts: { id: number; x: number; y: number }[];
  /** starts の何番目が自分か */
  self: number;
  totalTurns: number;
  webMap: boolean;
}

/** 保存した本物の地図（試合中の Webマップの最初の1枚。プレイヤーは除いてある） */
export interface SavedMap {
  room: number;
  runId: string;
  grid: number[][];
  totalTurns: number | null;
  players: number;
  savedAt: string;
}

export function loadProfile(room?: number | null): MapProfile {
  const file = JSON.parse(readFileSync(SIM_PROFILES_PATH, "utf-8")) as { default: MapProfile; rooms?: Record<string, Partial<MapProfile>> };
  const base: MapProfile = { ...file.default };
  if (room === undefined || room === null) return base;
  const over = file.rooms?.[String(room)] ?? {};
  const merged: MapProfile = { ...base, ...over, fill: over.fill ? { ...base.fill, ...over.fill } : base.fill };
  // ルームの実測（大きさ・ターン数・Webマップの有無）があればそれに合わせる（sim-profiles.json に書いてあればそちらが優先）
  const rp = getRoomProfile(room);
  if (!over.size && rp.mapDimensions) merged.size = [Math.min(...rp.mapDimensions), Math.max(...rp.mapDimensions)];
  const total = rp.totalTurns ?? knownTotalTurns(room);
  if (!over.turns && total) merged.turns = [total, total];
  if (over.webMap === undefined && rp.webMapAvailable !== null) merged.webMap = rp.webMapAvailable ? 1 : 0;
  return merged;
}

/** 本物の地図を保存する（試合中に最初に取れた Webマップ。プレイヤーの番号は土に置き換える） */
export function saveRealMap(room: number, runId: string, webGrid: number[][], totalTurns: number | null): string | null {
  if (webGrid.length < 5 || (webGrid[0]?.length ?? 0) < 5) return null;
  let players = 0;
  const grid = webGrid.map((row) => row.map((v) => {
    if (v >= 1000) {
      players += 1;
      return 0;
    }
    return v;
  }));
  const dir = path.join(SIM_MAPS_DIR, `room${room}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  const saved: SavedMap = { room, runId, grid, totalTurns, players: Math.max(1, players), savedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(saved));
  return file;
}

export function loadRealMaps(room?: number | null): SavedMap[] {
  if (!existsSync(SIM_MAPS_DIR)) return [];
  const dirs = room !== undefined && room !== null ? [`room${room}`] : readdirSync(SIM_MAPS_DIR).filter((d) => d.startsWith("room"));
  const out: SavedMap[] = [];
  for (const d of dirs) {
    const dir = path.join(SIM_MAPS_DIR, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as SavedMap);
      } catch {
        // 壊れたファイルは使わない
      }
    }
  }
  return out;
}

const safeStart = (v: number) => {
  const info = getTileInfo(v);
  return info.passable && !info.hazard && !isPortalTile(v);
};

function placeStarts(rng: Rng, grid: number[][], n: number): { id: number; x: number; y: number }[] {
  const h = grid.length;
  const w = grid[0]!.length;
  const starts: { id: number; x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let tries = 0; tries < 500; tries++) {
      const x = randInt(rng, 0, w - 1);
      const y = randInt(rng, 0, h - 1);
      if (!safeStart(grid[y]![x]!) || starts.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) < 3)) continue;
      starts.push({ id: 1000 * (i + 1), x, y });
      break;
    }
  }
  if (starts.length === 0) {
    grid[0]![0] = 0;
    starts.push({ id: 1000, x: 0, y: 0 });
  }
  return starts;
}

/** 設定から新しい地図を作る */
export function generateGrid(rng: Rng, profile: MapProfile, w: number, h: number): number[][] {
  const fill = Object.entries(profile.fill).map(([k, v]) => [Number(k), v] as const);
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => pickWeighted(rng, fill)));
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) grid[y]![x] = v;
  };
  for (const line of profile.lines) {
    const n = randInt(rng, line.count[0], line.count[1]);
    for (let i = 0; i < n; i++) {
      const len = randInt(rng, line.length[0], line.length[1]);
      const width = randInt(rng, line.width[0], line.width[1]);
      let x = randInt(rng, 0, w - 1);
      let y = randInt(rng, 0, h - 1);
      const horizontal = rng() < 0.5;
      const t = pick(rng, line.tiles);
      for (let k = 0; k < len; k++) {
        for (let j = 0; j < width; j++) set(horizontal ? x : x + j, horizontal ? y + j : y, t);
        // 少し曲がりながら伸びる
        if (horizontal) {
          x += 1;
          if (rng() < 0.2) y += rng() < 0.5 ? -1 : 1;
        } else {
          y += 1;
          if (rng() < 0.2) x += rng() < 0.5 ? -1 : 1;
        }
      }
    }
  }
  for (const blob of profile.blobs) {
    const n = randInt(rng, blob.count[0], blob.count[1]);
    for (let i = 0; i < n; i++) {
      const r = randInt(rng, blob.radius[0], blob.radius[1]);
      const cx = randInt(rng, 0, w - 1);
      const cy = randInt(rng, 0, h - 1);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= r && rng() < blob.density) set(cx + dx, cy + dy, pick(rng, blob.tiles));
        }
      }
    }
  }
  // ワープ: 行き先が場内になる番号だけ置く
  const nWarps = randInt(rng, profile.warps[0], profile.warps[1]);
  for (let i = 0; i < nWarps; i++) {
    for (let tries = 0; tries < 30; tries++) {
      const t = pick(rng, [20, 21, 22, 23, 30, 31, 32, 33, 40, 41, 42, 43, 50, 51, 52, 53]);
      const d = warpDelta(t)!;
      const x = randInt(rng, 0, w - 1);
      const y = randInt(rng, 0, h - 1);
      if (x + d[0] < 0 || x + d[0] >= w || y + d[1] < 0 || y + d[1] >= h) continue;
      grid[y]![x] = t;
      break;
    }
  }
  if (rng() < profile.blackstars) {
    for (const t of [60, 61, 62, 63]) set(randInt(rng, 0, w - 1), randInt(rng, 0, h - 1), t);
  }
  return grid;
}

/** 本物の地図を少し変える（点のあるマスの一部を近くへ動かす）。同じ地図ばかり覚えないように */
function perturb(rng: Rng, src: number[][]): number[][] {
  const grid = src.map((r) => [...r]);
  const h = grid.length;
  const w = grid[0]!.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = grid[y]![x]!;
      if (getTileInfo(v).score <= 10 || isPortalTile(v) || rng() > 0.3) continue;
      const nx = x + randInt(rng, -2, 2);
      const ny = y + randInt(rng, -2, 2);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || isPortalTile(grid[ny]![nx]!)) continue;
      grid[y]![x] = grid[ny]![nx]!;
      grid[ny]![nx] = v;
    }
  }
  return grid;
}

/** 1試合分の設定を作る。room を渡すとそのルームに似せる（本物の地図があれば realMapShare の割合で使う） */
export function makeScenario(rng: Rng, opts: { room?: number | null; profile?: MapProfile; realMaps?: SavedMap[] } = {}): Scenario {
  const profile = opts.profile ?? loadProfile(opts.room);
  const real = opts.realMaps ?? (opts.room !== undefined && opts.room !== null ? loadRealMaps(opts.room) : []);
  let grid: number[][];
  let name: string;
  let players = randInt(rng, profile.players[0], profile.players[1]);
  let totalTurns = randInt(rng, profile.turns[0], profile.turns[1]);
  if (real.length > 0 && rng() < profile.realMapShare) {
    const m = pick(rng, real);
    grid = perturb(rng, m.grid);
    name = `real:${m.room}/${m.runId}`;
    players = Math.max(1, m.players);
    if (m.totalTurns) totalTurns = m.totalTurns;
  } else {
    const w = randInt(rng, profile.size[0], profile.size[1]);
    const h = rng() < 0.7 ? w : randInt(rng, profile.size[0], profile.size[1]);
    grid = generateGrid(rng, profile, w, h);
    name = `gen:${w}x${h}`;
  }
  const starts = placeStarts(rng, grid, players);
  return { name, grid, starts, self: randInt(rng, 0, starts.length - 1), totalTurns, webMap: rng() < profile.webMap };
}
