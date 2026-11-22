// @temporary
// 目的: 指定区画の通行可能マスの全マスを一筆書き（再訪なし）する経路を探索。目標価値マス(75/77/79)の回収数を最大化。
// 引数: <snapshot.json> x0 x1 y0 y1 [--block x,y]
// 出力例: {"targets":14,"reached":14,"steps":20,"via":[[x,y,tile],...],"path":[[x,y],...]}
import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = a[0]!;
const n = a.slice(1, 5).map(Number) as [number, number, number, number];
const blocks = new Set<string>();
for (let i = 5; i < a.length; i++) if (a[i] === "--block" && a[i + 1]) blocks.add(a[(i++) + 1]!);
const d = JSON.parse(readFileSync(file, "utf8"));
const T = new Map<string, { value: number; visitedCount: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const [x0, x1, y0, y1] = n;
const WALK = new Set([0, 1, 2, 3, 5, 6, 7, 8, 9, 60, 61, 62, 63, 71, 75, 77, 79]);
const VALU = new Set([75, 77, 79]);
const flags = new Set(a.filter((v) => v.startsWith("--")));
const start = d.position as [number, number];
const ok = (x: number, y: number) => {
  const k = `${x},${y}`;
  if (k === start.join(",")) return true;
  if (blocks.has(k)) return false;
  const t = T.get(k);
  if (!t) return false;
  // --strict: 通行可能タイル一覧にない値(1/5=罠, 4=ブロック, 12=壁)は使わない
  if (flags.has("--strict") && !WALK.has(t.value)) return false;
  // 区画の縁の 12 は壁ではなく通路の可能性があるので基準では通行不可、--block 回避用に区画外も見る
  return WALK.has(t.value);
};
const inR = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const val = (x: number, y: number) => {
  const t = T.get(`${x},${y}`);
  return t && t.visitedCount === 0 && VALU.has(t.value) && inR(x, y) && `${x},${y}` !== start.join(",") ? 1 : 0;
};
const targets: string[] = [];
for (const [k, t] of T) {
  const [x, y] = k.split(",").map(Number) as [number, number];
  if (val(x, y)) targets.push(k);
}
const total = targets.length;
const used = new Set<string>([start.join(",")]);
const path: [number, number][] = [start];
let best = { s: 0, p: path.slice() };
const t0 = Date.now();
const N = (x: number, y: number) => ([[0, -1], [1, 0], [0, 1], [-1, 0]] as const).map(([dx, dy]) => [x + dx, y + dy] as [number, number]).filter(([a, b]) => ok(a, b));
const reach = (x: number, y: number) => {
  const seen = new Set([`${x},${y}`]); const q = [[x, y]]; let c = 0;
  while (q.length) { const [a, b] = q.pop()!; if (val(a, b)) c++;
    for (const [nx, ny] of N(a, b)) { const k = `${nx},${ny}`; if (!seen.has(k) && !used.has(k)) { seen.add(k); q.push([nx, ny]); } } }
  return c;
};
const dfs = (x: number, y: number, s: number) => {
  if (s > best.s) best = { s, p: path.slice() };
  if (s === total || Date.now() - t0 > 5000) return;
  const next: [number, number, number, boolean][] = [];
  for (const [nx, ny] of N(x, y)) {
    const k = `${nx},${ny}`;
    if (used.has(k)) { if (k === start.join(",") && path.length >= 3) next.push([nx, ny, 0, true]); continue; }
    next.push([nx, ny, val(nx, ny), false]);
  }
  // 残り未訪問グラフの連結性・次数（部分一筆書きの必要条件）
  const deg = (nx: number, ny: number) => N(nx, ny).filter(([a, b]) => !used.has(`${a},${b}`)).length;
  for (const c of next) {
    const u2 = new Set(used); u2.add(`${c[0]},${c[1]}`);
    const nn = (nx: number, ny: number) => N(nx, ny).filter(([a, b]) => !u2.has(`${a},${b}`)).length;
    const remaining = [...T.keys()].length; void remaining;
  }
  const live = next.filter((c) => !c[3]);
  // 次数1の強制チェーンが多発する(>=2)なら枝刈り
  if (live.filter(([nx, ny]) => deg(nx, ny) === 0 && !val(nx, ny)).length >= 2) return;
  // 連結性: 未訪問残りのうち現在地と繋がらないものを検出
  const seen = new Set<string>(); const q: [number, number][] = [[x, y]]; seen.add(`${x},${y}`);
  while (q.length) { const [a, b] = q.pop()!; for (const [nx, ny] of N(a, b)) { const k = `${nx},${ny}`; if (!seen.has(k)) { seen.add(k); if (!used.has(k)) q.push([nx, ny]); } } }
  for (const [nx, ny, , isS] of next) { if (!isS && !seen.has(`${nx},${ny}`)) return; }
  next.sort((p, q) => reach(q[0], q[1]) - reach(p[0], p[1]));
  for (const [nx, ny, v, isS] of next) {
    const k = `${nx},${ny}`;
    used.add(k); path.push([nx, ny]); dfs(nx, ny, s + v); path.pop(); used.delete(k);
    if (Date.now() - t0 > 5000) return;
  }
};
dfs(start[0], start[1], val(start[0], start[1]));
const reached = best.p.filter(([x, y]) => val(x, y)).map(([x, y]) => `${x},${y}`);
const via = reached.map((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return [x, y, T.get(k)!.value]; });
const missed = targets.filter((k) => !reached.includes(k));
console.log(JSON.stringify({ targets: total, reached: reached.length, steps: best.p.length - 1, via, missed, path: best.p }));
