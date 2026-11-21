import { expect, test } from "bun:test";
import { type MeasureTurn, measureTileScores } from "./tile-measure";

const TRUE_SCORE: Record<number, number> = { 0: 0, 5: 125, 61: 5, 71: 400, 2: 10 };

/** 決まった並びで踏むタイルを作り、Webマップの得点を毎ターン（ときどき取りこぼし）届ける */
function makeTurns(opts: { includeCurrentTurn: boolean }): MeasureTurn[] {
  const pattern = [[0], [0, 0], [5], [0], [61], [0, 2], [71], [0], [2], [0, 5], [], [61, 0], [71, 0], [0], [2, 2]];
  const total = 500;
  const turns: MeasureTurn[] = [];
  let item = 0;
  for (let t = 1; t <= 90; t++) {
    const tiles = pattern[(t * 7) % pattern.length]!;
    const landed: Record<string, number> = {};
    for (const v of tiles) landed[v] = (landed[v] ?? 0) + 1;
    const gain = tiles.reduce((s, v) => s + TRUE_SCORE[v]!, 0);
    // 画面はこのターンの手を打つ前の状態（includeCurrentTurn なら打った後）
    const shown = opts.includeCurrentTurn ? item + gain : item;
    turns.push({ turn: t, landed, webScore: t % 9 === 0 ? null : { ourTurn: t, webTurn: total + 1 - t, itemPoint: shown } });
    item += gain;
  }
  return turns;
}

test("Webマップの公式のアイテム得点の変化から、踏んだタイルの得点を測る", () => {
  const r = measureTileScores(makeTurns({ includeCurrentTurn: false }));
  expect(r.offset).toBe(0);
  const scores = Object.fromEntries(r.tiles.map((t) => [t.value, t.score]));
  expect(scores).toEqual(TRUE_SCORE);
});

test("画面がターンの手の後の状態でも、境目のずれを見つけて測れる", () => {
  const r = measureTileScores(makeTurns({ includeCurrentTurn: true }));
  expect(r.offset).toBe(1);
  expect(Object.fromEntries(r.tiles.map((t) => [t.value, t.score]))).toEqual(TRUE_SCORE);
});

test("得点が取れていない・推定が揃わないタイルは出さない", () => {
  expect(measureTileScores([{ turn: 1, landed: { "5": 1 } }]).tiles).toEqual([]);
  // 61 を踏んだ区間の得点がばらばら → 61 は出さない
  const turns: MeasureTurn[] = [];
  const gains = [5, 300, 5, 300];
  let item = 0;
  for (let t = 1; t <= 5; t++) {
    turns.push({ turn: t, landed: t <= 4 ? { "61": 1 } : {}, webScore: { ourTurn: t, webTurn: 100 - t, itemPoint: item } });
    item += gains[t - 1] ?? 0;
  }
  expect(measureTileScores(turns).tiles.find((x) => x.value === 61)).toBeUndefined();
});
