// @temporary
// 目的: 「マス座標の通過セル列」を検証する。ロボットはセル境界上を0.5刻みで動けるので、セル列が隣接していれば移動可能（罠4/12のセルを通らない限り）。
// 引数: <snap.json> <cells.json>   cells.json = {"cells":[[x,y],...], "region":[x0,x1,y0,y1]}  座標はスナップの pos と同じ系
//        region 内の未回収75/77/79で cells に無いものを missing に出す。隣接していないセルは gaps に出す。
// 出力例: {"start":[1,-1],"cells":N,"bad":[["x,y",tile],...],"missing":[["x,y",tile],...]}
import { readFileSync } from "node:fs";
const [file, cf] = process.argv.slice(2) as [string, string];
const d = JSON.parse(readFileSync(file, "utf8"));
const T = new Map<string, { value: number }>();
for (const t of d.tiles) T.set(`${t.x},${t.y}`, t);
const c = JSON.parse(readFileSync(cf, "utf8"));
const cells: [number, number][] = c.cells;
const bad: string[] = [];
for (const [x, y] of cells) { const t = T.get(`${x},${y}`); if (!t) bad.push(`${x},${y}:?`); else if (t.value === 4) bad.push(`${x},${y}:4`); }
const seen = new Set(cells.map(([x, y]) => `${x},${y}`));
const vset = new Set([75, 77, 79]);
const missing: string[] = [];
for (const [k, t] of T) if (!t.visitedCount && vset.has(t.value) && c.region && t.x >= c.region[0] && t.x <= c.region[1] && t.y >= c.region[2] && t.y <= c.region[3] && !seen.has(k)) missing.push(k);
const gaps: string[] = [];
for (let i = 1; i < cells.length; i++) if (Math.abs(cells[i]![0] - cells[i - 1]![0]) + Math.abs(cells[i]![1] - cells[i - 1]![1]) !== 1) gaps.push(`${i}:${cells[i - 1]}->${cells[i]}`);
console.log(JSON.stringify({ start: d.position, cells: cells.length, bad, missing, gaps }));
