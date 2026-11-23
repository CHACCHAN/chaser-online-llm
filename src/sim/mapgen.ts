import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRoomProfile, knownTotalTurns, loadTilesKnowledge } from "../memory/knowledge-store";
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
  /** knowledge/tiles.json にあって fill に無いタイル（新しく分かったアイテムなど）を混ぜる重み（0 なら混ぜない） */
  otherTiles?: number;
  blobs: { tiles: number[]; count: Range; radius: Range; density: number }[];
  lines: { tiles: number[]; count: Range; length: Range; width: Range }[];
  warps: Range;
  blackstars: number;
  /**
   * 仕切り: 奈落などの帯で地図を端から端まで区切る（本物の例: room720 は奈落(12)の1マス幅の縦横の帯で4つに区切られている）。
   * 横の帯は桂馬（縦に2マス）で越えられるが、縦の帯はワープでしか越えられない。区切りごとに、越える向きのワープを portals 個置く。
   * 書かなければ DEFAULT_PARTITIONS。chance = 0 で作らない
   */
  partitions?: { chance: number; tiles: number[]; count: Range; width: Range; portals: Range };
  /**
   * 囲み: 点の高いアイテムをジオード(4)などで1重に囲む（桂馬で中へ飛び込めば取れる。歩くと罠を踏む）。
   * items を書かなければ fill の中で点の高い3種。書かなければ DEFAULT_ENCLOSURES。count [0,0] で作らない
   */
  enclosures?: { count: Range; tiles: number[]; items?: number[]; inner: Range };
  /**
   * 相手にアイテム・土を置いて当てた時に動く得点（当てた側 +、当てられた側 −）。公式の値は未確認の仮の値。
   * 実測: room455 で6ターンのうちにプットダメージ -44990。分かったら合わせる
   */
  putHit?: number;
  /**
   * ターン数のばらつき（割合）。ルームの実測のターン数・本物の地図のターン数を、毎回 ±この割合でずらす（既定 DEFAULT_TURNS_JITTER）。
   * 残りターンで変わる判断（終盤・出口のワープ）を、決まったターン数だけに合わせないため。0 でずらさない
   */
  turnsJitter?: number;
}

export const DEFAULT_TURNS_JITTER = 0.3;

export const DEFAULT_PARTITIONS: NonNullable<MapProfile["partitions"]> = { chance: 0.3, tiles: [12], count: [1, 2], width: [1, 1], portals: [1, 2] };
export const DEFAULT_ENCLOSURES: NonNullable<MapProfile["enclosures"]> = { count: [0, 3], tiles: [4], inner: [0, 1] };

/** 1試合分の設定（地図・開始位置・ターン数） */
export interface Scenario {
  name: string;
  grid: number[][];
  starts: { id: number; x: number; y: number }[];
  /** starts の何番目が自分か */
  self: number;
  totalTurns: number;
  webMap: boolean;
  /** 置いて当てた時の得点（MapProfile.putHit） */
  putHit?: number;
  /** 打ち切り（SIM_MAX_TURNS）より長い時に、打ち切りの何割で終えるか（0.5〜1。毎回同じターン数にならないように） */
  capFrac?: number;
}

/**
 * シミュレータで実際に打つターン数。打ち切り（SIM_MAX_TURNS）より長い地図は、打ち切りちょうどではなく打ち切りの 5〜10 割のどこか
 * （ユーザーの指摘 2026-11-23: 学習の地図のターン数がほとんど同じだった。既定の 100〜400 が 200 で打ち切られていた）
 */
export function simTurns(scn: Pick<Scenario, "totalTurns" | "capFrac">, maxTurns: number | null | undefined): number {
  if (!maxTurns || scn.totalTurns <= maxTurns) return scn.totalTurns;
  return Math.max(1, Math.round(maxTurns * (scn.capFrac ?? 1)));
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
  if (room === undefined || room === null) return jitterTurns(base);
  const over = file.rooms?.[String(room)] ?? {};
  const merged: MapProfile = { ...base, ...over, fill: over.fill ? { ...base.fill, ...over.fill } : base.fill };
  // ルームの実測（大きさ・ターン数・Webマップの有無）があればそれに合わせる（sim-profiles.json に書いてあればそちらが優先）
  const rp = getRoomProfile(room);
  if (!over.size && rp.mapDimensions) merged.size = [Math.min(...rp.mapDimensions), Math.max(...rp.mapDimensions)];
  const total = rp.totalTurns ?? knownTotalTurns(room);
  if (!over.turns && total) merged.turns = [total, total];
  if (over.webMap === undefined && rp.webMapAvailable !== null) merged.webMap = rp.webMapAvailable ? 1 : 0;
  return jitterTurns(merged);
}

/** ターン数が1つに決まっている（実測・[143,143] など）時は ±turnsJitter の幅にする */
function jitterTurns(p: MapProfile): MapProfile {
  const [lo, hi] = p.turns;
  if (lo !== hi) return p;
  const j = Math.max(0, Math.min(0.9, p.turnsJitter ?? DEFAULT_TURNS_JITTER));
  return { ...p, turns: [Math.max(10, Math.round(lo * (1 - j))), Math.round(hi * (1 + j))] };
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
/** 地図に置くタイルと重み。fill に加え、tiles.json の他のタイル（プレイヤー・ワープ・ブラックスターは別に置くので除く）も少し混ぜる */
export function fillWeights(profile: MapProfile): (readonly [number, number])[] {
  const fill = Object.entries(profile.fill).map(([k, v]) => [Number(k), v] as const);
  const other = profile.otherTiles ?? 0;
  if (other <= 0) return fill;
  const have = new Set(fill.map(([v]) => v));
  for (const key of Object.keys(loadTilesKnowledge())) {
    const v = Number(key);
    if (!Number.isInteger(v) || v < 0 || v >= 1000 || have.has(v) || isPortalTile(v) || warpDelta(v) || (v >= 60 && v <= 63)) continue;
    fill.push([v, other]);
  }
  return fill;
}

export function generateGrid(rng: Rng, profile: MapProfile, w: number, h: number): number[][] {
  const fill = fillWeights(profile);
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
  addEnclosures(rng, profile, grid);
  addPartitions(rng, profile, grid);
  return grid;
}

/** 仕切り（帯）と、それを越えるワープ */
function addPartitions(rng: Rng, profile: MapProfile, grid: number[][]): void {
  const cfg = profile.partitions ?? DEFAULT_PARTITIONS;
  const h = grid.length;
  const w = grid[0]!.length;
  if (rng() >= cfg.chance || w < 9 || h < 9) return;
  const n = randInt(rng, cfg.count[0], cfg.count[1]);
  const passable = (x: number, y: number) => {
    const info = getTileInfo(grid[y]![x]!);
    return info.passable && !info.hazard && !isPortalTile(grid[y]![x]!);
  };
  for (let i = 0; i < n; i++) {
    const vertical = rng() < 0.5;
    const span = vertical ? w : h;
    const width = randInt(rng, cfg.width[0], cfg.width[1]);
    const at = randInt(rng, 3, span - 4 - width);
    const t = pick(rng, cfg.tiles);
    for (let k = 0; k < width; k++) {
      for (let j = 0; j < (vertical ? h : w); j++) {
        if (vertical) grid[j]![at + k] = t;
        else grid[at + k]![j] = t;
      }
    }
    // 帯を越えるワープ（両向きに、着地が通れるマスになる番号を選ぶ）
    const portals = randInt(rng, cfg.portals[0], cfg.portals[1]);
    for (let p = 0; p < portals * 2; p++) {
      const forward = p % 2 === 0;
      for (let tries = 0; tries < 60; tries++) {
        const tile = pick(rng, [20, 21, 22, 23, 30, 31, 32, 33, 40, 41, 42, 43, 50, 51, 52, 53]);
        const d = warpDelta(tile)!;
        const along = vertical ? d[0] : d[1];
        const across = vertical ? d[1] : d[0];
        if (across !== 0 || (forward ? along <= 0 : along >= 0)) continue;
        const x = randInt(rng, 0, w - 1);
        const y = randInt(rng, 0, h - 1);
        const pos = vertical ? x : y;
        const dest = pos + along;
        const crosses = forward ? pos < at && dest >= at + width : pos >= at + width && dest < at;
        const tx = x + d[0];
        const ty = y + d[1];
        if (!crosses || tx < 0 || ty < 0 || tx >= w || ty >= h || !passable(x, y) || !passable(tx, ty)) continue;
        grid[y]![x] = tile;
        break;
      }
    }
  }
}

/** 点の高いアイテムを罠で1重に囲む */
function addEnclosures(rng: Rng, profile: MapProfile, grid: number[][]): void {
  const cfg = profile.enclosures ?? DEFAULT_ENCLOSURES;
  const h = grid.length;
  const w = grid[0]!.length;
  const items = cfg.items?.length
    ? cfg.items
    : Object.keys(fillWeights(profile))
        .map(Number)
        .filter((v) => getTileInfo(v).score > 0 && !isPortalTile(v))
        .sort((a, b) => getTileInfo(b).score - getTileInfo(a).score)
        .slice(0, 3);
  if (items.length === 0) return;
  const n = randInt(rng, cfg.count[0], cfg.count[1]);
  for (let i = 0; i < n; i++) {
    const r = randInt(rng, cfg.inner[0], cfg.inner[1]);
    const cx = randInt(rng, r + 3, w - r - 4);
    const cy = randInt(rng, r + 3, h - r - 4);
    if (cx < r + 3 || cy < r + 3) continue;
    const t = pick(rng, cfg.tiles);
    for (let dy = -r - 1; dy <= r + 1; dy++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy)) === r + 1;
        grid[cy + dy]![cx + dx] = ring ? t : pick(rng, items);
      }
    }
  }
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
    if (m.totalTurns) {
      const j = Math.max(0, Math.min(0.9, profile.turnsJitter ?? DEFAULT_TURNS_JITTER));
      totalTurns = randInt(rng, Math.max(10, Math.round(m.totalTurns * (1 - j))), Math.round(m.totalTurns * (1 + j)));
    }
  } else {
    const w = randInt(rng, profile.size[0], profile.size[1]);
    const h = rng() < 0.7 ? w : randInt(rng, profile.size[0], profile.size[1]);
    grid = generateGrid(rng, profile, w, h);
    name = `gen:${w}x${h}`;
  }
  const starts = placeStarts(rng, grid, players);
  const self = randInt(rng, 0, starts.length - 1);
  const webMap = rng() < profile.webMap;
  // 最後に引く（ここより前の乱数の順番を変えないので、同じ種なら地図は前と同じ）
  const capFrac = 0.5 + 0.5 * rng();
  return { name, grid, starts, self, totalTurns, webMap, putHit: profile.putHit ?? 0, capFrac };
}
