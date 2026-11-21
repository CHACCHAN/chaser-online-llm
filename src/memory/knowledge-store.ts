import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRunDirName, ROOM_PROFILES_PATH, RUNS_DIR, TILES_PATH } from "../paths";

export interface StoredTileDefinition {
  name: string;
  label: string;
  score: number;
  passable: boolean;
  hazard: boolean;
  symbol: string;
  known: boolean;
  /** official: 公式資料 / measured: Webマップの公式の得点から実測（ハーネスが書く） / verified・inferred: エージェントの検証・推測 */
  source?: "official" | "measured" | "verified" | "inferred" | "reference";
  /** 実測の推定の数（measured の時）。試合をまたいで足す */
  measuredSamples?: number;
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
  /** 最後に使った公式成績の行の開始時刻（次の試合が同じ行を取り違えないため。src/client/result.ts の isResultForRun） */
  lastOfficialStartedAt?: string | null;
  /** ワープの記録（絶対座標）。ハーネスが自動で書く */
  warps?: RoomWarpRecord[];
  /** マスごとのメモ（キーは絶対座標 "x,y"）。エージェントが `bun src/cli.ts cell-note` で書く */
  cellNotes?: Record<string, string[]>;
  discoveredTiles: number[];
  updatedAt: string;
}

export interface RoomProfilesFile {
  version: number;
  updatedAt: string;
  rooms: Record<string, RoomProfile>;
}



/**
 * JSON を書く。一時ファイルに書いてから置き換えるので、書いている途中で止まっても前の中身が壊れない。
 */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

/** 読めなかった JSON を控えに残す（上書きで失わない）。控えのパスを返す */
function backupBroken(file: string): string | null {
  try {
    const dest = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

let cachedTiles: Record<string, StoredTileDefinition> | null = null;
/** 最後に読めた tiles.json（エージェントが書きかけ・壊した時はこれを使い、書き込みは止める） */
let lastGoodTiles: Record<string, StoredTileDefinition> | null = null;
/** tiles.json が読めない（壊れている）。その間に書くと全タイルが消えるので upsert しない */
let tilesUnreadable: string | null = null;

export function loadTilesKnowledge(): Record<string, StoredTileDefinition> {
  if (cachedTiles) return cachedTiles;
  if (!existsSync(TILES_PATH)) {
    tilesUnreadable = null;
    cachedTiles = {};
    return cachedTiles;
  }
  try {
    const parsed = JSON.parse(readFileSync(TILES_PATH, "utf-8")) as TilesKnowledgeFile;
    cachedTiles = parsed.tiles ?? {};
    lastGoodTiles = cachedTiles;
    tilesUnreadable = null;
    return cachedTiles;
  } catch (err) {
    tilesUnreadable = err instanceof Error ? err.message : String(err);
    // 前に読めた中身で続ける。キャッシュもする（getTileInfo はマスごとに呼ばれる。runner が毎フェーズ reloadTilesKnowledge
    // で捨てるので、ファイルが直れば次のフェーズで反映される）
    cachedTiles = lastGoodTiles ? { ...lastGoodTiles } : {};
    return cachedTiles;
  }
}

/** tiles.json が読めない時の理由（読めれば null） */
export function tilesKnowledgeError(): string | null {
  loadTilesKnowledge();
  return tilesUnreadable;
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
  if (tilesUnreadable) {
    // 壊れたファイルの上に書くと、他のタイルの知識がすべて消える
    throw new Error(`knowledge/tiles.json が JSON として読めないので書き込まない（${tilesUnreadable}）。先にファイルを直すこと`);
  }
  tiles[String(tileValue)] = def;
  const payload: TilesKnowledgeFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tiles,
  };
  writeJsonAtomic(TILES_PATH, payload);
  cachedTiles = tiles;
  lastGoodTiles = tiles;
}

/** 実測の得点を試合で使うのに要る推定の数 */
export const MEASURED_MIN_SAMPLES = 3;

/**
 * Webマップの公式のアイテム得点から測ったタイルの得点を残す（src/memory/tile-measure.ts）。
 * 前の実測と同じ値なら推定の数を足し、違う値なら推定の多い方を残す。推測（inferred など）より常に優先する。
 */
export function recordMeasuredTileScores(tiles: { value: number; score: number; agree: number; samples: number }[], runId: string): void {
  for (const m of tiles) {
    const prev = loadTilesKnowledge()[String(m.value)];
    const prevMeasured = prev?.source === "measured" ? (prev.measuredSamples ?? 0) : 0;
    if (prevMeasured > 0 && prev!.score !== m.score && prevMeasured >= m.agree) continue;
    const samples = prevMeasured > 0 && prev!.score === m.score ? prevMeasured + m.agree : m.agree;
    const note = `【実測 ${runId}: ${m.score}点（推定${m.samples}件中${m.agree}件が一致）${prev && prev.score !== m.score ? `。以前の値 ${prev.score}（${prev.source ?? "?"}）を置き換え` : ""}】`;
    upsertTileDefinition(m.value, {
      name: prev?.name ?? `tile_${m.value}`,
      label: prev?.label ?? `タイル${m.value}`,
      passable: prev?.passable ?? true,
      hazard: prev?.hazard ?? m.score < 0,
      symbol: prev?.symbol ?? "?",
      known: true,
      ...prev,
      score: m.score,
      source: "measured",
      measuredSamples: samples,
      notes: [prev?.notes, note].filter(Boolean).join(" "),
    });
  }
}

/** 最後に読めた room-profiles.json（壊れていた時に全ルームの記録を空で上書きしないため） */
let lastGoodProfiles: RoomProfilesFile | null = null;
/** 壊れた room-profiles.json を控えに残した（同じ壊れ方で何度も控えを作らない） */
let brokenProfilesBackedUp: string | null = null;
/** room-profiles.json が壊れていて、前に読めた中身も無い（この間は保存しない。空に上書きすると全ルームの記録が消える） */
let profilesUnsafe = false;

export function loadRoomProfiles(): RoomProfilesFile {
  if (!existsSync(ROOM_PROFILES_PATH)) profilesUnsafe = false;
  if (existsSync(ROOM_PROFILES_PATH)) {
    let raw = "";
    try {
      raw = readFileSync(ROOM_PROFILES_PATH, "utf-8");
      const parsed = JSON.parse(raw) as RoomProfilesFile;
      if (!parsed || typeof parsed !== "object" || typeof parsed.rooms !== "object" || parsed.rooms === null) throw new Error("rooms がない");
      lastGoodProfiles = parsed;
      brokenProfilesBackedUp = null;
      profilesUnsafe = false;
      return parsed;
    } catch (err) {
      // 壊れたファイルは控えに残し、前に読めた中身で続ける（次に保存した時にその中身で直る）
      if (brokenProfilesBackedUp !== raw) {
        const dest = backupBroken(ROOM_PROFILES_PATH);
        brokenProfilesBackedUp = raw;
        console.error(`room-profiles.json が読めない（${err instanceof Error ? err.message : String(err)}）。控え: ${dest ?? "作れなかった"}`);
      }
      profilesUnsafe = !lastGoodProfiles;
      if (lastGoodProfiles) return structuredClone(lastGoodProfiles);
    }
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
  for (const name of readdirSync(runsDir).filter(isRunDirName).sort().reverse()) {
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

/** ワープのタイル番号か（20〜23・30〜33・40〜43・50〜53 のワープ、60〜63 のブラックスター） */
export function isWarpTile(v: number): boolean {
  return [20, 30, 40, 50, 60].some((b) => v >= b && v <= b + 3);
}

/** マスのメモ1件の上限（試合中のメインにも見せるので短く） */
export const CELL_NOTE_MAX_CHARS = 160;

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
  if (note.trim()) notes[key] = [...(notes[key] ?? []), note.trim().replace(/\s+/g, " ").slice(0, CELL_NOTE_MAX_CHARS)];
  else delete notes[key];
  profile.cellNotes = notes;
  saveRoomProfile(profile);
  return notes[key] ?? [];
}

/** ワープの記録とマスのメモを引く。near を渡すと、そこからマンハッタン距離 radius 以内だけ（近い順） */
export function roomCells(room: number, near?: [number, number] | null, radius = Infinity) {
  const profile = getRoomProfile(room);
  const dist = (p: [number, number]) => (near ? Math.abs(p[0] - near[0]) + Math.abs(p[1] - near[1]) : 0);
  // 古い版はワープ以外のタイルからの誤検知も記録していたので、読む時にも除く
  const warps = (profile.warps ?? [])
    .filter((w) => isWarpTile(w.tile))
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
  for (const w of (profile.warps ?? []).filter((x) => isWarpTile(x.tile))) {
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
  if (profilesUnsafe) {
    // 試合は止めない。壊れたファイルを直せば次の保存から記録される
    console.error(`room-profiles.json が読めないので Room ${profile.room} の記録を保存しない（控え: room-profiles.json.broken-*。ファイルを直すこと）`);
    return updated;
  }
  writeJsonAtomic(ROOM_PROFILES_PATH, file);
  lastGoodProfiles = file;
  return updated;
}
