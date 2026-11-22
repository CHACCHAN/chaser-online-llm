import { isWarpTile } from "../memory/knowledge-store";
import { CMD1_SPECS, CMD2_SPECS, DIR_DELTA, getTileInfo, type Cmd1Command, type Cmd2Command } from "../memory/world-map";

/**
 * CHaserOnline003 のシミュレータ（ゲームの進行と得点）。
 *
 * ルールは knowledge/official-rules.md・knowledge/commands.md と、ハーネスの WorldMap の解釈（CMD1_SPECS/CMD2_SPECS の移動・観測の形）に合わせる。
 * 得点は getTileInfo（knowledge/tiles.json の実測値）を使うので、タイルの得点の置き場は1か所のまま。
 * 公式で分からない所（ワープの行き先・場外の扱いなど）は SimRules で切り替えられるようにし、本番の記録との照合（calibrate）で直していく。
 */

export interface SimScore {
  /** 動作得点（コマンドごと） */
  action: number;
  /** アイテム得点（踏んだマスの得点。穴 -20・罠を含む） */
  item: number;
  /** 終えたターン数（1ターン終えるごとに +300） */
  turns: number;
  /** プット得点（置いたものを相手に当てた） */
  put: number;
  /** プットダメージ（相手に当てられた） */
  putDamage: number;
}

export interface SimPlayer {
  id: number;
  x: number;
  y: number;
  score: SimScore;
  /** 罠（ジオード・奈落）を踏んだ回数 */
  hazardHits: number;
}

export interface SimRules {
  /** 1ターン終えるごとの得点 */
  turnBonus: number;
  /** 場外へ出ようとした時の得点（動かない） */
  offFieldPenalty: number;
  /** ワープの着地先のマスも踏んだことにする（得点が入り穴になる） */
  warpCollectsLanding: boolean;
  /**
   * 置く手（put）で隣の相手に当てた時の得点（当てた側 +、当てられた側 −）。公式の値は未確認なので既定は 0。
   * 実測: room455 の試合で公式のプットダメージ -44990（相手に当てられた）。分かったら合わせる
   */
  putHitItem: number;
  putHitSoil: number;
}

export const DEFAULT_RULES: SimRules = { turnBonus: 300, offFieldPenalty: -500, warpCollectsLanding: true, putHitItem: 0, putHitSoil: 0 };

/** ワープ（20〜53）の行き先のずれ。10の位 = 距離（2:10 3:5 4:6 5:15）、1の位 = 向き（0:右 1:左 2:上 3:下）。公式の表の読み方。実測との照合は calibrate で */
export function warpDelta(tile: number): [number, number] | null {
  const family = Math.floor(tile / 10);
  const dist = ({ 2: 10, 3: 5, 4: 6, 5: 15 } as Record<number, number>)[family];
  const dir = tile % 10;
  if (dist === undefined || dir > 3) return null;
  return ([[dist, 0], [-dist, 0], [0, -dist], [0, dist]] as [number, number][])[dir]!;
}

export const isBlackstar = (v: number) => v >= 60 && v <= 63;
export const isPortalTile = (v: number) => isWarpTile(v) || isBlackstar(v);
export const totalScore = (s: SimScore, rules: SimRules = DEFAULT_RULES) => s.turns * rules.turnBonus + s.action + s.item + s.put + s.putDamage;

export class SimGame {
  readonly width: number;
  readonly height: number;
  /** grid[y][x] = タイル（プレイヤーは入れない） */
  readonly grid: number[][];
  readonly players: SimPlayer[];
  /** 今のターン（1 から） */
  turn = 1;

  constructor(
    grid: number[][],
    starts: { id: number; x: number; y: number }[],
    readonly totalTurns: number,
    readonly rules: SimRules = DEFAULT_RULES,
  ) {
    this.grid = grid.map((r) => [...r]);
    this.height = this.grid.length;
    this.width = this.grid[0]?.length ?? 0;
    this.players = starts.map((s) => ({ ...s, score: { action: 0, item: 0, turns: 0, put: 0, putDamage: 0 }, hazardHits: 0 }));
    for (const p of this.players) this.grid[p.y]![p.x] = 0;
  }

  get over(): boolean {
    return this.turn > this.totalTurns;
  }

  inField(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  tile(x: number, y: number): number | undefined {
    return this.inField(x, y) ? this.grid[y]![x] : undefined;
  }

  playerAt(x: number, y: number, except?: SimPlayer): SimPlayer | undefined {
    return this.players.find((p) => p !== except && p.x === x && p.y === y);
  }

  /** 観測で見える値（他プレイヤーはその番号） */
  view(x: number, y: number, self: SimPlayer): number | undefined {
    if (!this.inField(x, y)) return undefined;
    if (self.x === x && self.y === y) return self.id;
    return this.playerAt(x, y, self)?.id ?? this.grid[y]![x];
  }

  /** Webマップ（MapView.jsp）と同じ形: 全マス + プレイヤーの番号 */
  webGrid(): number[][] {
    const g = this.grid.map((r) => [...r]);
    for (const p of this.players) g[p.y]![p.x] = p.id;
    return g;
  }

  /** 3×3 の観測。場外のマスは返さない（公式: 返り値の要素が減ったらフィールドの端） */
  private look3(cx: number, cy: number, self: SimPlayer, center?: number): number[] {
    const out: number[] = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const v = ox === 0 && oy === 0 && center !== undefined ? center : this.view(cx + ox, cy + oy, self);
        if (v !== undefined) out.push(v);
      }
    }
    return out;
  }

  /** マスを踏む（得点が入り穴になる。ワープ・ブラックスターは残って飛ぶ）。飛んだら入口の番号を返す */
  private land(p: SimPlayer, x: number, y: number): number | null {
    const v = this.grid[y]![x]!;
    const info = getTileInfo(v);
    p.score.item += info.score;
    if (info.hazard) p.hazardHits += 1;
    p.x = x;
    p.y = y;
    if (!isPortalTile(v)) {
      this.grid[y]![x] = 0;
      return null;
    }
    const dest = this.portalDest(v, x, y);
    if (dest && !this.playerAt(dest[0], dest[1], p) && getTileInfo(this.grid[dest[1]]![dest[0]]!).passable) {
      p.x = dest[0];
      p.y = dest[1];
      if (this.rules.warpCollectsLanding) {
        const lv = this.grid[dest[1]]![dest[0]]!;
        if (!isPortalTile(lv)) {
          const li = getTileInfo(lv);
          p.score.item += li.score;
          if (li.hazard) p.hazardHits += 1;
          this.grid[dest[1]]![dest[0]] = 0;
        }
      }
    }
    return v;
  }

  private portalDest(v: number, x: number, y: number): [number, number] | null {
    if (isBlackstar(v)) {
      // ブラックスター: 番号順の次のブラックスターへ（60→61→62→63→60）。無ければ飛ばない
      for (let k = 1; k <= 4; k++) {
        const want = 60 + ((v - 60 + k) % 4);
        for (let yy = 0; yy < this.height; yy++) {
          const xx = this.grid[yy]!.indexOf(want);
          if (xx >= 0 && (xx !== x || yy !== y)) return [xx, yy];
        }
      }
      return null;
    }
    const d = warpDelta(v);
    if (!d) return null;
    const tx = x + d[0];
    const ty = y + d[1];
    return this.inField(tx, ty) ? [tx, ty] : null;
  }

  /** 1フェーズ分の手を実行し、サーバと同じ形の返り値（観測）を返す */
  act(p: SimPlayer, phase: "CMD1" | "CMD2", command: string): number[] {
    const spec = phase === "CMD1" ? CMD1_SPECS[command as Cmd1Command] : CMD2_SPECS[command as Cmd2Command];
    if (!spec) throw new Error(`unknown ${phase} command: ${command}`);
    p.score.action += spec.estActionCost;
    const sx = p.x;
    const sy = p.y;

    // 置く手: 指定方向の隣へアイテム(3) / 土(2) を置く（プレイヤーのいるマス・岩盤・場外には置けない）
    const putDir = spec.put3Dir ?? spec.putDir;
    if (putDir) {
      const [dx, dy] = DIR_DELTA[putDir];
      const tx = sx + dx;
      const ty = sy + dy;
      const victim = this.playerAt(tx, ty, p);
      if (victim) {
        const hit = spec.put3Dir ? this.rules.putHitItem : this.rules.putHitSoil;
        p.score.put += hit;
        victim.score.putDamage -= hit;
      } else if (this.inField(tx, ty) && this.grid[ty]![tx] !== 10) {
        this.grid[ty]![tx] = spec.put3Dir ? 3 : 2;
      }
    }

    let portal: number | null = null;
    const moves = spec.move[0] !== 0 || spec.move[1] !== 0;
    if (moves) {
      const tx = sx + spec.move[0];
      const ty = sy + spec.move[1];
      if (!this.inField(tx, ty)) {
        p.score.item += this.rules.offFieldPenalty;
      } else if (this.playerAt(tx, ty, p)) {
        // 他プレイヤーのマスへは入れない
      } else if (!getTileInfo(this.grid[ty]![tx]!).passable) {
        p.score.item += getTileInfo(this.grid[ty]![tx]!).score; // 岩盤 -10
      } else {
        portal = this.land(p, tx, ty);
      }
    } else if (spec.category === "get_ready") {
      // 静止 gr: 今いるマス（穴）にもう一度着地した扱い（実測: 穴なら -20）
      p.score.item += getTileInfo(this.grid[p.y]![p.x]!).score;
    }

    if (spec.obsShape === "ray" && spec.rayDir) {
      const [dx, dy] = DIR_DELTA[spec.rayDir];
      const out: number[] = [];
      for (let k = 1; k <= 9; k++) {
        const v = this.view(p.x + dx * k, p.y + dy * k, p);
        if (v === undefined) break;
        out.push(v);
      }
      return out;
    }
    if (portal !== null) {
      // ワープを踏んだ時の観測は入口のまわりで、中心がワープの番号（このあと着地先へ飛んでいる）
      const ex = sx + spec.move[0];
      const ey = sy + spec.move[1];
      return this.look3(ex + spec.obsOffset[0], ey + spec.obsOffset[1], p, spec.obsOffset[0] === 0 && spec.obsOffset[1] === 0 ? portal : undefined);
    }
    return this.look3(p.x + spec.obsOffset[0], p.y + spec.obsOffset[1], p);
  }

  /** プレイヤーがターンを終えた（+300） */
  endTurn(p: SimPlayer): void {
    p.score.turns += 1;
  }

  /** 全員が手を終えたら次のターンへ */
  nextTurn(): void {
    this.turn += 1;
  }
}
