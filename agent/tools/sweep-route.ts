// @temporary
// 目的: 罠(4)・12を避けて未回収の77/75/79を全回収する経由点列を探索（DFS＋時間上限）。
// 引数: [snapshot.json] [x0 x1 y0 y1]
// 出力例: {"targets":147,"reached":147,"steps":12,"via":[[x,y,tile],...]}
import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = a.length && !/^-?\d+$/.test(a[0]!) ? a[0]! : "var/current/snapshot.json";
const n = a.filter((s) => /^-?\d+$/.test(s)).map(Number);
const d = JSON.parse(readFileSync(file, "utf8"));
const T = new Map<string, { value: number; visitedCount: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const [x0, x1, y0, y1] = (n.length === 4 ? n : [-99, 99, -99, 99]) as number[];
const WALK = new Set([0, 1, 2, 3, 5, 6, 7, 8, 9, 60, 61, 62, 63, 71, 75, 77, 79]);
const VALU = new Set([75, 77, 79]);
const ok = (x: number, y: number) => { const k = `${x},${y}`; if (k === d.position.join(",")) return true; const t = T.get(k); return !!t && WALK.has(t.value); };
const inR = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const val = (x: number, y: number) => { const t = T.get(`${x},${y}`); return t && t.visitedCount === 0 && VALU.has(t.value) && inR(x, y) ? 1 : 0; };
const targets: string[] = [];
for (const [k, t] of T) { const [x, y] = k.split(",").map(Number) as [number, number]; if (val(x, y) && k !== d.position.join(",")) targets.push(k); }
const start: [number, number] = d.position;
const total = targets.length;

const used = new Set([start.join(",")]);

const path: [number, number][] = [start];
let best = { s: 0, p: path.slice() };
const t0 = Date.now();
const reach = (x: number, y: number, left: number): number => {
  const seen = new Set([`${x},${y}`]); const q = [[x, y]];
  let c = 0;
  while (q.length) { const [a, b] = q.pop()!; if (val(a, b)) c++; if (seen.size >= left) return c;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) { const k = `${a + dx},${b + dy}`; if (!seen.has(k) && ok(a + dx, b + dy)) { seen.add(k); q.push([a + dx, b + dy]); } } }
  return c;
};
// 孤立しないこと: 残り目標のうち始点と連結な分と全候補を数える（1つなら強制）
let cand: [number, number, number, boolean][] = [];
const dfs = (x: number, y: number, s: number) => {
  if (s > best.s) best = { s, p: path.slice() };
  if (s === total) return;
  if (Date.now() - t0 > 3800) return;
  const next: [number, number, number, boolean][] = [];
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
    if (!ok(nx, ny)) continue;
    // 始点には最後の1歩だけ戻れる（始点が罠でも踏める）
    if (used.has(k)) { if (k === start.join(",") && path.length >= 3) next.push([nx, ny, val(nx, ny), true]); continue; }
    next.push([nx, ny, val(nx, ny), false]);
  }
  const left = total - s;
  const live = next.filter(([nx, ny, , s0]) => !s0);
  const deg = (nx: number, ny: number) => [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dy]) => ok(nx + dx, ny + dy) && !used.has(`${nx + dx},${ny + dy}`)).length;
  if (live.filter(([nx, ny]) => deg(nx, ny) === 0 && !val(nx, ny)).length >= 2) return;
  next.sort((p, q) => reach(q[0], q[1], left) - reach(p[0], p[1], left));
  for (const [nx, ny, v, isStart] of next) {
    const k = `${nx},${ny}`;
    used.add(k); path.push([nx, ny]); dfs(nx, ny, s + v);
    if (isStart) { used.delete(k); } // 始点は2回踏めるが visited 判定を保つため戻す
    path.pop();
    if (!isStart) used.delete(k);
  }
  if (Date.now() - t0 > 1800) throw "timeout";
};
try { dfs(start[0], start[1], 0); } catch {}
const reached = best.p.filter(([x, y]) => val(x, y)).map(([x, y]) => `${x},${y}`);
// 経由点: 回収目標に到達した地点だけ（その手前の通過点は省略）
const via = reached.map((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return [x, y, T.get(k)!.value]; });
const missed = targets.filter((k) => !reached.includes(k));
console.log(JSON.stringify({ targets: total, reached: reached.length, steps: best.p.length - 1, via, missed }));
