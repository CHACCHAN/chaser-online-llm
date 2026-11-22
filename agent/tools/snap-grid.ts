// @temporary
// 目的: 指定の保存盤面 (sub-snapshots など) を座標付き格子で表示。
// 使用: bun agent/tools/snap-grid.ts <snapshot.json> x0 x1 y0 y1
// 出力: JSON 1行 {"pos":[...],"x0":..,"rows":[{"y":..,"cells":[[x,"val/vc"],...]}]}
import { readFileSync } from "node:fs";
import type { WorldMapSnapshot } from "../../src/memory/world-map";

const [file, ...rest] = process.argv.slice(2);
if (!file || rest.length !== 4) throw new Error("usage: snap-grid.ts <snapshot.json> x0 x1 y0 y1");
const [x0, x1, y0, y1] = rest.map(Number) as [number, number, number, number];
const s = JSON.parse(readFileSync(file!, "utf8")) as WorldMapSnapshot & { position: [number, number] };
const tiles = new Map(s.tiles.map(t => [`${t.x},${t.y}`, t]));
const rows = [];
for (let y = y0; y <= y1; y++) {
  const cells: [number, string | null][] = [];
  for (let x = x0; x <= x1; x++) {
    const t = tiles.get(`${x},${y}`);
    cells.push([x, t ? `${t.value}/${(t as { visitedCount?: number }).visitedCount ?? 0}` : null]);
  }
  rows.push({ y, cells });
}
console.log(JSON.stringify({ pos: s.position, x0, x1, y0, y1, rows }));
