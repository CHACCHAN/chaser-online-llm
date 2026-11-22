// @temporary
// 目的: 盤面から「未回収アイテム（visitedCount=0 の item + 3 罠）まで、12 奈落を避けた最短路」を計算し、
//       経由点の一覧を JSON 1行で出す。
// 引数: [snapshot.json のパス] [x0 x1 y0 y1] すべて任意（既定 var/current/snapshot.json、範囲は全体）
// 出力例: {"from":[1,4],"unknownPassable":false,"targets":[{"target":[0,2],"dist":2,"path":[[0,3],[0,2]]}]}
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.length && !/^-?\d/.test(args[0]) ? args[0] : "var/current/snapshot.json";
const nums = args.filter((a) => /^-?\d+$/.test(a)).map(Number);
const d = JSON.parse(readFileSync(file, "utf8"));
const pos: [number, number] = d.position;
const tiles = new Map<string, { value: number; visitedCount: number }>();
for (const t of d.tiles) tiles.set(`${t.x},${t.y}`, t);
const [x0, x1, y0, y1] = (nums.length === 4 ? nums : [-30, 30, -30, 30]) as [number, number, number, number];
const lo = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const find = (x: number, y: number) => tiles.get(`${x},${y}`);
// 通行可能: visitedCount>0 の既知マス、またはアイテム(5-8,2,3,71,79 等の 12 以外)
const passable = (x: number, y: number) => {
  const t = find(x, y);
  if (!t) return false;
  if (t.visitedCount > 0) return t.value !== 12;
  return t.value !== 0 && t.value !== 12; // 未訪の 0 は壁か不確定なので通さない
};
const W = (x: number, y: number) => (passable(x, y) ? 1 : 1000);
const bx0 = Math.max(x0 - 1, lo(Math.min(pos[0], ...d.tiles.map((t: any) => t.x)), x0, x1));
const bxs = [Math.min(pos[0], x0) - 1, Math.max(pos[0], x1) + 1] as [number, number];
const bys = [Math.min(pos[1], y0) - 1, Math.max(pos[1], y1) + 1] as [number, number];
const start = `${pos[0]},${pos[1]}`;
const dist = new Map<string, number>([[start, 0]]);
const prev = new Map<string, string>();
const q: [number, string][] = [[0, start]];
while (q.length) {
  q.sort((a, b) => a[0] - b[0]);
  const [c, k] = q.shift()!;
  if ((dist.get(k) ?? 1e9) < c) continue;
  const [x, y] = k.split(",").map((v) => Number(v ?? 0)) as [number, number];
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const nx = x + dx, ny = y + dy;
    if (nx < bxs[0] || nx > bxs[1] || ny < bys[0] || ny > bys[1]) continue;
    const w = (dist.get(k) ?? 0) + W(nx, ny);
    const nk = `${nx},${ny}`;
    if (w < (dist.get(nk) ?? 1e9)) { dist.set(nk, w); prev.set(nk, k); q.push([w, nk]); }
  }
}
const targets: any[] = [];
for (const t of d.tiles) {
  if (t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) continue;
  if (t.x === pos[0] && t.y === pos[1]) continue;
  const wanted = t.value === 3 || ([2, 5, 6, 7, 8, 71, 79].includes(t.value) && t.visitedCount === 0);
  if (!wanted) continue;
  const key = `${t.x},${t.y}`;
  const dd = dist.get(key);
  const path: [number, number][] = [];
  if (dd !== undefined) {
    let k: string | undefined = key;
    while (k && k !== start) { const [a, b] = k.split(",").map((v) => Number(v ?? 0)) as [number, number]; path.unshift([a, b]); k = prev.get(k); }
  }
  targets.push({ target: [t.x, t.y], value: t.value, visited: t.visitedCount, dist: dd ?? null, dangerHops: dd === undefined ? null : Math.round(dd - path.length), path });
}
targets.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
console.log(JSON.stringify({ from: pos, turn: d.turn, targets }));
