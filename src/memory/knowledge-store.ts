import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOM_PROFILES_PATH, TILES_PATH } from "../paths";

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
