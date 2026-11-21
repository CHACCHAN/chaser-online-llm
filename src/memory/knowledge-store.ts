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
  warpLinks: WarpLinkRecord[];
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
    warpLinks: [],
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
