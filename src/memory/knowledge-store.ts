import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOM_PROFILES_PATH, RUNS_DIR, TILES_PATH } from "../paths";

export interface StoredTileDefinition {
  name: string;
  label: string;
  score: number;
  passable: boolean;
  hazard: boolean;
  symbol: string;
  known: boolean;
  source?: "verified" | "inferred" | "reference";
  notes?: string;
}

export interface TilesKnowledgeFile {
  version: number;
  updatedAt: string;
  tiles: Record<string, StoredTileDefinition>;
}

export interface WarpLinkRecord {
  tileValue: number;
  fromSegment: number;
  fromPos: [number, number];
  toSegment: number;
  toPos: [number, number];
  observedTurn: number;
}

/** ルームのワープの記録（絶対座標 = Webマップの列・行。Webマップのあるルームだけ） */
export interface RoomWarpRecord {
  /** ワープのタイル番号（不明なら -1） */
  tile: number;
  from: [number, number];
  to: [number, number];
  /** 観測した回数（試合をまたいで数える） */
  count: number;
  lastRunId: string | null;
  updatedAt: string;
}

export interface RoomProfile {
  room: number;
  webMapAvailable: boolean | null;
  webMapUrl: string | null;
  mapDimensions: [number, number] | null;
  highScore: number | null;
  bestRunId: string | null;
  bestSolverFile: string | null;
  matchesPlayed: number;
  /** 1試合の全ターン数（公式結果の 取得ターン数＋残ターン数。Webマップは今のターンしか出さない） */
  totalTurns?: number | null;
  /** ワープの記録（絶対座標）。ハーネスが自動で書く */
  warps?: RoomWarpRecord[];
  /** マスごとのメモ（キーは絶対座標 "x,y"）。エージェントが `bun src/cli.ts cell-note` で書く */
  cellNotes?: Record<string, string[]>;
  discoveredTiles: number[];
  tacticalNotes: string[];
  updatedAt: string;
}

export interface RoomProfilesFile {
  version: number;
  updatedAt: string;
  rooms: Record<string, RoomProfile>;
}



let cachedTiles: Record<string, StoredTileDefinition> | null = null;

export function loadTilesKnowledge(): Record<string, StoredTileDefinition> {
  if (cachedTiles) return cachedTiles;
  try {
    if (existsSync(TILES_PATH)) {
      const raw = readFileSync(TILES_PATH, "utf-8");
      const parsed = JSON.parse(raw) as TilesKnowledgeFile;
      cachedTiles = parsed.tiles ?? {};
      return cachedTiles;
    }
  } catch {
    // Fallback to empty cache if malformed
  }
  cachedTiles = {};
  return cachedTiles;
}

export function reloadTilesKnowledge(): Record<string, StoredTileDefinition> {
  cachedTiles = null;
  return loadTilesKnowledge();
}

export function upsertTileDefinition(
  tileValue: number,
  def: StoredTileDefinition,
): void {
  const tiles = loadTilesKnowledge();
  tiles[String(tileValue)] = def;
  const payload: TilesKnowledgeFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tiles,
  };
  writeFileSync(TILES_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  cachedTiles = tiles;
}

export function loadRoomProfiles(): RoomProfilesFile {
  try {
    if (existsSync(ROOM_PROFILES_PATH)) {
      const raw = readFileSync(ROOM_PROFILES_PATH, "utf-8");
      return JSON.parse(raw) as RoomProfilesFile;
    }
  } catch {
    // ignore
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    rooms: {},
  };
}

export function getRoomProfile(room: number): RoomProfile {
  const file = loadRoomProfiles();
  const key = String(room);
  const existing = file.rooms[key];
  if (existing) return existing;
  return {
    room,
    webMapAvailable: null,
    webMapUrl: null,
    mapDimensions: null,
    highScore: null,
    bestRunId: null,
    bestSolverFile: null,
    matchesPlayed: 0,
    warps: [],
    cellNotes: {},
    discoveredTiles: [],
    tacticalNotes: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * ルームの全ターン数。記録が無ければ過去の試合の公式結果（取得＋残ターン数）から求める。分からなければ null。
 */
export function knownTotalTurns(room: number, runsDir = RUNS_DIR): number | null {
  const recorded = getRoomProfile(room).totalTurns;
  if (typeof recorded === "number" && recorded > 0) return recorded;
  if (!existsSync(runsDir)) return null;
  for (const name of readdirSync(runsDir).sort().reverse()) {
    const file = path.join(runsDir, name, "summary.json");
    if (!existsSync(file)) continue;
    try {
      const o = (JSON.parse(readFileSync(file, "utf-8")) as { officialResult?: { room?: string | number; acquiredTurns?: number; remainingTurns?: number } | null }).officialResult;
      const total = (o?.acquiredTurns ?? 0) + (o?.remainingTurns ?? 0);
      if (o && Number(o.room) === room && total > 0) return total;
    } catch {
      // 壊れた summary は飛ばす
    }
  }
  return null;
}

/** ワープを1回観測したら呼ぶ（同じ入口・同じ着地なら回数を足す）。絶対座標で渡す */
export function recordRoomWarp(room: number, link: { tileValue: number; from: [number, number]; to: [number, number] }, runId: string | null): RoomWarpRecord {
  const profile = getRoomProfile(room);
  const warps = profile.warps ?? [];
  const now = new Date().toISOString();
  let rec = warps.find((w) => w.from[0] === link.from[0] && w.from[1] === link.from[1] && w.to[0] === link.to[0] && w.to[1] === link.to[1]);
  if (rec) {
    rec.count += 1;
    if (link.tileValue >= 0) rec.tile = link.tileValue;
    rec.lastRunId = runId;
    rec.updatedAt = now;
  } else {
    rec = { tile: link.tileValue, from: [...link.from], to: [...link.to], count: 1, lastRunId: runId, updatedAt: now };
    warps.push(rec);
  }
  profile.warps = warps;
  saveRoomProfile(profile);
  return rec;
}

/** マスのメモを足す（note が空なら、そのマスのメモを消す）。絶対座標 */
export function setCellNote(room: number, x: number, y: number, note: string): string[] {
  const profile = getRoomProfile(room);
  const notes = profile.cellNotes ?? {};
  const key = `${x},${y}`;
  if (note.trim()) notes[key] = [...(notes[key] ?? []), note.trim()];
  else delete notes[key];
  profile.cellNotes = notes;
  saveRoomProfile(profile);
  return notes[key] ?? [];
}

/** ワープの記録とマスのメモを引く。near を渡すと、そこからマンハッタン距離 radius 以内だけ（近い順） */
export function roomCells(room: number, near?: [number, number] | null, radius = Infinity) {
  const profile = getRoomProfile(room);
  const dist = (p: [number, number]) => (near ? Math.abs(p[0] - near[0]) + Math.abs(p[1] - near[1]) : 0);
  const warps = (profile.warps ?? [])
    .map((w) => ({ ...w, distance: dist(w.from) }))
    .filter((w) => w.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
  const notes = Object.entries(profile.cellNotes ?? {})
    .map(([k, v]) => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return { x, y, notes: v, distance: dist([x, y]) };
    })
    .filter((n) => n.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
  // タイル番号ごとの飛び方（入口から着地への移動量）。公式の「番号ごとに決まった方向・距離」と照らし合わせる用
  const byTile = new Map<number, Map<string, number>>();
  for (const w of profile.warps ?? []) {
    const v = `${w.to[0] - w.from[0]},${w.to[1] - w.from[1]}`;
    const m = byTile.get(w.tile) ?? new Map<string, number>();
    m.set(v, (m.get(v) ?? 0) + w.count);
    byTile.set(w.tile, m);
  }
  const tileJumps = [...byTile.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tile, m]) => ({ tile, jumps: [...m.entries()].map(([d, count]) => ({ delta: d.split(",").map(Number), count })) }));
  return { room, warps, notes, tileJumps };
}

export function saveRoomProfile(profile: RoomProfile): RoomProfile {
  const file = loadRoomProfiles();
  const updated: RoomProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };
  file.rooms[String(profile.room)] = updated;
  file.updatedAt = updated.updatedAt;
  writeFileSync(ROOM_PROFILES_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
  return updated;
}
