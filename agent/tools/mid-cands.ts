// @temporary
// 目的: 罠4の隣接マスそれぞれに「pos から来る長さ」と「二度と使わない道で抜ける最短長」を出す。蛇行で罠の角を跨ぐ折返し（隣接経由）を選ぶための補助。
// 引数: <snap.json> x,y | all
// 出力: JSON 1行 {"pos":[x,y],"traps":[{"trap":[x,y,4],"neighbors":[[x,y,tile,inLen,outLen,sideFrom],...]}]}
import { readFileSync } from "node:fs";
const [file, k] = process.argv.slice(2) as string[];
const d = JSON.parse(readFileSync(file!, "utf8"));
const T = new Map<string, { value: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const [sx, sy] = d.position as [number, number];
const TRAPS = k === "all" ? [...T].filter(([, t]) => t.value === 4).map(([kk]) => kk.split(",").map(Number) as [number, number]) : [k!.split(",").map(Number) as [number, number]];
const WALK = (x: number, y: number) => { const t = T.get(`${x},${y}`); return !!t && ![4, 12].includes(t.value); };
const bfs = (a: [number, number]) => {
  const dist = new Map<string, number>([[a.join(","), 0]]); const q = [a];
  while (q.length) { const [x, y] = q.shift()!; for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]] as [number, number][]) { const kk = `${nx},${ny}`; if (!dist.has(kk) && WALK(nx, ny)) { dist.set(kk, dist.get(`${x},${y}`)! + 1); q.push([nx, ny]); } } }
  return dist;
};
const ds = bfs([sx, sy]);
const traps = TRAPS.map(([tx, ty]) => {
  const nb: any[] = [];
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as [number, number][]) {
    const x = tx + dx, y = ty + dy; if (!WALK(x, y)) continue;
    const dd = bfs([x, y]);
    const outs = ([[0, -1], [0, 1], [-1, 0], [1, 0]] as [number, number][]).filter(([ax, ay]) => WALK(x + ax, y + ay) && (x + ax !== sx || y + ay !== sy) && (x + ax !== tx || y + ay !== ty)).flatMap(([ax, ay]) => dd.has(`${x + ax},${y + ay}`) ? [dd.get(`${x + ax},${y + ay}`)! + 1] : []);
    nb.push([x, y, T.get(`${x},${y}`)!.value, ds.get(`${x},${y}`) ?? Infinity, outs.length ? Math.min(...outs) : Infinity, [dx, dy]]);
  }
  return { trap: [tx, ty, 4], neighbors: nb };
});
console.log(JSON.stringify({ pos: [sx, sy], traps }));
