import { describe, expect, test } from "bun:test";
import { WorldMap } from "../memory/world-map";
import * as evaluator from "../solver/evaluator";
import { defaultParams } from "../solver/evaluator";
import { planMove } from "../solver/planner";
import { makePlannerPolicy } from "../solver/policy";
import { runHunterTurn } from "./bots";
import { DEFAULT_RULES, SimGame } from "./engine";
import { runEpisode } from "./episode";
import type { Scenario } from "./mapgen";
import { addToLeague, assignOpponents, loadLeague, type OpponentPlan } from "./opponents";

const grid = (w: number, h: number, fill = 2) => Array.from({ length: h }, () => Array.from({ length: w }, () => fill));
const plan = (mix: OpponentPlan["mix"], league: OpponentPlan["league"] = []): OpponentPlan => ({ mix, current: defaultParams(), league });

describe("シミュレータの相手", () => {
  test("相手は地図の seed で決まる（比べる方策が変わっても同じ相手）。重みが0の種類は出ない", () => {
    const p = plan({ greedy: 1, hunter: 0, self: 2 }, [{ params: { ...defaultParams(), distWeight: 2 }, label: "1つ前" }]);
    const a = assignOpponents(42, 3, p);
    expect(assignOpponents(42, 3, p)).toEqual(a);
    const many = Array.from({ length: 50 }, (_, s) => assignOpponents(s, 3, p)).flat();
    expect(many.some((o) => o.kind === "hunter")).toBe(false);
    expect(many.some((o) => o.kind === "self" && o.label === "1つ前")).toBe(true);
    expect(many.some((o) => o.kind === "self" && o.label === "今")).toBe(true);
    expect(assignOpponents(1, 2, plan({ greedy: 0, hunter: 0, self: 0 })).every((o) => o.kind === "greedy")).toBe(true);
  });

  test("狙う相手は近くのプレイヤーへ寄り、隣に来たらアイテムを置いて当てる（当てた側 +、当てられた側 −）", () => {
    const game = new SimGame(grid(7, 3), [{ id: 1000, x: 0, y: 1 }, { id: 2000, x: 3, y: 1 }], 10, { ...DEFAULT_RULES, putHitItem: 5000, putHitSoil: 5000 });
    const [me, hunter] = game.players as [NonNullable<(typeof game.players)[0]>, NonNullable<(typeof game.players)[0]>];
    runHunterTurn(game, hunter);
    runHunterTurn(game, hunter);
    expect(me.score.putDamage).toBe(-5000);
    expect(hunter.score.put).toBe(5000);
  });

  test("方策は CMD2 で隣の敵にアイテムを置いて当てる（attackGain が 0 なら当てない）", () => {
    const g = grid(5, 5);
    const game = new SimGame(g, [{ id: 1000, x: 2, y: 2 }, { id: 2000, x: 2, y: 1 }], 20);
    const wm = new WorldMap();
    wm.setGlobalGrid(game.webGrid(), [2, 2], "t", 1, 1000, wm.getPosition());
    wm.applyObservation("CMD1", "gr", game.act(game.players[0]!, "CMD1", "gr"), 1);
    const d = planMove(wm, { phase: "CMD2", turn: 1, remainingTurns: 20, params: defaultParams(), evaluator });
    expect(d.command).toBe("pu3su");
    const no = planMove(wm, { phase: "CMD2", turn: 1, remainingTurns: 20, params: { ...defaultParams(), attackGain: 0 }, evaluator });
    expect(no.command.startsWith("p")).toBe(false);
  });

  test("相手の「自分」も同じ方策で最後まで打ち、結果に相手の種類・当てた／当てられた・勝ちが出る", () => {
    const scn: Scenario = { name: "t", grid: grid(11, 11), starts: [{ id: 1000, x: 1, y: 1 }, { id: 2000, x: 9, y: 9 }, { id: 3000, x: 1, y: 9 }], self: 0, totalTurns: 30, webMap: true, putHit: 5000 };
    const r = runEpisode(scn, makePlannerPolicy(defaultParams()), { opponents: [{ kind: "self", params: defaultParams(), label: "今" }, { kind: "hunter" }], trace: true });
    expect(r.policyErrors).toBe(0);
    expect(r.opponentKinds).toEqual(["自分(今)", "狙う"]);
    expect(r.opponents.length).toBe(2);
    expect(typeof r.won).toBe("boolean");
    expect(r.trace!.players.filter((p) => !p.self).map((p) => p.kind)).toEqual(["自分(今)", "狙う"]);
    expect(r.put).toBeGreaterThanOrEqual(0);
    expect(r.putDamage).toBeLessThanOrEqual(0);
  });

  test("リーグ（自己対戦の前の自分）は新しい順に上限まで残る", () => {
    const file = `${process.env.CHASER_TEST_VAR_DIR ?? "/tmp"}/league-test-${Date.now()}.json`;
    for (let i = 0; i < 4; i++) addToLeague({ ...defaultParams(), distWeight: 1 + i * 0.1 }, `v${i}`, 3, file);
    const l = loadLeague(file);
    expect(l.members.map((m) => m.note)).toEqual(["v3", "v2", "v1"]);
  });
});
