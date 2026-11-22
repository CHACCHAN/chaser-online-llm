import { CMD2_SPECS, DIR_DELTA, DIRS, getTileInfo, type Cmd2Command, type Dir } from "../memory/world-map";
import { isPortalTile, type SimGame, type SimPlayer } from "./engine";

/**
 * シミュレータの他プレイヤー（方策を使わない相手）。どちらも地図を全部知っている。
 * - greedy（拾う）: 一番近い点のあるマスへ歩く
 * - hunter（狙う）: 近く（HUNT_RANGE 歩以内）に他のプレイヤーがいれば追いかけ、隣に来たらアイテムを置いて当てる。いなければ greedy と同じ
 */

const HUNT_RANGE = 12;

const safeCell = (game: SimGame, bot: SimPlayer, x: number, y: number) => {
  if (!game.inField(x, y)) return false;
  const v = game.grid[y]![x]!;
  const info = getTileInfo(v);
  return info.passable && !info.hazard && !isPortalTile(v) && !game.playerAt(x, y, bot);
};

/** 幅優先で、goal を満たす一番近いマスへの最初の一歩（maxDepth 歩まで） */
function stepToward(game: SimGame, bot: SimPlayer, goal: (x: number, y: number) => boolean, maxDepth = Infinity): Dir | null {
  const w = game.width;
  const h = game.height;
  const prev = new Int32Array(w * h).fill(-1);
  const depth = new Int32Array(w * h);
  const start = bot.y * w + bot.x;
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]!;
    const x = i % w;
    const y = Math.floor(i / w);
    if (i !== start && goal(x, y)) {
      let j = i;
      while (prev[j] !== start) j = prev[j]!;
      const dx = (j % w) - bot.x;
      const dy = Math.floor(j / w) - bot.y;
      return DIRS.find((d) => DIR_DELTA[d][0] === dx && DIR_DELTA[d][1] === dy) ?? null;
    }
    if (depth[i]! >= maxDepth) continue;
    for (const d of DIRS) {
      const nx = x + DIR_DELTA[d][0];
      const ny = y + DIR_DELTA[d][1];
      if (!game.inField(nx, ny)) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -1 || !safeCell(game, bot, nx, ny)) continue;
      prev[ni] = i;
      depth[ni] = depth[i]! + 1;
      queue.push(ni);
    }
  }
  return null;
}

const itemStep = (game: SimGame, bot: SimPlayer) =>
  stepToward(game, bot, (x, y) => {
    const v = game.grid[y]![x]!;
    return getTileInfo(v).score > 10 && !isPortalTile(v);
  });

/** 隣（上下左右）にいる他のプレイヤーの向き */
function adjacentPlayer(game: SimGame, bot: SimPlayer): Dir | null {
  return DIRS.find((d) => !!game.playerAt(bot.x + DIR_DELTA[d][0], bot.y + DIR_DELTA[d][1], bot)) ?? null;
}

/** 他のプレイヤーの隣のマスへ向かう一歩（近くにいなければ null） */
const huntStep = (game: SimGame, bot: SimPlayer) =>
  stepToward(game, bot, (x, y) => DIRS.some((d) => !!game.playerAt(x + DIR_DELTA[d][0], y + DIR_DELTA[d][1], bot)), HUNT_RANGE);

/** 動けない時の手（安全な隣へ。無ければ上） */
const anySafeWalk = (game: SimGame, bot: SimPlayer) =>
  DIRS.map((d) => `w${d}`).find((c) => {
    const [dx, dy] = DIR_DELTA[c[1] as Dir];
    return safeCell(game, bot, bot.x + dx, bot.y + dy);
  }) ?? "wu";

/** 拾う相手の1ターン（偽サーバでも使う） */
export function runBotTurn(game: SimGame, bot: SimPlayer): void {
  const d1 = itemStep(game, bot);
  game.act(bot, "CMD1", d1 ? `gr${d1}` : "gr");
  const d2 = itemStep(game, bot);
  game.act(bot, "CMD2", d2 ? `w${d2}` : anySafeWalk(game, bot));
  game.endTurn(bot);
}

/** 置いて当てる手（p*3s*）。置いた後に横へ動く先が安全な時だけ */
function attackCommand(game: SimGame, bot: SimPlayer, dir: Dir): string | null {
  const cmd = (Object.keys(CMD2_SPECS) as Cmd2Command[]).find((c) => CMD2_SPECS[c].put3Dir === dir && CMD2_SPECS[c].obsShape === "ray");
  if (!cmd) return null;
  const mv = CMD2_SPECS[cmd].move;
  return safeCell(game, bot, bot.x + mv[0], bot.y + mv[1]) ? cmd : null;
}

/** 狙う相手の1ターン */
export function runHunterTurn(game: SimGame, bot: SimPlayer): void {
  // もう隣にいれば動かずに待つ（CMD2 で当てる）
  const d1 = adjacentPlayer(game, bot) ? null : (huntStep(game, bot) ?? itemStep(game, bot));
  game.act(bot, "CMD1", d1 ? `gr${d1}` : "gr");
  const adj = adjacentPlayer(game, bot);
  const attack = adj ? attackCommand(game, bot, adj) : null;
  if (attack) {
    game.act(bot, "CMD2", attack);
  } else {
    const d2 = huntStep(game, bot) ?? itemStep(game, bot);
    game.act(bot, "CMD2", d2 ? `w${d2}` : anySafeWalk(game, bot));
  }
  game.endTurn(bot);
}
