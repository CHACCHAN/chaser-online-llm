// @temporary
// 目的: 区画内の罠(1/5)以外の全マスを再訪なしで1本の道で覆う（完全一筆書き）経路を厳密探索。--block で罠/マスを封鎖して代替路を探す。
// 引数: <snapshot.json> x0 x1 y0 y1 [--block x,y]...  始点は snapshot の position
// 出力例: {"cells":41,"path":["-3,-4",...],"coverAll":true} / 見つからなければ {"coverAll":false,"best":n}
import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = a[0]!;
const [x0, x1, y0, y1] = a.slice(1, 5).map(Number) as [number, number, number, number];
const blocks = new Set<string>();
for (let i = 5; i < a.length; i++) if (a[i] === "--block" && a[i + 1]) blocks.add(a[(i++) + 1]!);
const d = JSON.parse(readFileSync(file, "utf8"));
const T = new Map<string, { value: number; visitedCount: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const P = new Set<string>();
const inR = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
for (const [k, t] of T) {
  const [x, y] = k.split(",").map(Number) as [number, number];
  if (inR(x, y) && t.value !== 12 && t.value !== 1 && t.value !== 5 && !blocks.has(k)) P.add(k);
}
const nb = (x: number, y: number) => ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).map(([dx, dy]) => [x + dx, y + dy] as [number, number]).filter(([a2, b2]) => P.has(`${a2},${b2}`));
const N = P.size;
const start = (d.position as [number, number]).join(",");
if (!P.has(start)) { console.log(JSON.stringify({ cells: N, coverAll: false, err: "start not passable" })); process.exit(0); }
const seen = new Set<string>(); const path: [number, number][] = [];
let best = 0; const t0 = Date.now(); let cover = false;
const dfs = (x: number, y: number) => {
  if (seen.size > best) best = seen.size;
  if (seen.size === N) { cover = true; return; }
  if (Date.now() - t0 > Number(process.env.FC_MS ?? 1500)) return;
  const cand = nb(x, y).filter(([a2, b2]) => !seen.has(`${a2},${b2}`));
  // 残りが現在地から連結か（必要条件）
  const reach = new Set(cand.map((c) => c.join(","))); const q = cand.slice();
  while (q.length) { const [a2, b2] = q.pop()!; for (const c of nb(a2, b2)) { const k = c.join(","); if (!reach.has(k) && !seen.has(k)) { reach.add(k); q.push(c); } } }
  if (reach.size !== N - seen.size) return;
  cand.sort((p, q2) => nb(q2[0], q2[1]).filter(([u, v]) => !seen.has(`${u},${v}`)).length - nb(p[0], p[1]).filter(([u, v]) => !seen.has(`${u},${v}`)).length);
  for (const c of cand) { const k = c.join(","); seen.add(k); path.push(c); dfs(c[0], c[1]); if (cover) return; path.pop(); seen.delete(k); }
};
seen.add(start); path.push(start.split(",").map(Number) as [number, number]);
dfs(Number(start.split(",")[0]), Number(start.split(",")[1]));
console.log(JSON.stringify({ cells: N, coverAll: cover, covered: best, path: cover ? path.map((p) => p.join(",")) : undefined }));
