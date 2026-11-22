import { CMD1_COMMANDS, CMD2_COMMANDS, DIR_DELTA, DIRS, getTileInfo, WorldMap } from "../memory/world-map";
import type { PolicyFn } from "../solver/policy";
import { isPortalTile, SimGame, totalScore, type SimPlayer } from "./engine";
import type { Scenario } from "./mapgen";

/**
 * シミュレータで1試合を行う。自分の手は本番と同じ WorldMap（観測の反映・位置合わせ）と方策で決める。
 * Webマップのある試合では、本番と同じく毎ターンの初めとワープの直後に全体マップを渡す。
 */

export interface EpisodeResult {
  scenario: string;
  webMap: boolean;
  totalTurns: number;
  score: number;
  action: number;
  item: number;
  hazardHits: number;
  /** 方策が合法でない手を返した・例外を投げた回数（安全な手で続けた） */
  policyErrors: number;
  /** 方策の判断にかかった時間（1フェーズの平均、ms） */
  msPerPhase: number;
  /** 他プレイヤーの得点 */
  opponents: number[];
  /** 再生用の記録（trace を頼んだ時だけ） */
  trace?: EpisodeTrace;
}

/** 1試合の再生用の記録（WebUI の「学習」画面で再生する） */
export interface EpisodeTrace {
  width: number;
  height: number;
  /** 始まりの地図 */
  grid: number[][];
  players: { id: number; self: boolean }[];
  frames: {
    turn: number;
    /** 各プレイヤーの位置（players と同じ順） */
    pos: [number, number][];
    scores: number[];
    /** 自分の CMD1・CMD2 */
    cmds: [string, string];
    /** 方策の判断の理由（CMD2） */
    reason: string;
    /** このターンに変わったマス [x, y, 新しい値] */
    changed: [number, number, number][];
  }[];
}

/** 他プレイヤー: 地図を全部知っていて、一番近い点のあるマスへ歩く */
function botStep(game: SimGame, bot: SimPlayer): string | null {
  const w = game.width;
  const h = game.height;
  const prev = new Int32Array(w * h).fill(-1);
  const start = bot.y * w + bot.x;
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]!;
    const x = i % w;
    const y = Math.floor(i / w);
    if (i !== start) {
      const v = game.grid[y]![x]!;
      if (getTileInfo(v).score > 10 && !isPortalTile(v)) {
        let j = i;
        while (prev[j] !== start) j = prev[j]!;
        const dx = (j % w) - bot.x;
        const dy = Math.floor(j / w) - bot.y;
        return DIRS.find((d) => DIR_DELTA[d][0] === dx && DIR_DELTA[d][1] === dy) ?? null;
      }
    }
    for (const d of DIRS) {
      const nx = x + DIR_DELTA[d][0];
      const ny = y + DIR_DELTA[d][1];
      if (!game.inField(nx, ny)) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -1) continue;
      const v = game.grid[ny]![nx]!;
      const info = getTileInfo(v);
      if (!info.passable || info.hazard || isPortalTile(v) || game.playerAt(nx, ny, bot)) continue;
      prev[ni] = i;
      queue.push(ni);
    }
  }
  return null;
}

/** 他プレイヤーの1ターン（偽サーバでも使う） */
export function runBotTurn(game: SimGame, bot: SimPlayer): void {
  const d1 = botStep(game, bot);
  game.act(bot, "CMD1", d1 ? `gr${d1}` : "gr");
  const d2 = botStep(game, bot);
  game.act(bot, "CMD2", d2 ? `w${d2}` : DIRS.map((d) => `w${d}`).find((c) => {
    const [dx, dy] = DIR_DELTA[c[1] as "u"];
    const v = game.tile(bot.x + dx, bot.y + dy);
    return v !== undefined && getTileInfo(v).passable && !getTileInfo(v).hazard && !isPortalTile(v) && !game.playerAt(bot.x + dx, bot.y + dy, bot);
  }) ?? "wu");
  game.endTurn(bot);
}

export function runEpisode(scn: Scenario, policy: PolicyFn, opts: { maxTurns?: number; onTurn?: (turn: number, game: SimGame) => void; trace?: boolean } = {}): EpisodeResult {
  const game = new SimGame(scn.grid, scn.starts, opts.maxTurns ? Math.min(opts.maxTurns, scn.totalTurns) : scn.totalTurns);
  const me = game.players[scn.self]!;
  const wm = new WorldMap();
  let policyErrors = 0;
  let phases = 0;
  let ms = 0;
  let lastReason = "";
  const trace: EpisodeTrace | undefined = opts.trace
    ? { width: game.width, height: game.height, grid: game.grid.map((r) => [...r]), players: game.players.map((p) => ({ id: p.id, self: p === me })), frames: [] }
    : undefined;
  let prevGrid = trace ? game.grid.map((r) => [...r]) : null;
  const web = () => {
    if (scn.webMap) wm.setGlobalGrid(game.webGrid(), [me.x, me.y], scn.name, game.turn, me.id, wm.getPosition());
  };
  const decide = (phase: "CMD1" | "CMD2"): string => {
    const legal: readonly string[] = phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const t0 = performance.now();
    let cmd: string;
    try {
      const d = policy(wm, phase, game.turn, { totalTurns: game.totalTurns });
      cmd = d.command;
      lastReason = d.reason;
    } catch {
      cmd = "";
    }
    ms += performance.now() - t0;
    phases += 1;
    if (!legal.includes(cmd)) {
      policyErrors += 1;
      cmd = wm.pickSafeFallback(phase);
    }
    return cmd;
  };

  let cmds: [string, string] = ["", ""];
  while (!game.over) {
    for (const p of game.players) {
      if (p !== me) {
        runBotTurn(game, p);
        continue;
      }
      web();
      const c1 = decide("CMD1");
      wm.applyObservation("CMD1", c1, game.act(me, "CMD1", c1), game.turn);
      if (wm.getLastEventFlags().warpPending) web();
      const c2 = decide("CMD2");
      wm.applyObservation("CMD2", c2, game.act(me, "CMD2", c2), game.turn);
      game.endTurn(me);
      cmds = [c1, c2];
    }
    if (trace && prevGrid) {
      const changed: [number, number, number][] = [];
      for (let y = 0; y < game.height; y++) {
        for (let x = 0; x < game.width; x++) {
          const v = game.grid[y]![x]!;
          if (prevGrid[y]![x] !== v) {
            changed.push([x, y, v]);
            prevGrid[y]![x] = v;
          }
        }
      }
      trace.frames.push({ turn: game.turn, pos: game.players.map((p) => [p.x, p.y]), scores: game.players.map((p) => totalScore(p.score)), cmds, reason: lastReason.slice(0, 160), changed });
    }
    opts.onTurn?.(game.turn, game);
    game.nextTurn();
  }
  return {
    scenario: scn.name,
    webMap: scn.webMap,
    totalTurns: game.totalTurns,
    score: totalScore(me.score),
    action: me.score.action,
    item: me.score.item,
    hazardHits: me.hazardHits,
    policyErrors,
    msPerPhase: phases ? Math.round((ms / phases) * 100) / 100 : 0,
    opponents: game.players.filter((p) => p !== me).map((p) => totalScore(p.score)),
    ...(trace ? { trace } : {}),
  };
}
