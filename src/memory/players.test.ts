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
