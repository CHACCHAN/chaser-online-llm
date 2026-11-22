// @temporary
// 目的: 一筆書き（再訪なし・1マス移動）で未回収75/77/79の回収数を最大化。罠/壁/黒星/y範囲外は踏まない。
// 引数: <snapshot.json> x0 x1 y0 y1 [--avoid x,y]... [--avoidtype N]... [--time ms]
// 出力例: {"targets":10,"reached":6,"steps":10,"via":[[x,y,tile],...],"missed":[],"end":[x,y],"path":[[x,y],...]}
import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = a[0]!;
const x0 = Number(a[1]), x1 = Number(a[2]), y0 = Number(a[3]), y1 = Number(a[4]);
const avoid = new Set<string>();
const avoidType = new Set<number>();
let budget = 3000;
for (let i = 5; i < a.length; i++) {
  if (a[i] === "--avoid" && a[i + 1]) avoid.add(a[(i++) + 1]!);
  else if (a[i] === "--avoidtype" && a[i + 1]) avoidType.add(Number(a[(i++) + 1]));
  else if (a[i] === "--time" && a[i + 1]) budget = Number(a[(i++) + 1]);
}
const d = JSON.parse(readFileSync(file, "utf8"));
const T = new Map<string, { value: number; visitedCount: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const start: [number, number] = d.position;
const SK = `${start[0]},${start[1]}`;
const HALF = Math.floor(budget / 2);
const VALU = new Set([75, 77, 79]);
const STATIC = new Set([4, 12, 0]);
const inR = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const ok = (x: number, y: number) => {
  const k = `${x},${y}`;
  if (avoid.has(k)) return false;
  if (k === SK) return true;
  if (!inR(x, y)) return false;
  const t = T.get(k);
  return !!t && !STATIC.has(t.value) && !avoidType.has(t.value);
};
const isT = (k: string) => { const t = T.get(k); return !!t && t.visitedCount === 0 && VALU.has(t.value); };
const targets = [...T.keys()].filter((k) => {
  const [x, y] = k.split(",").map(Number) as [number, number];
  return k !== SK && inR(x, y) && isT(k) && ok(x, y);
});
const used = new Set<string>([SK]);
const path: [number, number][] = [start];
let best = { s: 0, p: path.slice() };
const N4: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
let t0 = Date.now();
const DBG = !!process.env.HDEBUG;
const degOf = (nx: number, ny: number) => N4.filter(([dx, dy]) => { const k = `${nx + dx},${ny + dy}`; return ok(nx + dx, ny + dy) && !used.has(k); }).length;
const dfs = (x: number, y: number, s: number) => {
  if (s > best.s) best = { s, p: path.slice() };
  if (s === targets.length || Date.now() - t0 > budget) return;
  const next: [number, number][] = [];
  for (const [dx, dy] of N4) { const nx = x + dx, ny = y + dy, k = `${nx},${ny}`; if (!used.has(k) && ok(nx, ny)) next.push([nx, ny]); }
  if (DBG) console.error(x,y,s,JSON.stringify(next.map(n=>[n,degOf(n[0],n[1])])));
  if (next.length === 0) return;
  const dead = next.filter(([nx, ny]) => degOf(nx, ny) === 0);
  // 行き止まりへ入ると他の候補を捨てる。行き止まりが2つ以上、または他候補があるのに唯一の前進先が行き止まりなら打ち切り
  if (dead.length >= 2 || (dead.length === 1 && next.length >= 2)) {
    for (const [nx, ny] of dead) {
      const k = `${nx},${ny}`;
      if (!isT(k)) continue;
      used.add(k); path.push([nx, ny]);
      if (s + 1 > best.s) best = { s: s + 1, p: path.slice() };
      path.pop(); used.delete(k);
    }
    return;
  }
  next.sort((p, q) => degOf(p[0], p[1]) - degOf(q[0], q[1]));
  for (const [nx, ny] of next) {
    const k = `${nx},${ny}`;
    used.add(k); path.push([nx, ny]); dfs(nx, ny, s + (isT(k) ? 1 : 0)); path.pop(); used.delete(k);
    if (Date.now() - t0 > budget) return;
  }
};
dfs(start[0], start[1], isT(SK) ? 1 : 0);
// 覆えなかったら、目標タイルだけ通る経路（目標セル間の最短距離・罠回避）で繋ぐ
const link = (from: [number, number], to: [number, number]) => {
  const prev = new Map<string, string | null>([[`${from[0]},${from[1]}`, null]]);
  const q: [number, number][] = [from];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === to[0] && y === to[1]) break;
    for (const [dx, dy] of N4) { const nx = x + dx, ny = y + dy, k = `${nx},${ny}`; if (prev.has(k) || !ok(nx, ny)) continue;
      const t = T.get(k); const walkable = (nx === to[0] && ny === to[1]) || !t || STATIC.has(t.value) || avoidType.has(t.value) ? ok(nx, ny) : isT(k) && !used.has(k) && used.has(k) === false && !STATIC.has(t.value) ? true : false;
      if (!walkable) continue; prev.set(k, `${x},${y}`); q.push([nx, ny]); } }
  if (!prev.has(`${to[0]},${to[1]}`)) return null;
  const out: [number, number][] = []; let k: string | null = `${to[0]},${to[1]}`;
  while (k && k !== `${from[0]},${from[1]}`) { const [x, y] = k.split(",").map(Number) as [number, number]; out.push([x, y]); k = prev.get(k) ?? null; }
  return out.reverse();
};
if (best.s < targets.length) {
  const rest = new Set(targets.filter((k) => !best.p.some(([x, y]) => `${x},${y}` === k)));
  const p2 = best.p.slice(); const u2 = new Set(p2.map(([x, y]) => `${x},${y}`));
  let s2 = best.s;
  while (rest.size) {
    let pick: { to: string; leg: [number, number][] } | null = null;
    for (const k of rest) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      const leg = link(p2.at(-1)!, [x, y]);
      if (leg && (!pick || leg.length < pick.leg.length)) pick = { to: k, leg };
    }
    if (!pick) break;
    for (const c of pick.leg) { const k = `${c[0]},${c[1]}`; p2.push(c); u2.add(k); if (isT(k)) s2++; }
    rest.delete(pick.to); rest.delete(`${p2.at(-1)![0]},${p2.at(-1)![1]}`);
  }
  if (s2 > best.s) best = { s: s2, p: p2 };
}
const via = best.p.filter(([x, y]) => isT(`${x},${y}`)).map(([x, y]) => [x, y, T.get(`${x},${y}`)!.value]);
const got = new Set(via.map((v) => `${v[0]},${v[1]}`));
console.log(JSON.stringify({ targets: targets.length, reached: via.length, steps: best.p.length - 1, via, missed: targets.filter((k) => !got.has(k)), end: best.p.at(-1), path: best.p }));
