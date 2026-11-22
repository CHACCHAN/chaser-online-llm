// @temporary
// 目的: 生き残り移動可能マスの連結成分と、その蛇行一筆書きの上下ウィンドウ（反転）を JSON 1行で出す。
// 引数: [snapshot] x0 x1 y0 y1（探索範囲）
// 出力: {"comps":[{"size":n,"cells":[[x,y,tile]]}],"windows":[{"cols":[x0,x1],"rows":[y0,y1],"cells":n,"parityFlip":k}]}
import { readFileSync } from "node:fs";
const [file, ...nums] = process.argv.slice(2);
const [X0, X1, Y0, Y1] = nums.map(Number);
const d = JSON.parse(readFileSync(file, "utf8"));
const G = new Map<string, any>();
for (const t of d.tiles) G.set(`${t.x},${t.y}`, t);
const pass = (x: number, y: number) => {
  const t = G.get(`${x},${y}`);
  return !!t && t.visitedCount > 0 && t.value !== 4 && t.value !== 12 && t.value !== 0 && x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
};
const seen = new Set<string>();
const comps: any[] = [];
for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
  if (!pass(x, y) || seen.has(`${x},${y}`)) continue;
  const comp: any[] = []; const st = [[x, y]];
  while (st.length) {
    const [a, b] = st.pop()!;
    if (seen.has(`${a},${b}`) || !pass(a, b)) continue;
    seen.add(`${a},${b}`); comp.push([a, b, G.get(`${a},${b}`).value]);
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) st.push([a + dx, b + dy]);
  }
  comps.push(comp);
}
comps.sort((a, b) => b.length - a.length);
// ウィンドウ: 全行が埋まった列区間 × 全列が埋まった行区間
const S = new Set(comps[0]?.map((c) => `${c[0]},${c[1]}`) ?? []);
const windows: any[] = [];
for (let xa = X0; xa <= X1; xa++) for (let xb = xa; xb <= X1; xb++)
  for (let ya = Y0; ya <= Y1; ya++) for (let yb = ya; yb <= Y1; yb++) {
    let full = true;
    for (let x = xa; x <= xb && full; x++) for (let y = ya; y <= yb && full; y++) if (!S.has(`${x},${y}`)) full = false;
    if (full) windows.push({ cols: [xa, xb], rows: [ya, yb], cells: (xb - xa + 1) * (yb - ya + 1) });
  }
console.log(JSON.stringify({ comps: comps.map((c) => ({ size: c.length, cells: c })), windows: windows.sort((a, b) => b.cells - a.cells).slice(0, 10) }));
