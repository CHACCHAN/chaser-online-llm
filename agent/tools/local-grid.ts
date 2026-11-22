// 目的: 現区画の観測タイルを座標付き格子で表示（null は未観測）。
// 使用: bun agent/tools/local-grid.ts [半径=12] または x0 x1 y0 y1
// 出力例: {"pos":[0,0],"globalPosition":null,"x0":0,"x1":0,"y0":0,"y1":0,"rows":[{"y":0,"cells":[[0,0]]}]}
import { readFileSync } from "node:fs";
import type { WorldMapSnapshot } from "../../src/memory/world-map";

const args = process.argv.slice(2).map(Number);
if (![0, 1, 4].includes(args.length) || !args.every(Number.isSafeInteger) || (args.length === 1 && args[0]! < 0)) {
  throw new Error("Specify a nonnegative integer radius, or x0 x1 y0 y1");
}
const s = JSON.parse(readFileSync("var/current/snapshot.json", "utf8")) as WorldMapSnapshot;
const [x, y] = s.position;
const r = args[0] ?? 12;
const [x0, x1, y0, y1] = args.length === 4
  ? args as [number, number, number, number]
  : [x - r, x + r, y - r, y + r] as const;
if (![x0, x1, y0, y1].every(Number.isSafeInteger) || x0 > x1 || y0 > y1 || (x1 - x0 + 1) * (y1 - y0 + 1) > 10_000) {
  throw new Error("Specify an ordered rectangle of at most 10,000 cells");
}
const tiles = new Map(s.tiles.map(t => [`${t.x},${t.y}`, t.value]));
const rows = [];
for (let y = y0; y <= y1; y++) {
  const cells: [number, number | null][] = [];
  for (let x = x0; x <= x1; x++) cells.push([x, tiles.get(`${x},${y}`) ?? null]);
  rows.push({ y, cells });
}
console.log(JSON.stringify({ pos: s.position, globalPosition: s.globalPosition, x0, x1, y0, y1, rows }));
