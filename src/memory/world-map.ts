import {
  loadTilesKnowledge,
  type WarpLinkRecord,
} from "./knowledge-store";

export type Dir = "u" | "d" | "l" | "r";

export const CMD1_COMMANDS = ["gr", "gru", "grd", "grl", "grr"] as const;
export type Cmd1Command = (typeof CMD1_COMMANDS)[number];

export const CMD2_COMMANDS = [
  "wu", "wd", "wl", "wr",
  "du", "dd", "dl", "dr",
  "pu2wd", "pd2wu", "pl2wr", "pr2wl",
  "pu3su", "pd3sd", "pl3sl", "pr3sr",
  "pu3lu", "pd3ld", "pl3ll", "pr3lr",
  "keilu", "keiru", "keild", "keird",
] as const;
export type Cmd2Command = (typeof CMD2_COMMANDS)[number];

export type SafetyLevel =
  | "SAFE"
  | "PENALTY_HOLE"
  | "HAZARD"
  | "BLOCKED"
  | "UNKNOWN";

export interface TileInfo {
  name: string;
  label: string;
  score: number;
  passable: boolean;
  hazard: boolean;
  symbol: string;
  known: boolean;
}

export interface UiPlayerMarker {
  x: number;
  y: number;
  role: "self" | "enemy";
  /** 1000, 2000 ... のプレイヤー ID。不明なら null */
  tileId: number | null;
  lastSeenTurn: number | null;
  source: "web_map" | "slam";
}

export interface TileRecord {
  value: number;
  firstSeenTurn: number;
  lastSeenTurn: number;
  visitedCount: number;
  fromGlobalMap?: boolean;
}

export interface CandidateEvaluation {
  command: string;
  category: "get_ready" | "walk" | "dig" | "put_walk" | "put_search" | "put_look" | "kei";
  landingPos: [number, number];
  knownTile: number | null;
  knownTileLabel: string | null;
  safety: SafetyLevel;
  estimatedActionCost: number;
  estimatedTileScore: number;
  estimatedNetImmediate: number;
  highFatigue: boolean;
  note: string | null;
}

export interface PathTarget {
  x: number;
  y: number;
  tileValue: number | null;
  tileLabel: string;
  distance: number;
  holeSteps: number;
  estimatedNetGain: number;
  revisitPenalty: number; // Routing preference only; not charged by the server.
  firstStep: Dir;
  recommendedCmd2: Cmd2Command;
}

export interface EvaluationSummary {
  phase: "CMD1" | "CMD2";
  segmentId: number;
  position: [number, number];
  globalPosition: [number, number] | null;
  globalMapLocked: boolean;
  candidates: CandidateEvaluation[];
  topValueTargets: PathTarget[];
  nearestFrontiers: PathTarget[];
  recommendedFallback: string;
}

export interface MapInspectResult {
  segmentId: number;
  segmentCount: number;
  position: [number, number];
  globalPosition: [number, number] | null;
  globalMapLocked: boolean;
  ascii: string;
  knownTargets: { x: number; y: number; value: number; label: string; score: number }[];
  unknownTileIds: number[];
  warpLinks: WarpLinkRecord[];
}

export interface WorldMapSnapshot {
  turn: number;
  segmentId: number;
  segmentCount: number;
  position: [number, number];
  globalPosition: [number, number] | null;
  globalMapLocked: boolean;
  lastMoveDir: Dir | null;
  lastGrid: number[] | null;
  stats: ReturnType<WorldMap["getStats"]>;
  tiles: { x: number; y: number; value: number; visitedCount: number }[];
  warpLinks: WarpLinkRecord[];
}

interface CommandSpec {
  category: CandidateEvaluation["category"];
  move: [number, number];
  obsOffset: [number, number];
  obsShape: "3x3" | "ray";
  estActionCost: number;
  highFatigue: boolean;
  putDir?: Dir;
  put3Dir?: Dir;
  rayDir?: Dir;
  walkDir?: Dir;
}

export const DIR_DELTA: Record<Dir, [number, number]> = {
  u: [0, -1],
  d: [0, 1],
  l: [-1, 0],
  r: [1, 0],
};

export const OPPOSITE_DIR: Record<Dir, Dir> = {
  u: "d",
  d: "u",
  l: "r",
  r: "l",
};

export const DIRS: Dir[] = ["u", "r", "d", "l"];

export const CMD1_SPECS: Record<Cmd1Command, CommandSpec> = {
  gr: { category: "get_ready", move: [0, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -20, highFatigue: false },
  gru: { category: "get_ready", move: [0, -1], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "u" },
  grd: { category: "get_ready", move: [0, 1], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "d" },
  grl: { category: "get_ready", move: [-1, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "l" },
  grr: { category: "get_ready", move: [1, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "r" },
};

export const CMD2_SPECS: Record<Cmd2Command, CommandSpec> = {
  wu: { category: "walk", move: [0, -1], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "u" },
  wd: { category: "walk", move: [0, 1], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "d" },
  wl: { category: "walk", move: [-1, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "l" },
  wr: { category: "walk", move: [1, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -10, highFatigue: false, walkDir: "r" },

  du: { category: "dig", move: [0, 0], obsOffset: [0, -2], obsShape: "3x3", estActionCost: -250, highFatigue: true },
  dd: { category: "dig", move: [0, 0], obsOffset: [0, 2], obsShape: "3x3", estActionCost: -250, highFatigue: true },
  dl: { category: "dig", move: [0, 0], obsOffset: [-2, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true },
  dr: { category: "dig", move: [0, 0], obsOffset: [2, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true },

  pu2wd: { category: "put_walk", move: [0, 1], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true, putDir: "u", walkDir: "d" },
  pd2wu: { category: "put_walk", move: [0, -1], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true, putDir: "d", walkDir: "u" },
  pl2wr: { category: "put_walk", move: [1, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true, putDir: "l", walkDir: "r" },
  pr2wl: { category: "put_walk", move: [-1, 0], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true, putDir: "r", walkDir: "l" },

  pu3su: { category: "put_search", move: [1, 0], obsOffset: [0, 0], obsShape: "ray", estActionCost: -250, highFatigue: true, put3Dir: "u", rayDir: "u", walkDir: "r" },
  pd3sd: { category: "put_search", move: [-1, 0], obsOffset: [0, 0], obsShape: "ray", estActionCost: -250, highFatigue: true, put3Dir: "d", rayDir: "d", walkDir: "l" },
  pl3sl: { category: "put_search", move: [0, -1], obsOffset: [0, 0], obsShape: "ray", estActionCost: -250, highFatigue: true, put3Dir: "l", rayDir: "l", walkDir: "u" },
  pr3sr: { category: "put_search", move: [0, 1], obsOffset: [0, 0], obsShape: "ray", estActionCost: -250, highFatigue: true, put3Dir: "r", rayDir: "r", walkDir: "d" },

  pu3lu: { category: "put_look", move: [1, 0], obsOffset: [0, -2], obsShape: "3x3", estActionCost: -250, highFatigue: true, put3Dir: "u", walkDir: "r" },
  pd3ld: { category: "put_look", move: [-1, 0], obsOffset: [0, 2], obsShape: "3x3", estActionCost: -250, highFatigue: true, put3Dir: "d", walkDir: "l" },
  pl3ll: { category: "put_look", move: [0, -1], obsOffset: [-2, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true, put3Dir: "l", walkDir: "u" },
  pr3lr: { category: "put_look", move: [0, 1], obsOffset: [2, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true, put3Dir: "r", walkDir: "d" },

  keilu: { category: "kei", move: [-1, -2], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true },
  keiru: { category: "kei", move: [1, -2], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true },
  keild: { category: "kei", move: [-1, 2], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true },
  keird: { category: "kei", move: [1, 2], obsOffset: [0, 0], obsShape: "3x3", estActionCost: -250, highFatigue: true },
};

export function getTileInfo(value: number): TileInfo {
  const dynamicDb = loadTilesKnowledge();
  const fromDb = dynamicDb[String(value)];
  if (fromDb) {
    return {
      name: fromDb.name,
      label: fromDb.label,
      score: fromDb.score,
      passable: fromDb.passable,
      hazard: fromDb.hazard,
      symbol: fromDb.symbol,
      known: fromDb.known,
    };
  }

  switch (value) {
    case 0:
      return { name: "hole", label: "穴", score: -20, passable: true, hazard: false, symbol: ".", known: true };
    case 1:
      return { name: "target", label: "ターゲット", score: 50, passable: true, hazard: false, symbol: "T", known: true };
    case 2:
      return { name: "soil", label: "土", score: 10, passable: true, hazard: false, symbol: ",", known: true };
    case 3:
      return { name: "item", label: "アイテム", score: 30, passable: true, hazard: false, symbol: "*", known: true };
    case 4:
      return { name: "geode", label: "ジオード", score: -1000, passable: true, hazard: true, symbol: "!", known: true };
    case 5:
      return { name: "fossil_1", label: "化石1", score: 125, passable: true, hazard: false, symbol: "F", known: true };
    case 6:
      return { name: "fossil_2", label: "化石2", score: 150, passable: true, hazard: false, symbol: "F", known: true };
    case 7:
      return { name: "fossil_3", label: "化石3", score: 175, passable: true, hazard: false, symbol: "F", known: true };
    case 8:
      return { name: "fossil_4", label: "化石4", score: 200, passable: true, hazard: false, symbol: "F", known: true };
    case 9:
      return { name: "ammonite", label: "アンモナイト", score: 100, passable: true, hazard: false, symbol: "A", known: true };
    case 10:
      return { name: "bedrock", label: "岩盤", score: -10, passable: false, hazard: false, symbol: "#", known: true };
    case 12:
      return { name: "abyss", label: "奈落", score: -600, passable: true, hazard: true, symbol: "X", known: true };
    default:
      break;
  }

  if (value >= 20 && value <= 53) {
    return { name: "warp", label: `ワープ(${value})`, score: 5, passable: true, hazard: false, symbol: "W", known: true };
  }
  if (value >= 60 && value <= 63) {
    return { name: "blackstar", label: `ブラックスター(${value})`, score: 5, passable: true, hazard: false, symbol: "B", known: true };
  }
  if (value >= 70 && value <= 79) {
    return { name: "geometal", label: `ジオーメタル(${value})`, score: 400, passable: true, hazard: false, symbol: "G", known: true };
  }
  if (value >= 1000) {
    return { name: "client", label: `プレイヤー(${value})`, score: 0, passable: false, hazard: false, symbol: "P", known: true };
  }

  return { name: `unknown_${value}`, label: `未知(${value})`, score: 0, passable: true, hazard: false, symbol: "?", known: false };
}

export function classifyTileSafety(tileValue: number | null): SafetyLevel {
  if (tileValue === null) return "UNKNOWN";
  const info = getTileInfo(tileValue);
  if (info.hazard) return "HAZARD";
  if (!info.passable) return "BLOCKED";
  if (tileValue === 0) return "PENALTY_HOLE";
  return "SAFE";
}

export function getHoleRevisitPenalty(tile: TileRecord | undefined): number {
  // Never make a previously visited hole impassable: it may be the only exit.
  return tile?.value === 0 ? 25 * Math.min(tile.visitedCount, 3) : 0;
}

export function getPathUtility(target: PathTarget): number {
  return target.estimatedNetGain - target.revisitPenalty;
}

function coordKey(x: number, y: number): string {
  return `${x},${y}`;
}

function parseCoordKey(key: string): [number, number] {
  const [xs, ys] = key.split(",");
  return [Number(xs), Number(ys)];
}

export class WorldMap {
  private segments: Map<string, TileRecord>[] = [new Map()];
  private segmentIndex = 0;
  private x = 0;
  private y = 0;
  private lastMoveDir: Dir | null = null;
  private lastTurn = 0;

  private actionScore = 0;
  private itemScore = 0;
  private holeRevisits = 0;
  private hazardHits = 0;
  private pickups: Record<string, number> = {};
  private unknownTiles = new Set<number>();
  private lastGridValues: number[] | null = null;
  private warpLinks: WarpLinkRecord[] = [];
  private lastEventFlags: {
    warped: boolean;
    blocked: boolean;
    newUnknownTiles: number[];
    globalLocalized: boolean;
  } = {
    warped: false,
    blocked: false,
    newUnknownTiles: [],
    globalLocalized: false,
  };

  // Global Web Map integration (when available via Playwright/HTTP scraper)
  private globalGrid: number[][] | null = null;
  /** Web マップを最後に取得したターン（これより新しい自前観測だけを UI で上書き表示する） */
  private globalGridTurn = 0;
  /** 自機のタイル ID（観測の中心値 / Web マップの自機表示から判明。既定 1000） */
  private selfTileId = 1000;
  /** 自前観測で見えた他プレイヤー（ローカル座標）。key = tileId */
  private enemySightings = new Map<number, { x: number; y: number; tileId: number; lastSeenTurn: number }>();
  /** ローカル座標系が変わった回数（ワープで新しい区画に入る・既知の区画に戻る）。変わったら古い座標は使えない */
  private frameVersionCount = 0;

  public get frameVersion(): number {
    return this.frameVersionCount;
  }
  private globalOffset: [number, number] | null = null; // [globalOriginX, globalOriginY] so global = local + offset
  private trail: [number, number][] = [[0, 0]];
  private stageName: string | null = null;

  private get currentMap(): Map<string, TileRecord> {
    return this.segments[this.segmentIndex]!;
  }

  public getPosition(): [number, number] {
    return [this.x, this.y];
  }

  public getGlobalPosition(): [number, number] | null {
    if (!this.globalOffset) return null;
    return [this.x + this.globalOffset[0], this.y + this.globalOffset[1]];
  }

  public isGlobalMapLocked(): boolean {
    return this.globalGrid !== null && this.globalOffset !== null;
  }

  public getLastMoveDir(): Dir | null {
    return this.lastMoveDir;
  }

  public getSegmentId(): number {
    return this.segmentIndex;
  }

  public getSegmentCount(): number {
    return this.segments.length;
  }

  public getTile(x: number, y: number): TileRecord | undefined {
    return this.currentMap.get(coordKey(x, y));
  }

  public getLastGrid(): number[] | null {
    return this.lastGridValues;
  }

  public getWarpLinks(): WarpLinkRecord[] {
    return [...this.warpLinks];
  }

  public getLastEventFlags() {
    return { ...this.lastEventFlags, newUnknownTiles: [...this.lastEventFlags.newUnknownTiles] };
  }

  /**
   * Playwright / HTTP スクレイパから取得した全体マップ配列 (row-major: grid[gy][gx]) を登録する。
   * 既にローカル観測がある場合は即座にマッチングを試みる。
   */
  public setGlobalGrid(
    grid: number[][],
    knownPlayerPos?: [number, number] | null,
    stageName?: string | null,
    turn?: number,
    selfTileId?: number | null,
    /** 取得を始めた時点の自機のローカル座標（取得中に動いてもずれないように） */
    localPosAtCapture?: [number, number],
  ): void {
    if (!grid.length || !grid[0]?.length) return;
    this.globalGrid = grid.map((r) => [...r]);
    this.globalGridTurn = turn ?? this.lastTurn;
    if (selfTileId) this.selfTileId = selfTileId;
    if (stageName !== undefined) this.stageName = stageName;
    if (knownPlayerPos) {
      // 取得中に動いていると、Web マップの自機位置が「取得開始時」と「今」のどちらの時点か分からない。
      // 候補（既存の位置合わせ・取得開始時・今）を自分で観測したマスとの食い違いの少なさで選ぶ
      const candidates: [number, number][] = [];
      if (this.globalOffset) candidates.push(this.globalOffset);
      for (const [lx, ly] of [localPosAtCapture ?? [this.x, this.y], [this.x, this.y]] as [number, number][]) {
        candidates.push([knownPlayerPos[0] - lx, knownPlayerPos[1] - ly]);
      }
      let best = candidates[0]!;
      let bestMismatch = this.offsetMismatch(best);
      for (const c of candidates.slice(1)) {
        const m = this.offsetMismatch(c);
        if (m < bestMismatch) {
          best = c;
          bestMismatch = m;
        }
      }
      this.globalOffset = best;
      this.overlayGlobalGridToCurrentSegment();
    } else {
      this.tryLocalizeOnGlobalGrid();
    }
  }

  /** この位置合わせで、自分で観測したマスと Web マップが食い違う数（自分が踏んで穴にしたマス・プレイヤーは除く） */
  private offsetMismatch([ox, oy]: [number, number]): number {
    if (!this.globalGrid) return Infinity;
    let mismatch = 0;
    for (const [k, rec] of this.currentMap.entries()) {
      if (rec.fromGlobalMap || rec.value >= 1000) continue;
      if (rec.visitedCount > 0 && rec.value === 0) continue;
      const [lx, ly] = parseCoordKey(k);
      const g = this.globalGrid[ly + oy]?.[lx + ox];
      if (g === undefined) mismatch += 1;
      else if (g < 1000 && g !== rec.value) mismatch += 1;
    }
    return mismatch;
  }

  /** 自前の観測で見えた他プレイヤー（ローカル座標・最後に見たターン） */
  public getEnemySightings(): { x: number; y: number; tileId: number; lastSeenTurn: number }[] {
    const byId = new Map([...this.enemySightings.values()].map((e) => [e.tileId, { ...e }]));
    // Web マップに載っている敵も（位置合わせ済みならローカル座標に直して）含める。新しい方を採用
    if (this.globalGrid && this.globalOffset) {
      const [ox, oy] = this.globalOffset;
      this.globalGrid.forEach((row, gy) =>
        row.forEach((v, gx) => {
          if (v < 1000 || v === this.selfTileId) return;
          const prev = byId.get(v);
          if (!prev || prev.lastSeenTurn <= this.globalGridTurn) {
            byId.set(v, { x: gx - ox, y: gy - oy, tileId: v, lastSeenTurn: this.globalGridTurn });
          }
        }),
      );
    }
    return [...byId.values()];
  }

  public getGlobalGrid(): number[][] | null {
    return this.globalGrid;
  }

  private tryLocalizeOnGlobalGrid(): boolean {
    if (!this.globalGrid || this.currentMap.size < 5) return false;
    const height = this.globalGrid.length;
    const width = this.globalGrid[0]?.length ?? 0;
    if (width === 0 || height === 0) return false;

    const observedEntries = [...this.currentMap.entries()].filter(
      ([, rec]) => !rec.fromGlobalMap && rec.value < 1000,
    );
    if (observedEntries.length < 5) return false;

    const matches: { ox: number; oy: number; mismatch: number }[] = [];

    for (let gy0 = 0; gy0 < height; gy0++) {
      for (let gx0 = 0; gx0 < width; gx0++) {
        let mismatch = 0;
        let compared = 0;

        for (const [k, rec] of observedEntries) {
          const [lx, ly] = parseCoordKey(k);
          const gx = gx0 + lx;
          const gy = gy0 + ly;
          if (gx < 0 || gx >= width || gy < 0 || gy >= height) {
            mismatch += 10;
            break;
          }
          const gVal = this.globalGrid[gy]?.[gx];
          if (gVal === undefined) {
            mismatch += 10;
            break;
          }
          compared += 1;
          // 既に自機が踏んで穴(0)になったマスは元マップで >0 だった可能性があるため許容
          if (rec.visitedCount > 0 && rec.value === 0) continue;
          if (gVal >= 1000) continue;
          if (gVal !== rec.value) {
            mismatch += 1;
            if (mismatch > 1) break;
          }
        }

        if (compared >= 5 && mismatch <= 1) {
          matches.push({ ox: gx0, oy: gy0, mismatch });
        }
      }
    }

    matches.sort((a, b) => a.mismatch - b.mismatch);
    const exactMatches = matches.filter((m) => m.mismatch === 0);
    const chosen =
      exactMatches.length === 1
        ? exactMatches[0]
        : matches.length === 1
          ? matches[0]
          : null;

    if (chosen) {
      this.globalOffset = [chosen.ox, chosen.oy];
      this.overlayGlobalGridToCurrentSegment();
      this.lastEventFlags.globalLocalized = true;
      return true;
    }
    return false;
  }

  private overlayGlobalGridToCurrentSegment(): void {
    if (!this.globalGrid || !this.globalOffset) return;
    const [ox, oy] = this.globalOffset;
    const height = this.globalGrid.length;
    const width = this.globalGrid[0]?.length ?? 0;

    for (let gy = 0; gy < height; gy++) {
      const row = this.globalGrid[gy];
      if (!row) continue;
      for (let gx = 0; gx < width; gx++) {
        const val = row[gx];
        if (val === undefined || val >= 1000) continue;
        const lx = gx - ox;
        const ly = gy - oy;
        const key = coordKey(lx, ly);
        const existing = this.currentMap.get(key);
        // 取り直した Web マップの方が新しければ更新する（他プレイヤーが拾ったアイテム等）。自分の観測の方が新しければそのまま
        if (existing && !existing.fromGlobalMap && existing.lastSeenTurn >= this.globalGridTurn) continue;
        if (existing && existing.value === val) continue;
        const info = getTileInfo(val);
        if (!info.known) {
          this.unknownTiles.add(val);
        }
        this.currentMap.set(key, {
          value: val,
          firstSeenTurn: existing?.firstSeenTurn ?? this.lastTurn,
          lastSeenTurn: this.globalGridTurn,
          visitedCount: existing?.visitedCount ?? 0,
          // 自分で観測したマスは「自前観測」の印を残す（位置合わせは自前観測だけを使うため）
          fromGlobalMap: existing ? (existing.fromGlobalMap ?? false) : true,
        });
      }
    }
  }

  /**
   * ワープ後の新セグメントの3x3観測が、既存セグメントの既知パターンと一意に一致するなら座標系を統合する (Loop Closure)。
   */
  private tryLoopClosureWithPreviousSegments(values: number[], turn: number): boolean {
    if (this.segmentIndex === 0 || values.length < 9) return false;

    for (let segIdx = 0; segIdx < this.segmentIndex; segIdx++) {
      const targetSeg = this.segments[segIdx];
      if (!targetSeg || targetSeg.size < 9) continue;

      const candidates: [number, number][] = [];
      for (const [k] of targetSeg.entries()) {
        const [cx, cy] = parseCoordKey(k);
        let knownNeighbors = 0;
        let mismatch = 0;

        for (let i = 0; i < 9; i++) {
          if (i === 4) continue;
          const obsVal = values[i];
          if (obsVal === undefined || obsVal >= 1000) continue;
          const ox = (i % 3) - 1;
          const oy = Math.floor(i / 3) - 1;
          const existing = targetSeg.get(coordKey(cx + ox, cy + oy));
          if (!existing) continue;
          knownNeighbors += 1;
          if (existing.value !== obsVal) {
            mismatch += 1;
            break;
          }
        }

        if (knownNeighbors >= 6 && mismatch === 0) {
          candidates.push([cx, cy]);
        }
      }

      if (candidates.length === 1) {
        const [matchedX, matchedY] = candidates[0]!;
        // 現在のセグメントを segIdx に統合
        for (const [k, rec] of this.currentMap.entries()) {
          const [lx, ly] = parseCoordKey(k);
          const mergedKey = coordKey(matchedX + (lx - this.x), matchedY + (ly - this.y));
          if (!targetSeg.has(mergedKey)) {
            targetSeg.set(mergedKey, rec);
          }
        }
        const lastWarp = this.warpLinks[this.warpLinks.length - 1];
        if (lastWarp && lastWarp.toSegment === this.segmentIndex) {
          lastWarp.toSegment = segIdx;
          lastWarp.toPos = [matchedX, matchedY];
          lastWarp.observedTurn = turn;
        }
        this.segments.pop();
        this.segmentIndex = segIdx;
        this.x = matchedX;
        this.y = matchedY;
        this.frameVersionCount += 1;
        this.enemySightings.clear();
        return true;
      }
    }
    return false;
  }

  public getStats() {
    return {
      turnsObserved: this.lastTurn,
      estimatedTotalScore: 300 * this.lastTurn + this.actionScore + this.itemScore,
      estimatedActionScore: this.actionScore,
      estimatedItemScore: this.itemScore,
      holeRevisits: this.holeRevisits,
      hazardHits: this.hazardHits,
      pickups: { ...this.pickups },
      unknownTiles: [...this.unknownTiles].sort((a, b) => a - b),
      segmentCount: this.segments.length,
      globalMapLocked: this.isGlobalMapLocked(),
      warpLinksCount: this.warpLinks.length,
    };
  }

  private setTile(
    x: number,
    y: number,
    value: number,
    turn: number,
    visitedIncrement = 0,
  ): void {
    const info = getTileInfo(value);
    if (!info.known) {
      if (!this.unknownTiles.has(value)) {
        this.lastEventFlags.newUnknownTiles.push(value);
      }
      this.unknownTiles.add(value);
    }
    const key = coordKey(x, y);
    const existing = this.currentMap.get(key);
    this.currentMap.set(key, {
      value,
      firstSeenTurn: existing ? existing.firstSeenTurn : turn,
      lastSeenTurn: turn,
      visitedCount: (existing ? existing.visitedCount : 0) + visitedIncrement,
      fromGlobalMap: false,
    });
  }

  private countMismatches(
    centerX: number,
    centerY: number,
    values: number[],
    isCmd1: boolean,
  ): number {
    let mismatches = 0;
    for (let i = 0; i < 9; i++) {
      if (i === 4) continue;
      const val = values[i];
      if (val === undefined) continue;
      const ox = (i % 3) - 1;
      const oy = Math.floor(i / 3) - 1;
      const existing = this.currentMap.get(coordKey(centerX + ox, centerY + oy));
      if (!existing) continue;
      if (existing.value === val) continue;
      if (existing.value >= 1000 || val >= 1000) continue;
      if (!isCmd1 && existing.value === 0 && val === 3) continue;
      mismatches += 1;
    }
    return mismatches;
  }

  private startNewSegment(warpTileValue: number | null, fromX: number, fromY: number, turn: number): void {
    const prevSegment = this.segmentIndex;
    this.segments.push(new Map());
    this.segmentIndex = this.segments.length - 1;
    this.x = 0;
    this.y = 0;
    this.trail = [[0, 0]];
    this.lastMoveDir = null;
    this.globalOffset = null;
    this.frameVersionCount += 1;
    // 敵の目撃位置は古い座標系なので捨てる（新しい座標系で見え直したら記録される）
    this.enemySightings.clear();
    this.warpLinks.push({
      tileValue: warpTileValue ?? -1,
      fromSegment: prevSegment,
      fromPos: [fromX, fromY],
      toSegment: this.segmentIndex,
      toPos: [0, 0],
      observedTurn: turn,
    });
  }

  private recordLanding(landedValue: number | null, previouslyVisited: boolean): void {
    if (landedValue === null) return;
    const info = getTileInfo(landedValue);
    this.itemScore += info.score;
    const key = String(landedValue);
    this.pickups[key] = (this.pickups[key] ?? 0) + 1;
    if (landedValue === 0 && previouslyVisited) {
      this.holeRevisits += 1;
    }
    if (info.hazard) {
      this.hazardHits += 1;
    }
  }

  public applyObservation(
    phase: "CMD1" | "CMD2",
    command: string,
    values: number[] | null,
    turn: number,
  ): void {
    this.lastTurn = Math.max(this.lastTurn, turn);
    this.lastEventFlags = {
      warped: false,
      blocked: false,
      newUnknownTiles: [],
      globalLocalized: false,
    };

    const spec: CommandSpec | undefined =
      phase === "CMD1"
        ? CMD1_SPECS[command as Cmd1Command]
        : CMD2_SPECS[command as Cmd2Command];

    if (!spec) {
      return;
    }

    this.actionScore += spec.estActionCost;

    const prevX = this.x;
    const prevY = this.y;
    let nextX = prevX + spec.move[0];
    let nextY = prevY + spec.move[1];
    const hasMove = spec.move[0] !== 0 || spec.move[1] !== 0;

    const preKnownLanding = this.getTile(nextX, nextY)?.value ?? null;
    const preLandingVisited = (this.getTile(nextX, nextY)?.visitedCount ?? 0) > 0;
    let warped = false;
    let blocked = false;

    if (
      values &&
      values.length >= 9 &&
      spec.obsShape === "3x3" &&
      spec.obsOffset[0] === 0 &&
      spec.obsOffset[1] === 0 &&
      hasMove
    ) {
      const candMismatch = this.countMismatches(nextX, nextY, values, phase === "CMD1");
      const stayMismatch = this.countMismatches(prevX, prevY, values, phase === "CMD1");
      if (preKnownLanding === 10 && stayMismatch <= candMismatch) {
        nextX = prevX;
        nextY = prevY;
        blocked = true;
      } else if (candMismatch >= 3) {
        if (stayMismatch <= 1) {
          nextX = prevX;
          nextY = prevY;
          blocked = true;
        } else {
          this.startNewSegment(preKnownLanding, nextX, nextY, turn);
          nextX = 0;
          nextY = 0;
          warped = true;
        }
      }
    }

    this.lastEventFlags.warped = warped;
    this.lastEventFlags.blocked = blocked;

    if (!warped && spec.put3Dir) {
      const [pdx, pdy] = DIR_DELTA[spec.put3Dir];
      this.setTile(prevX + pdx, prevY + pdy, 3, turn, 0);
    }

    if (!blocked && hasMove) {
      let landedVal: number | null = preKnownLanding;
      if (
        phase === "CMD2" &&
        spec.obsShape === "3x3" &&
        spec.obsOffset[0] === 0 &&
        spec.obsOffset[1] === 0 &&
        values &&
        values[4] !== undefined &&
        values[4] < 1000
      ) {
        landedVal = values[4];
      }
      this.recordLanding(landedVal, preLandingVisited);

      if (!warped) {
        this.x = nextX;
        this.y = nextY;
        this.trail.push([this.x, this.y]);
        if (this.trail.length > 80) this.trail.shift();
      }
      this.lastMoveDir = spec.walkDir ?? null;
    } else if (!hasMove && spec.category === "get_ready") {
      // 実測: 静止 gr でも現在地への再着地扱いになり、穴(0)なら -20 が入る
      // (room3: gr×9 → item -180 / room10: gr×35 → item -700 が公式との差に一致)
      const here = this.getTile(this.x, this.y)?.value;
      this.recordLanding(here === undefined || here >= 1000 ? 0 : here, true);
    }

    if (values && values.length > 0) {
      if (spec.obsShape === "3x3" && values.length >= 9) {
        const cx = this.x + spec.obsOffset[0];
        const cy = this.y + spec.obsOffset[1];

        for (let i = 0; i < 9; i++) {
          const val = values[i];
          if (val === undefined) continue;
          const ox = (i % 3) - 1;
          const oy = Math.floor(i / 3) - 1;

          if (i === 4 && spec.obsOffset[0] === 0 && spec.obsOffset[1] === 0) {
            if (val >= 1000) this.selfTileId = val;
            this.setTile(cx, cy, 0, turn, hasMove && !blocked ? 1 : 0);
          } else if (val >= 1000 && val !== this.selfTileId) {
            // 他プレイヤーは動くのでタイルとしては保存せず、目撃情報として記録する
            this.enemySightings.set(val, { x: cx + ox, y: cy + oy, tileId: val, lastSeenTurn: turn });
          } else {
            this.setTile(cx + ox, cy + oy, val, turn, 0);
          }
        }

        if (spec.obsOffset[0] === 0 && spec.obsOffset[1] === 0) {
          this.lastGridValues = values.slice(0, 9);
          if (warped) {
            this.tryLoopClosureWithPreviousSegments(this.lastGridValues, turn);
          }
          if (this.globalGrid && !this.globalOffset) {
            this.tryLocalizeOnGlobalGrid();
          }
        }
      } else if (spec.obsShape === "ray" && spec.rayDir) {
        this.setTile(this.x, this.y, 0, turn, hasMove && !blocked ? 1 : 0);
        const [rdx, rdy] = DIR_DELTA[spec.rayDir];
        for (let k = 0; k < values.length; k++) {
          const val = values[k];
          if (val === undefined) continue;
          if (val >= 1000 && val !== this.selfTileId) {
            this.enemySightings.set(val, { x: this.x + rdx * (k + 1), y: this.y + rdy * (k + 1), tileId: val, lastSeenTurn: turn });
            continue;
          }
          this.setTile(this.x + rdx * (k + 1), this.y + rdy * (k + 1), val, turn, 0);
        }
      }
    }
  }

  /**
   * 指定マス (ローカル座標) への最安経路の最初の1歩を返す。目標が未知マスでもよい（隣まで既知なら到達可能とみなす）。
   * 到達済みなら "here"、経路が無ければ null。メインエージェントの作戦 (plan.target) 追従に使う。
   */
  public firstStepTowards(tx: number, ty: number, maxSteps = 60): { dir: Dir; distance: number } | "here" | null {
    if (tx === this.x && ty === this.y) return "here";
    const targetKey = coordKey(tx, ty);
    const walkCost = -CMD2_SPECS.wu.estActionCost;
    const dist = new Map([[coordKey(this.x, this.y), 0]]);
    const queue: { x: number; y: number; cost: number; steps: number; first: Dir | null }[] = [
      { x: this.x, y: this.y, cost: 0, steps: 0, first: null },
    ];
    while (queue.length > 0) {
      queue.sort((a, b) => a.cost - b.cost || a.steps - b.steps);
      const cur = queue.shift()!;
      if (cur.steps >= maxSteps) continue;
      for (const dir of DIRS) {
        const [dx, dy] = DIR_DELTA[dir];
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nKey = coordKey(nx, ny);
        const first = cur.first ?? dir;
        if (nKey === targetKey) return { dir: first, distance: cur.steps + 1 };
        const rec = this.currentMap.get(nKey);
        if (!rec) continue;
        const info = getTileInfo(rec.value);
        if (!info.passable || info.hazard) continue;
        const nextCost = cur.cost + walkCost + Math.max(0, -info.score) + getHoleRevisitPenalty(rec);
        if (nextCost >= (dist.get(nKey) ?? Infinity)) continue;
        dist.set(nKey, nextCost);
        queue.push({ x: nx, y: ny, cost: nextCost, steps: cur.steps + 1, first });
      }
    }
    return null;
  }

  /**
   * 目標マスまでの経路（自分の位置〜目標、ローカル座標）。コストは firstStepTowards と同じ（穴・マイナスマスを避ける）。
   * 表示用。到達できなければ null。
   */
  public routeTo(tx: number, ty: number, maxSteps = 60): [number, number][] | null {
    const startKey = coordKey(this.x, this.y);
    const targetKey = coordKey(tx, ty);
    if (startKey === targetKey) return [[this.x, this.y]];
    const walkCost = -CMD2_SPECS.wu.estActionCost;
    const dist = new Map([[startKey, 0]]);
    const parent = new Map<string, string>();
    const queue: { x: number; y: number; cost: number; steps: number }[] = [{ x: this.x, y: this.y, cost: 0, steps: 0 }];
    const build = (key: string): [number, number][] => {
      const out: [number, number][] = [];
      for (let k: string | undefined = key; k !== undefined; k = parent.get(k)) out.push(parseCoordKey(k));
      return out.reverse();
    };
    while (queue.length > 0) {
      queue.sort((a, b) => a.cost - b.cost || a.steps - b.steps);
      const cur = queue.shift()!;
      if (cur.steps >= maxSteps) continue;
      const curKey = coordKey(cur.x, cur.y);
      for (const dir of DIRS) {
        const [dx, dy] = DIR_DELTA[dir];
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nKey = coordKey(nx, ny);
        if (nKey === targetKey) {
          parent.set(nKey, curKey);
          return build(nKey);
        }
        const rec = this.currentMap.get(nKey);
        if (!rec) continue;
        const info = getTileInfo(rec.value);
        if (!info.passable || info.hazard) continue;
        const nextCost = cur.cost + walkCost + Math.max(0, -info.score) + getHoleRevisitPenalty(rec);
        if (nextCost >= (dist.get(nKey) ?? Infinity)) continue;
        dist.set(nKey, nextCost);
        parent.set(nKey, curKey);
        queue.push({ x: nx, y: ny, cost: nextCost, steps: cur.steps + 1 });
      }
    }
    return null;
  }

  public findPathTargets(maxSteps = 35): {
    topValueTargets: PathTarget[];
    nearestFrontiers: PathTarget[];
  } {
    const startKey = coordKey(this.x, this.y);
    const dist = new Map([[startKey, 0]]);
    const queue: {
      x: number; y: number; cost: number; steps: number; holes: number;
      revisitPenalty: number; firstStep: Dir | null;
    }[] = [
      { x: this.x, y: this.y, cost: 0, steps: 0, holes: 0, revisitPenalty: 0, firstStep: null },
    ];

    const valueTargets: PathTarget[] = [];
    const frontierTargets: PathTarget[] = [];
    const seenFrontiers = new Set<string>();
    const walkCost = -CMD2_SPECS.wu.estActionCost;

    const dirOrder: Dir[] = this.lastMoveDir
      ? [
          this.lastMoveDir,
          ...DIRS.filter((d) => d !== this.lastMoveDir && d !== OPPOSITE_DIR[this.lastMoveDir!]),
          OPPOSITE_DIR[this.lastMoveDir],
        ]
      : DIRS;

    while (queue.length > 0) {
      queue.sort((a, b) => a.cost - b.cost || a.steps - b.steps);
      const cur = queue.shift()!;
      const curKey = coordKey(cur.x, cur.y);
      if (cur.cost !== dist.get(curKey)) continue;
      const tile = this.currentMap.get(curKey);
      if (tile && cur.firstStep) {
        const info = getTileInfo(tile.value);
        if (info.score > 0) {
          valueTargets.push({
            x: cur.x,
            y: cur.y,
            tileValue: tile.value,
            tileLabel: info.label,
            distance: cur.steps,
            holeSteps: cur.holes,
            estimatedNetGain: info.score - (cur.cost - cur.revisitPenalty),
            revisitPenalty: cur.revisitPenalty,
            firstStep: cur.firstStep,
            recommendedCmd2: `w${cur.firstStep}` as Cmd2Command,
          });
        }
      }
      if (cur.steps >= maxSteps) continue;

      for (const dir of dirOrder) {
        const [dx, dy] = DIR_DELTA[dir];
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nKey = coordKey(nx, ny);
        const firstStep = cur.firstStep ?? dir;
        const rec = this.currentMap.get(nKey);

        if (!rec) {
          if (!seenFrontiers.has(nKey)) {
            seenFrontiers.add(nKey);
            frontierTargets.push({
              x: nx,
              y: ny,
              tileValue: null,
              tileLabel: "未探索フロンティア",
              distance: cur.steps + 1,
              holeSteps: cur.holes,
              estimatedNetGain: 10 - (cur.cost - cur.revisitPenalty + walkCost),
              revisitPenalty: cur.revisitPenalty,
              firstStep,
              recommendedCmd2: `w${firstStep}` as Cmd2Command,
            });
          }
          continue;
        }

        const info = getTileInfo(rec.value);
        if (!info.passable || info.hazard) continue;

        const revisitPenalty = getHoleRevisitPenalty(rec);
        const nextCost = cur.cost + walkCost + Math.max(0, -info.score) + revisitPenalty;
        if (nextCost >= (dist.get(nKey) ?? Infinity)) continue;
        dist.set(nKey, nextCost);
        queue.push({
          x: nx,
          y: ny,
          cost: nextCost,
          steps: cur.steps + 1,
          holes: cur.holes + (rec.value === 0 ? 1 : 0),
          revisitPenalty: cur.revisitPenalty + revisitPenalty,
          firstStep,
        });
      }
    }

    // Rank before truncating: equally close routes over fresh ground should not
    // disappear from the shortlist behind routes over visited holes.
    valueTargets.sort((a, b) => getPathUtility(b) - getPathUtility(a) || a.distance - b.distance);

    // Tie-break only: the unseen extension of a straight abyss may be blocked.
    // Prefer observing an open frontier, without marking the extension impassable.
    const extendsAbyss = (t: PathTarget) => DIRS.some((dir) => {
      const [dx, dy] = DIR_DELTA[dir];
      return this.getTile(t.x + dx, t.y + dy)?.value === 12 &&
        this.getTile(t.x + 2 * dx, t.y + 2 * dy)?.value === 12;
    });
    frontierTargets.sort((a, b) => getPathUtility(b) - getPathUtility(a) ||
      Number(extendsAbyss(a)) - Number(extendsAbyss(b)) || a.distance - b.distance);

    return {
      topValueTargets: valueTargets.slice(0, 8),
      nearestFrontiers: frontierTargets.slice(0, 4),
    };
  }

  public evaluateCandidates(phase: "CMD1" | "CMD2"): EvaluationSummary {
    const { topValueTargets, nearestFrontiers } = this.findPathTargets();
    const preferredDir =
      topValueTargets[0] && topValueTargets[0].estimatedNetGain > -40
        ? topValueTargets[0].firstStep
        : nearestFrontiers[0]?.firstStep ?? null;

    const specs = phase === "CMD1" ? CMD1_SPECS : CMD2_SPECS;
    const candidates: CandidateEvaluation[] = [];

    for (const [cmd, spec] of Object.entries(specs) as [string, CommandSpec][]) {
      const lx = this.x + spec.move[0];
      const ly = this.y + spec.move[1];
      const hasMove = spec.move[0] !== 0 || spec.move[1] !== 0;

      const rec = this.getTile(lx, ly);
      const tileVal = rec ? rec.value : null;
      const info = tileVal !== null ? getTileInfo(tileVal) : null;

      let safety: SafetyLevel;
      if (!hasMove) {
        safety = "SAFE";
      } else {
        safety = classifyTileSafety(tileVal);
      }

      // 静止 gr も現在地への再着地扱い（未知/自機表示なら穴とみなす）
      const stayVal = tileVal === null || tileVal >= 1000 ? 0 : tileVal;
      const tileScore = hasMove
        ? info ? info.score : 0
        : spec.category === "get_ready" ? getTileInfo(stayVal).score : 0;
      const netImmediate = spec.estActionCost + tileScore;

      const notes: string[] = [];
      if (spec.highFatigue) notes.push("HIGH_FATIGUE");
      if (spec.put3Dir) notes.push(`PUT3_${spec.put3Dir.toUpperCase()}_CW_MOVE`);
      if (spec.category === "walk" && preferredDir && spec.walkDir === preferredDir) {
        notes.push("ON_BEST_PATH");
      }
      if (
        spec.category === "get_ready" &&
        hasMove &&
        safety === "SAFE" &&
        tileScore > 0
      ) {
        notes.push("DOUBLE_COLLECT_OPPORTUNITY");
      }
      if (safety === "HAZARD") notes.push("DANGER_TRAP");
      if (safety === "BLOCKED") notes.push("IMPASSABLE");

      candidates.push({
        command: cmd,
        category: spec.category,
        landingPos: [lx, ly],
        knownTile: tileVal,
        knownTileLabel: info ? info.label : null,
        safety,
        estimatedActionCost: spec.estActionCost,
        estimatedTileScore: tileScore,
        estimatedNetImmediate: netImmediate,
        highFatigue: spec.highFatigue,
        note: notes.length > 0 ? notes.join(",") : null,
      });
    }

    return {
      phase,
      segmentId: this.segmentIndex,
      position: [this.x, this.y],
      globalPosition: this.getGlobalPosition(),
      globalMapLocked: this.isGlobalMapLocked(),
      candidates,
      topValueTargets,
      nearestFrontiers,
      recommendedFallback: this.pickSafeFallback(phase),
    };
  }

  public pickSafeFallback(phase: "CMD1" | "CMD2"): string {
    if (phase === "CMD1") {
      let bestCmd: Cmd1Command = "gr";
      let bestScore = -10;
      for (const dir of DIRS) {
        const cmd = `gr${dir}` as Cmd1Command;
        const [dx, dy] = DIR_DELTA[dir];
        const rec = this.getTile(this.x + dx, this.y + dy);
        if (!rec) continue;
        const info = getTileInfo(rec.value);
        if (!info.passable || info.hazard || info.score <= 0) continue;
        const net = info.score - 15;
        if (net > bestScore) {
          bestScore = net;
          bestCmd = cmd;
        }
      }
      return bestCmd;
    }

    const { topValueTargets, nearestFrontiers } = this.findPathTargets();
    const walkDirs: Dir[] = this.lastMoveDir
      ? [
          this.lastMoveDir,
          ...DIRS.filter((d) => d !== this.lastMoveDir && d !== OPPOSITE_DIR[this.lastMoveDir!]),
          OPPOSITE_DIR[this.lastMoveDir],
        ]
      : DIRS;

    const safeWalks: { cmd: Cmd2Command; score: number }[] = [];
    for (let i = 0; i < walkDirs.length; i++) {
      const dir = walkDirs[i]!;
      const [dx, dy] = DIR_DELTA[dir];
      const rec = this.getTile(this.x + dx, this.y + dy);
      const val = rec?.value ?? null;
      const safety = classifyTileSafety(val);
      if (safety === "HAZARD" || safety === "BLOCKED") continue;

      let score = val !== null ? getTileInfo(val).score - 15 : 5;
      if (topValueTargets[0] && topValueTargets[0].firstStep === dir && topValueTargets[0].estimatedNetGain > -40) {
        score += 200;
      } else if (nearestFrontiers[0] && nearestFrontiers[0].firstStep === dir) {
        score += 80;
      }
      score += (walkDirs.length - i) * 0.1;
      safeWalks.push({ cmd: `w${dir}` as Cmd2Command, score });
    }

    if (safeWalks.length > 0) {
      safeWalks.sort((a, b) => b.score - a.score);
      return safeWalks[0]!.cmd;
    }

    for (const cmd of ["keilu", "keiru", "keild", "keird"] as Cmd2Command[]) {
      const [dx, dy] = CMD2_SPECS[cmd].move;
      const rec = this.getTile(this.x + dx, this.y + dy);
      const safety = classifyTileSafety(rec?.value ?? null);
      if (safety !== "HAZARD" && safety !== "BLOCKED") {
        return cmd;
      }
    }

    return "du";
  }

  public renderAscii(radius = 7): string {
    const r = Math.max(2, Math.min(20, radius));
    const lines: string[] = [];
    for (let dy = -r; dy <= r; dy++) {
      let row = "";
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) {
          row += "@";
          continue;
        }
        const rec = this.getTile(this.x + dx, this.y + dy);
        if (!rec) {
          row += "?";
        } else {
          row += getTileInfo(rec.value).symbol;
        }
      }
      lines.push(row);
    }
    lines.push("Legend: @=You .=0(-20) ,=2(+10) *=3(+30) T=1(+50) A=9(+100) F=5-8(+125..200) G=70-79(+400) W=Warp B=BlackStar #=10Wall !=4Geode X=12Abyss ?=Unseen");
    return lines.join("\n");
  }

  /**
   * メインエージェントに渡すマップ。Web マップが位置合わせ済みなら全体（観測で上書き済み）、なければ自分で観測した範囲すべて。
   * 座標はローカル座標（pos・目標候補・plan の target と同じ）。上に x、左に y の目盛りを付ける。
   * 切り出しはしない（常に全体を渡す）。
   */
  public renderAgentMap(opts: { enemies?: { x: number; y: number; stale: boolean }[]; planTarget?: [number, number] | null }): string {
    let minX = this.x, maxX = this.x, minY = this.y, maxY = this.y;
    const extra: [number, number][] = [...(opts.enemies ?? []).map((e): [number, number] => [e.x, e.y]), ...(opts.planTarget ? [opts.planTarget] : [])];
    for (const [kx, ky] of [...[...this.currentMap.keys()].map(parseCoordKey), ...extra]) {
      if (kx < minX) minX = kx;
      if (kx > maxX) maxX = kx;
      if (ky < minY) minY = ky;
      if (ky > maxY) maxY = ky;
    }
    const enemyAt = new Map((opts.enemies ?? []).map((e) => [coordKey(e.x, e.y), e.stale ? "e" : "E"]));
    const yw = Math.max(String(minY).length, String(maxY).length);
    const pad = " ".repeat(yw + 1);
    let tens = pad, units = pad;
    for (let x = minX; x <= maxX; x++) {
      units += String(Math.abs(x) % 10);
      // 十の位は x が10の倍数の列にだけ書く。負の列は "-"
      tens += x % 10 === 0 ? String(Math.floor(Math.abs(x) / 10) % 10) : x < 0 ? "-" : " ";
    }
    const lines = [tens, units];
    for (let y = minY; y <= maxY; y++) {
      let row = `${String(y).padStart(yw)} `;
      for (let x = minX; x <= maxX; x++) {
        const k = coordKey(x, y);
        if (x === this.x && y === this.y) row += "@";
        else if (enemyAt.has(k)) row += enemyAt.get(k);
        else if (opts.planTarget && opts.planTarget[0] === x && opts.planTarget[1] === y) row += "P";
        else {
          const rec = this.currentMap.get(k);
          row += !rec ? "?" : rec.value >= 1000 ? "E" : getTileInfo(rec.value).symbol;
        }
      }
      lines.push(row);
    }
    const src = this.globalGrid && this.globalOffset ? "Webマップ全体（自分の観測で上書き済み）" : "自作マップ（これまでに観測した範囲）";
    lines.unshift(`map: ${src} x=${minX}..${maxX} y=${minY}..${maxY}（上の2行が x の目盛り: 1行目は10の倍数の列に十の位・負の列に "-"、2行目は一の位。左が y。x は右へ、y は下へ増える）`);
    lines.push("Legend: @=You E=敵 e=敵(古い目撃) P=作戦目標 .=0穴(-20) ,=2土(+10) *=3(+30) T=1(+50) A=9(+100) F=5-8(+125..200) G=70-79(+400) W=Warp B=BlackStar #=10岩盤(通行不可) !=4ジオード(-1000) X=12奈落(-600) ?=未知");
    return lines.join("\n");
  }

  public inspect(radius = 8): MapInspectResult {
    const knownTargets: MapInspectResult["knownTargets"] = [];
    for (const [k, rec] of this.currentMap.entries()) {
      const info = getTileInfo(rec.value);
      if (info.score > 0) {
        const [x, y] = parseCoordKey(k);
        knownTargets.push({
          x,
          y,
          value: rec.value,
          label: info.label,
          score: info.score,
        });
      }
    }
    knownTargets.sort(
      (a, b) =>
        b.score - a.score ||
        Math.abs(a.x - this.x) + Math.abs(a.y - this.y) - (Math.abs(b.x - this.x) + Math.abs(b.y - this.y)),
    );

    return {
      segmentId: this.segmentIndex,
      segmentCount: this.segments.length,
      position: [this.x, this.y],
      globalPosition: this.getGlobalPosition(),
      globalMapLocked: this.isGlobalMapLocked(),
      ascii: this.renderAscii(radius),
      knownTargets: knownTargets.slice(0, 20),
      unknownTileIds: [...this.unknownTiles].sort((a, b) => a - b),
      warpLinks: [...this.warpLinks],
    };
  }

  public toSnapshot(): WorldMapSnapshot {
    const tiles: WorldMapSnapshot["tiles"] = [];
    for (const [k, rec] of this.currentMap.entries()) {
      const [x, y] = parseCoordKey(k);
      tiles.push({
        x,
        y,
        value: rec.value,
        visitedCount: rec.visitedCount,
      });
    }
    return {
      turn: this.lastTurn,
      segmentId: this.segmentIndex,
      segmentCount: this.segments.length,
      position: [this.x, this.y],
      globalPosition: this.getGlobalPosition(),
      globalMapLocked: this.isGlobalMapLocked(),
      lastMoveDir: this.lastMoveDir,
      lastGrid: this.lastGridValues ? [...this.lastGridValues] : null,
      stats: this.getStats(),
      tiles,
      warpLinks: [...this.warpLinks],
    };
  }

  /**
   * 現在の盤面（Webマップ統合済みなら全体2D配列、未取得ならReturnCode SLAMのバウンディングボックス配列）と
   * 予測着地マス・最短ターゲット経路を WebUI 描画用フォーマットで返す。
   */
  public buildUiMapState(plannedCmd?: string | null, planTarget?: [number, number] | null): {
    source: "web_map" | "slam";
    stageName: string | null;
    width: number;
    height: number;
    grid: (number | null)[][];
    playerPos: [number, number] | null;
    trail: [number, number][];
    plannedPath: [number, number][];
    nextLandingPos: [number, number] | null;
    localAscii: string;
    /** 表示座標での自機・他プレイヤー。tileId が不明な敵は null（UI は仮アイコンを出す） */
    players: UiPlayerMarker[];
    /** 盤面データを最後に更新したターン */
    updatedTurn: number;
    /** 作戦目標の表示座標（範囲外・作戦なしなら null） */
    planCell: [number, number] | null;
  } {
    const toCell = (ox: number, oy: number, w: number, h: number): [number, number] | null => {
      if (!planTarget) return null;
      const cx = planTarget[0] + ox;
      const cy = planTarget[1] + oy;
      return cx >= 0 && cy >= 0 && cx < w && cy < h ? [cx, cy] : null;
    };
    let nextLocal: [number, number] | null = null;
    if (plannedCmd) {
      const spec =
        CMD1_SPECS[plannedCmd as Cmd1Command] ??
        CMD2_SPECS[plannedCmd as Cmd2Command];
      if (spec && (spec.move[0] !== 0 || spec.move[1] !== 0)) {
        nextLocal = [this.x + spec.move[0], this.y + spec.move[1]];
      }
    }

    const { topValueTargets, nearestFrontiers } = this.findPathTargets(25);
    const mainGoal =
      topValueTargets[0] && topValueTargets[0].estimatedNetGain > -45
        ? topValueTargets[0]
        : nearestFrontiers[0] ?? null;

    // 黄色の線: メインの作戦目標があればそこへ、なければソルバーの当面の目標へ、実際に通る経路を描く
    const goal: [number, number] | null = planTarget ?? (mainGoal ? [mainGoal.x, mainGoal.y] : null);
    let localPlannedPath: [number, number][] = [[this.x, this.y]];
    if (goal) {
      localPlannedPath = this.routeTo(goal[0], goal[1]) ?? [[this.x, this.y], goal];
    } else if (nextLocal) {
      localPlannedPath.push(nextLocal);
    }

    // 1. Web マップがあり自機の位置合わせも済んでいれば、全体マップをベースに最新観測を上書きして返す
    //    （取れていない・位置が合わない間は 2. の自作マップ表示）
    if (this.globalGrid && this.globalGrid.length > 0 && this.globalGrid[0] && this.globalOffset) {
      const height = this.globalGrid.length;
      const width = this.globalGrid[0].length;
      const grid: (number | null)[][] = this.globalGrid.map((row) =>
        row.map((v) => (v >= 1000 ? 0 : v)),
      );
      const webPlayers: UiPlayerMarker[] = [];
      this.globalGrid.forEach((row, gy) =>
        row.forEach((v, gx) => {
          if (v >= 1000) {
            webPlayers.push({ x: gx, y: gy, role: v === this.selfTileId ? "self" : "enemy", tileId: v, lastSeenTurn: this.globalGridTurn, source: "web_map" });
          }
        }),
      );

      let playerPos: [number, number] | null = null;
      let trail: [number, number][] = [];
      let plannedPath: [number, number][] = [];
      let nextLandingPos: [number, number] | null = null;

      if (this.globalOffset) {
        const [ox, oy] = this.globalOffset;
        for (const [k, rec] of this.currentMap.entries()) {
          // Web マップ取得後に自分で観測したマスだけ上書き（Web マップの方が新しければそちらを優先）
          if (rec.fromGlobalMap || rec.lastSeenTurn <= this.globalGridTurn) continue;
          const [lx, ly] = parseCoordKey(k);
          const gx = lx + ox;
          const gy = ly + oy;
          if (gy >= 0 && gy < height && gx >= 0 && gx < width) {
            grid[gy]![gx] = rec.value;
          }
        }
        playerPos = [this.x + ox, this.y + oy];
        trail = this.trail
          .map(([tx, ty]): [number, number] => [tx + ox, ty + oy])
          .filter(([gx, gy]) => gx >= 0 && gx < width && gy >= 0 && gy < height);
        plannedPath = localPlannedPath
          .map(([px, py]): [number, number] => [px + ox, py + oy])
          .filter(([gx, gy]) => gx >= 0 && gx < width && gy >= 0 && gy < height);
        if (nextLocal) {
          const ngx = nextLocal[0] + ox;
          const ngy = nextLocal[1] + oy;
          if (ngx >= 0 && ngx < width && ngy >= 0 && ngy < height) {
            nextLandingPos = [ngx, ngy];
          }
        }
      }

      // 自機は自前の位置推定を正とし、Web マップ上の自機表示は除く（ずれていると二重表示になるため）
      const players: UiPlayerMarker[] = webPlayers.filter((p) => p.role === "enemy");
      if (playerPos) players.unshift({ x: playerPos[0], y: playerPos[1], role: "self", tileId: this.selfTileId, lastSeenTurn: this.lastTurn, source: "slam" });
      else players.unshift(...webPlayers.filter((p) => p.role === "self"));
      return {
        source: "web_map",
        stageName: this.stageName,
        width,
        height,
        grid,
        playerPos,
        trail,
        plannedPath,
        nextLandingPos,
        localAscii: this.renderAscii(6),
        players,
        updatedTurn: Math.max(this.globalGridTurn, this.lastTurn),
        planCell: this.globalOffset ? toCell(this.globalOffset[0], this.globalOffset[1], width, height) : null,
      };
    }

    // 2. ReturnCode SLAM モード: 観測済み座標のバウンディングボックスを2D配列化
    let minX = this.x - 4;
    let maxX = this.x + 4;
    let minY = this.y - 4;
    let maxY = this.y + 4;
    for (const [k] of this.currentMap.entries()) {
      const [tx, ty] = parseCoordKey(k);
      if (tx - 1 < minX) minX = tx - 1;
      if (tx + 1 > maxX) maxX = tx + 1;
      if (ty - 1 < minY) minY = ty - 1;
      if (ty + 1 > maxY) maxY = ty + 1;
    }

    const width = Math.max(9, Math.min(45, maxX - minX + 1));
    const height = Math.max(9, Math.min(45, maxY - minY + 1));
    const grid: (number | null)[][] = [];
    for (let gy = 0; gy < height; gy++) {
      const row: (number | null)[] = [];
      for (let gx = 0; gx < width; gx++) {
        const rec = this.getTile(minX + gx, minY + gy);
        row.push(rec ? rec.value : null);
      }
      grid.push(row);
    }

    return {
      source: "slam",
      stageName: this.stageName,
      width,
      height,
      grid,
      playerPos: [this.x - minX, this.y - minY],
      trail: this.trail.map(([tx, ty]): [number, number] => [tx - minX, ty - minY]),
      plannedPath: localPlannedPath.map(([px, py]): [number, number] => [px - minX, py - minY]),
      nextLandingPos: nextLocal ? [nextLocal[0] - minX, nextLocal[1] - minY] : null,
      localAscii: this.renderAscii(6),
      players: [
        { x: this.x - minX, y: this.y - minY, role: "self", tileId: this.selfTileId, lastSeenTurn: this.lastTurn, source: "slam" },
        ...[...this.enemySightings.values()]
          .map((e): UiPlayerMarker => ({ x: e.x - minX, y: e.y - minY, role: "enemy", tileId: e.tileId, lastSeenTurn: e.lastSeenTurn, source: "slam" }))
          .filter((p) => p.x >= 0 && p.x < width && p.y >= 0 && p.y < height),
      ],
      updatedTurn: this.lastTurn,
      planCell: toCell(-minX, -minY, width, height),
    };
  }
}
