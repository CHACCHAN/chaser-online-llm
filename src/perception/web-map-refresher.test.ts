import { expect, mock, test } from "bun:test";
import type { WebMapScrapeResult } from "./web-map-scraper";

// サーバに行かない偽の取得。呼ばれるたびに次の結果を返す（遅延つき）
const queue: { delayMs: number; result: Partial<WebMapScrapeResult> }[] = [];
let calls = 0;
mock.module("./web-map-scraper", () => ({
  scrapeRoomWebMap: async () => {
    calls += 1;
    const next = queue.shift() ?? { delayMs: 0, result: { found: false } };
    await Bun.sleep(next.delayMs);
    return { found: false, grid: null, playerPos: null, stageName: null, sourceUrl: null, liveScore: null, ...next.result };
  },
}));

const { WebMapRefresher } = await import("./web-map-refresher");
const { WorldMap } = await import("../memory/world-map");

const grid = Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) => (x === 0 || y === 0 || x === 6 || y === 6 ? 10 : 2)));

test("取れない間は自作マップ、N ターンごとに再挑戦し、取れたら全体マップ表示に切り替わる（試合は待たない）", async () => {
  Bun.env.CHASER_WEB_MAP_RETRY_TURNS = "5";
  Bun.env.CHASER_WEB_MAP_TIMEOUT_SEC = "1";
  Bun.env.CHASER_WEB_MAP_REFRESH = "every_turn";
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  let updates = 0;
  const r = new WebMapRefresher(1, undefined, wm, () => (updates += 1));

  queue.push({ delayMs: 0, result: { found: false } }); // 開始時: 失敗
  await r.start();
  expect(r.available).toBe(false);
  expect(wm.buildUiMapState(null).source).toBe("slam");

  for (let t = 1; t <= 4; t++) r.onTurnStart(t); // 再挑戦しない
  expect(calls).toBe(1);

  // T5: 再挑戦。取得は遅いが onTurnStart はすぐ戻る。取得中に自機が右へ1歩動く
  queue.push({ delayMs: 50, result: { found: true, grid, playerPos: [3, 3], stageName: "S" } });
  const t0 = Date.now();
  r.onTurnStart(5);
  expect(Date.now() - t0).toBeLessThan(20);
  wm.applyObservation("CMD2", "wr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 5);
  await Bun.sleep(80);

  expect(r.available).toBe(true);
  expect(updates).toBe(1);
  const ui = wm.buildUiMapState(null);
  expect(ui.source).toBe("web_map");
  // 取得開始時の位置 (3,3) を基準に合わせるので、今の自機は 1 歩右の (4,3)
  expect(ui.playerPos).toEqual([4, 3]);

  // 取れてからは毎ターン（実行中なら見送り）
  queue.push({ delayMs: 50, result: { found: true, grid, playerPos: [4, 3] } });
  r.onTurnStart(6);
  r.onTurnStart(7); // 6 の取得中なので見送り
  await Bun.sleep(80);
  expect(calls).toBe(3);
  delete Bun.env.CHASER_WEB_MAP_RETRY_TURNS;
  delete Bun.env.CHASER_WEB_MAP_TIMEOUT_SEC;
  delete Bun.env.CHASER_WEB_MAP_REFRESH;
});

test("Web マップを取り直すと、自分の観測より新しいマスは更新される（他プレイヤーが拾ったアイテム等）", async () => {
  const { WorldMap } = await import("../memory/world-map");
  const wm = new WorldMap();
  const g = Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => 2));
  g[3]![3] = 1001;
  g[0]![6] = 77; // 遠くのアイテム
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1001, 2, 2, 2, 2], 1);
  wm.setGlobalGrid(g, [3, 3], "t", 1, 1001, [0, 0]);
  expect(wm.getTile(3, -3)?.value).toBe(77);
  // T5 に取り直したら、アイテムは誰かに拾われて土になっていた
  const g2 = g.map((r) => [...r]);
  g2[0]![6] = 2;
  wm.setGlobalGrid(g2, [3, 3], "t", 5, 1001, [0, 0]);
  expect(wm.getTile(3, -3)?.value).toBe(2);
  // 自分の観測（T1）は同じターンの Web マップより優先、後の Web マップでは更新される
  expect(wm.getTile(1, 0)?.value).toBe(2);
});

test("取得中に動いても、観測と食い違わない方の位置で Web マップを合わせる", async () => {
  const { WorldMap } = await import("../memory/world-map");
  // 左右非対称な盤面
  const g = [
    [10, 10, 10, 10, 10, 10, 10],
    [10, 2, 3, 77, 2, 0, 10],
    [10, 2, 1, 2, 3, 2, 10],
    [10, 3, 2, 2, 77, 2, 10],
    [10, 2, 0, 3, 2, 1, 10],
    [10, 10, 10, 10, 10, 10, 10],
  ];
  const wm = new WorldMap();
  // 自機は Web 座標 (2,2) から出発し、取得中に右へ1マス動いた。Web マップ上の自機は (3,2)（動いた後）
  wm.applyObservation("CMD1", "gr", [2, 3, 77, 2, 1001, 2, 3, 2, 2], 1);
  const capture = wm.getPosition();
  wm.applyObservation("CMD1", "grr", [3, 77, 2, 1, 1001, 3, 2, 2, 77], 1);
  const withPlayer = g.map((r) => [...r]);
  withPlayer[2]![3] = 1001;
  wm.setGlobalGrid(withPlayer, [3, 2], "t", 1, 1001, capture);
  // 正しい合わせなら、ローカル (0,0)=出発点 は Web (2,2)
  // 観測していないマスで確かめる。取得開始時の位置で合わせると1列ずれて壁(10)になる
  expect(wm.getTile(3, -1)?.value).toBe(0); // Web (5,1)
  expect(wm.getTile(3, 1)?.value).toBe(2); // Web (5,3)
});
