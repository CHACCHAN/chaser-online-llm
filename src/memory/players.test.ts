import { expect, test } from "bun:test";
import { WorldMap } from "./world-map";

test("自前マップ: 周囲に見えた他プレイヤーを敵として記録し、タイルには残さない", () => {
  const wm = new WorldMap();
  // 中央=自機(1000), 右上に敵(2000)
  wm.applyObservation("CMD1", "gr", [2, 2, 2000, 2, 1000, 2, 2, 2, 2], 1);
  const ui = wm.buildUiMapState("gr");
  const self = ui.players.find((p) => p.role === "self");
  const enemy = ui.players.find((p) => p.role === "enemy");
  expect(self).toBeDefined();
  expect(enemy?.tileId).toBe(2000);
  expect(enemy?.lastSeenTurn).toBe(1);
  expect([enemy!.x - self!.x, enemy!.y - self!.y]).toEqual([1, -1]);
  expect(wm.getTile(1, -1)).toBeUndefined();
  expect(ui.updatedTurn).toBe(1);
});

test("黄色の線は作戦目標までの実際の経路（罠を避ける）", async () => {
  const { WorldMap } = await import("./world-map");
  const wm = new WorldMap();
  // 自分の右 (1,0) に奈落、上下は土。(2,0) へは回り込む必要がある
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 12, 2, 2, 2], 1);
  const route = wm.routeTo(1, 1);
  expect(route?.[0]).toEqual([0, 0]);
  expect(route?.[route.length - 1]).toEqual([1, 1]);
  expect(route?.some(([x, y]) => x === 1 && y === 0)).toBe(false);
  const ui = wm.buildUiMapState(null, [1, 1]);
  expect(ui.plannedPath.length).toBe(route!.length);
});

test("メインに渡すマップは観測済み範囲すべて（目盛り・敵・作戦目標つき）", async () => {
  const { WorldMap } = await import("./world-map");
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 12, 2, 2, 2], 1);
  const m = wm.renderAgentMap({ enemies: [{ x: 5, y: 0, stale: true }], planTarget: [-4, 2] });
  const rows = m.split("\n");
  expect(rows[0]).toContain("自作マップ");
  expect(m).toContain("@");
  expect(m).toContain("e");
  expect(m).toContain("P");
  // x=-4..5 の10列（＋y目盛り）
  expect(rows[2]!.trim()).toBe("4321012345");
});
