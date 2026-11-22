// @temporary
// 目的: 盤面の相対座標で書いた「半マス格子（ロボット0.5刻み）の巡回経路」を絶対座標のセル経由点列に変換し、罠(4)/12 を通らないか検査。
// 引数: <snap.json> <cells.json>   cells.json = {"start":[sx,sy,"u"|"d"|"l"|"r"],"path":[[x,y,x2,y2],...]} 半マス座標
// 出力例: {"via":[[x,y],...],"hits":[],"cells":N}
import { readFileSync } from "node:fs";
const [file, cf] = process.argv.slice(2) as [string, string];
const d = JSON.parse(readFileSync(file, "utf8"));
const T = new Map<string, { value: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const c = JSON.parse(readFileSync(cf, "utf8"));
const [px, py] = d.position as [number, number];
const P = (p: [number, number]): [number, number] => [p[0] % 2 === 0 ? px + p[0] / 2 : px + (p[0] - 1) / 2, py + p[1] / 2];
const start = P(c.start);
const via: [number, number][] = [start];
const hits: string[] = [];
let cur = start;
const visit = (q: [number, number]) => { if (q[0] !== cur[0] || q[1] !== cur[1]) { via.push(q); cur = q; } };
for (const seg of c.path as [number, number, number, number][]) {
  const a = P([seg[0], seg[1]]), b = P([seg[2], seg[3]]);
  visit(a);
  if (seg[0] === seg[2]) { const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]); for (let y = y0; y <= y1; y++) visit([a[0], y]); }
  else { const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]); for (let x = x0; x <= x1; x++) visit([x, a[1]]); }
}
for (const [x, y] of via) { const t = T.get(`${x},${y}`); if (!t) hits.push(`${x},${y}:?`); else if (t.value === 4 || t.value === 12) hits.push(`${x},${y}:${t.value}`); }
console.log(JSON.stringify({ start, via, hits, cells: via.length }));
