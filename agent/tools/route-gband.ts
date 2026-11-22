// @temporary
// 目的: 77/79 帯の一筆書き回収ルート（12/4 奈落・! 回避、1 の pickup を1回挟む）を貪欲に組む。
// 引数: [snapshot.json のパス] [maxX] [y0] [y1]（maxX より東の候補は除外）
// 出力: JSON 1行 {"route":[[x,y,tile],...],"steps":n,"items":[...],"blocked":[...]}
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[0] ?? "var/current/sub-snapshots/task-20.json";
const maxX = args[1] ? Number(args[1]) : 99;
const y0 = args[2] ? Number(args[2]) : -99;
const y1 = args[3] ? Number(args[3]) : 99;
const d = JSON.parse(readFileSync(file, "utf8"));
const tiles = new Map<string, { value: number }>();
for (const t of d.tiles) tiles.set(`${t.x},${t.y}`, t);
const WALK = (v: number) => [0, 2, 3, 5, 6, 7, 8, 9, 60, 62, 63, 71, 75, 1, 77, 79].includes(v);
const key = (x: number, y: number) => `${x},${y}`;
const pt = (k: string): [number, number] => k.split(",").map(Number) as [number, number];
const adj = (k: string) => {
  const [x, y] = pt(k);
  return ([[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]] as const)
    .map(([a, b]) => key(a, b))
    .filter((n) => { const t = tiles.get(n); return t && WALK(t.value); });
};
const bfs = (s: string) => {
  const dist = new Map([[s, 0]]); const prev = new Map<string, string>();
  const q = [s];
  while (q.length) { const k = q.shift()!; for (const n of adj(k)) if (!dist.has(n)) { dist.set(n, dist.get(k)! + 1); prev.set(n, k); q.push(n); } }
  return { dist, prev };
};
const path = (s: string, t: string): string[] | null => {
  if (s === t) return [s];
  const { dist, prev } = bfs(s);
  if (!dist.has(t)) return null;
  const p = [t]; while (p[0] !== s) p.unshift(prev.get(p[0]!)!);
  return p;
};
const inR = (t: any) => t.x <= maxX && t.y >= y0 && t.y <= y1;
const targets = [...tiles.entries()].filter(([k, t]) => inR(t) && (t.value === 77 || t.value === 79)).map(([k]) => k);
const ones = [...tiles.entries()].filter(([k, t]) => inR(t) && t.value === 1).map(([k]) => k);

let cur = key(d.position[0], d.position[1]);
const visited = new Set<string>([cur]);
const route: string[][] = [];
const picked = new Set<string>();
let oneDone = false;
while (true) {
  let best: { k: string; dd: number } | null = null;
  for (const t of targets) {
    if (visited.has(t)) continue;
    const dd = bfs(cur).dist.get(t);
    if (dd == null) continue;
    const score = dd; // 近い順
    if (!best || score < best.dd) best = { k: t, dd };
  }
  // 1 は東の孤立マスにあるので無理に取りに行かない（! 許可が要る）。77/79 が尽きた時だけ追加。
  void oneDone; void picked; void ones;
  if (!best) break;
  const p = path(cur, best.k);
  if (!p) break;
  for (const k of p.slice(1)) route.push([k, tiles.get(k)!.value]);
  cur = best.k; visited.add(best.k);
  const t = tiles.get(best.k)!;
  if (t.value === 1) { oneDone = true; picked.add(best.k); }
  for (const k of p) visited.add(k); // 通過点も再訪しない（一筆書き）
}
const blocked = targets.filter((t) => !visited.has(t)).map((k) => { const [x, y] = pt(k); return [x, y, tiles.get(k)!.value]; });
console.log(JSON.stringify({
  from: d.position, steps: route.length,
  collected: route.filter(([, v]) => v === 77 || v === 79 || v === 1).map(([k, v]) => `${k}=${v}`),
  route: route.map(([k, v]) => { const [x, y] = pt(k); return [x, y, v]; }),
  blocked,
}));
