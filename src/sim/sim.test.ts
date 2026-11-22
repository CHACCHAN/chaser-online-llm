import { describe, expect, test } from "bun:test";
import { WorldMap } from "../memory/world-map";
import { defaultParams } from "../solver/evaluator";
import * as evaluator from "../solver/evaluator";
import { planMove } from "../solver/planner";
import { makePlannerPolicy } from "../solver/policy";
import { SimGame, totalScore, warpDelta } from "./engine";
import { runEpisode } from "./episode";
import { makeScenario } from "./mapgen";
import { makeRng } from "./rng";

const grid5 = (fill = 2) => Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => fill));

describe("シミュレータ（engine）", () => {
  test("歩くと動作得点 -10 と着地のマスの得点が入り、マスは穴になる。観測は移動後の3×3で中心は自分の番号", () => {
    const g = grid5();
    g[2]![3] = 77;
    const game = new SimGame(g, [{ id: 1000, x: 2, y: 2 }], 10);
    const me = game.players[0]!;
    const obs = game.act(me, "CMD1", "grr");
    expect([me.x, me.y]).toEqual([3, 2]);
    expect(me.score.action).toBe(-10);
    expect(me.score.item).toBe(600); // tiles.json の実測値（77 = 600）
    expect(game.grid[2]![3]).toBe(0);
    expect(obs.length).toBe(9);
    expect(obs[4]).toBe(1000);
  });

  test("静止 gr は -20 と今いる穴の -20。場外へは動かず -500。端の観測は要素が減る", () => {
    const game = new SimGame(grid5(), [{ id: 1000, x: 0, y: 0 }], 10);
    const me = game.players[0]!;
    game.act(me, "CMD1", "gr");
    expect(me.score.action + me.score.item).toBe(-40);
    const obs = game.act(me, "CMD2", "wu");
    expect([me.x, me.y]).toEqual([0, 0]);
    expect(me.score.item).toBe(-20 - 500);
    expect(obs.length).toBe(4);
  });

  test("ワープは公式の表どおり（20 = 右へ10）。観測は入口のまわりで中心がワープの番号", () => {
    expect(warpDelta(20)).toEqual([10, 0]);
    expect(warpDelta(33)).toEqual([0, 5]);
    const g = Array.from({ length: 3 }, () => Array.from({ length: 14 }, () => 2));
    g[1]![1] = 20;
    const game = new SimGame(g, [{ id: 1000, x: 0, y: 1 }], 10);
    const me = game.players[0]!;
    const obs = game.act(me, "CMD1", "grr");
    expect(obs[4]).toBe(20);
    expect([me.x, me.y]).toEqual([11, 1]);
    expect(game.grid[1]![1]).toBe(20);
  });

  test("岩盤・他プレイヤーへは入れない。1ターン終えると +300", () => {
    const g = grid5();
    g[2]![3] = 10;
    const game = new SimGame(g, [{ id: 1000, x: 2, y: 2 }, { id: 2000, x: 2, y: 3 }], 10);
    const me = game.players[0]!;
    game.act(me, "CMD1", "grr");
    game.act(me, "CMD2", "wd");
    expect([me.x, me.y]).toEqual([2, 2]);
    game.endTurn(me);
    expect(totalScore(me.score)).toBe(300 - 20 - 10);
  });
});

describe("地図を作る（mapgen）", () => {
  test("同じ seed なら同じ地図", () => {
    const a = makeScenario(makeRng(7), { room: null });
    const b = makeScenario(makeRng(7), { room: null });
    expect(a.grid).toEqual(b.grid);
    expect(a.starts).toEqual(b.starts);
    const c = makeScenario(makeRng(8), { room: null });
    expect(c.grid).not.toEqual(a.grid);
  });
});

describe("経路探索（planner）", () => {
  test("見えている高得点へ向かい、罠を通らない", () => {
    // 自分(2,2)。右の (3,2) は奈落、上を回って (4,2) の 77 へ
    const g = grid5(0);
    g[2]![3] = 12;
    g[2]![4] = 77;
    const game = new SimGame(g, [{ id: 1000, x: 2, y: 2 }], 50);
    const wm = new WorldMap();
    wm.setGlobalGrid(game.webGrid(), [2, 2], "t", 1, 1000, wm.getPosition());
    const d = planMove(wm, { phase: "CMD1", turn: 1, remainingTurns: 50, params: defaultParams(), evaluator });
    expect(["gru", "grd"]).toContain(d.command);
    expect(d.insight.route[0]).toMatchObject({ value: expect.any(Number) });
  });

  test("シミュレータで1試合を最後まで打てる（合法手だけ・例外なし）", () => {
    const scn = makeScenario(makeRng(3), { room: null });
    const r = runEpisode(scn, makePlannerPolicy(defaultParams()), { maxTurns: 40 });
    expect(r.totalTurns).toBe(Math.min(40, scn.totalTurns));
    expect(r.policyErrors).toBe(0);
    expect(r.score).toBeGreaterThan(0);
  });
});

test("地図には tiles.json の他のタイル（fill に無いもの）も混ざる", async () => {
  const { fillWeights, loadProfile } = await import("./mapgen");
  const p = { ...loadProfile(null), fill: { "2": 10 }, otherTiles: 0.3 };
  const ids = fillWeights(p).map(([v]) => v);
  expect(ids).toContain(9); // tiles.json にある得点アイテム
  expect(ids.some((v) => v >= 1000 || (v >= 60 && v <= 63) || (v >= 20 && v <= 53))).toBe(false); // ワープ・ブラックスターは別に置く
  expect(fillWeights({ ...p, otherTiles: 0 }).length).toBe(1);
});
