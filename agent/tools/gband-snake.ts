// @temporary
// 目的: 既知の通行可能マスを蛇行（スネーク）一筆書きで辿る経由点列を JSON 1行で出す（罠4・奈落12・壁0は除外）。
// 引数: [snapshot.json のパス]
// 出力: {"route":[[x,y,tile,visited],...],"count":n} 1 本の連続経路（1 列ずつ上下交互）。
import { readFileSync } from "node:fs";
const file = process.argv[2] ?? "var/current/snapshot.json";
const d = JSON.parse(readFileSync(file, "utf8"));
const G = new Map<string, any>();
for (const t of d.tiles) G.set(`${t.x},${t.y}`, t);
const pass = (x: number, y: number) => {
  const t = G.get(`${x},${y}`);
  return !!t && t.value !== 4 && t.value !== 12 && t.value !== 0 && t.visitedCount >= 0;
};
// 既知の通行可能マスの範囲を自動で取る（罠・奈落を除いた最大の連結成分）
const cells = [...G.values()].filter((t: any) => t.value !== 4 && t.value !== 12 && t.value !== 0);
const key = (x: number, y: number) => `${x},${y}`;
const seen = new Set<string>();
let best: any[] = [];
for (const s of cells) {
  if (seen.has(key(s.x, s.y))) continue;
  const comp: any[] = [];
  const st = [[s.x, s.y]];
  while (st.length) {
    const [x, y] = st.pop()!;
    if (seen.has(key(x, y)) || !pass(x, y)) continue;
    seen.add(key(x, y));
    comp.push([x, y]);
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) st.push([x + dx, y + dy]);
  }
  if (comp.length > best.length) best = comp;
}
const C = new Set(best.map(([x, y]) => key(x, y)));
// 蛇行: 連結成分を列ごとに上下交互に。列内の途中で欠けても順に進める。
const xs = [...new Set(best.map((c) => c[0]))].sort((a, b) => a - b);
const order: any[] = [];
xs.forEach((x, i) => {
  const ys = best.filter((c) => c[0] === x).map((c) => c[1]).sort((a, b) => a - b);
  if (i % 2) ys.reverse();
  for (const y of ys) {
    const t = G.get(key(x, y));
    order.push([x, y, t.value, t.visitedCount]);
  }
});
console.log(JSON.stringify({ route: order, count: order.length }));
