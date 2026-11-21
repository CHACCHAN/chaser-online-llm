import { expect, test } from "bun:test";
import { getRoomProfile, recordRoomWarp, roomCells, setCellNote } from "./knowledge-store";
import { WorldMap } from "./world-map";

test("ワープの記録: 同じ入口・着地は回数を足し、近い順に引ける。タイル番号ごとの飛び方も出る", () => {
  const room = 90001;
  recordRoomWarp(room, { tileValue: 23, from: [24, 14], to: [24, 29] }, "run-a");
  recordRoomWarp(room, { tileValue: 23, from: [24, 14], to: [24, 29] }, "run-b");
  recordRoomWarp(room, { tileValue: 31, from: [2, 2], to: [-3, 2] }, "run-b");
  expect(getRoomProfile(room).warps?.length).toBe(2);
  const near = roomCells(room, [25, 14], 5);
  expect(near.warps.map((w) => [w.from, w.count])).toEqual([[[24, 14], 2]]);
  expect(roomCells(room).tileJumps).toEqual([
    { tile: 23, jumps: [{ delta: [0, 15], count: 2 }] },
    { tile: 31, jumps: [{ delta: [-5, 0], count: 1 }] },
  ]);
});

test("マスのメモ: 足せて、空のメモで消せる", () => {
  const room = 90002;
  setCellNote(room, 3, 4, "罠の手前。北から入る");
  expect(setCellNote(room, 3, 4, "2回目")).toEqual(["罠の手前。北から入る", "2回目"]);
  expect(roomCells(room, [3, 5], 1).notes[0]?.notes.length).toBe(2);
  expect(setCellNote(room, 3, 4, "")).toEqual([]);
  expect(roomCells(room).notes).toEqual([]);
});

test("getGlobalWarpLinks: 入口・着地の両方の区画の位置合わせが済んだワープだけ絶対座標で返す", () => {
  const wm = new WorldMap() as unknown as {
    warpLinks: unknown[];
    segmentOffsets: Map<number, [number, number]>;
    getGlobalWarpLinks: WorldMap["getGlobalWarpLinks"];
  };
  wm.warpLinks.push(
    { tileValue: 23, fromSegment: 0, fromPos: [2, 1], toSegment: 1, toPos: [0, 0], observedTurn: 5 },
    { tileValue: 31, fromSegment: 1, fromPos: [1, 0], toSegment: 2, toPos: [0, 0], observedTurn: 9 },
  );
  wm.segmentOffsets.set(0, [11, 10]);
  wm.segmentOffsets.set(1, [13, 26]);
  expect(wm.getGlobalWarpLinks()).toEqual([{ index: 0, tileValue: 23, from: [13, 11], to: [13, 26], observedTurn: 5 }]);
});

test("ワープのタイル（20〜23・30〜33・40〜43・50〜53・60〜63）以外からの記録は引かない。メモは160字で切る", async () => {
  const { isWarpTile, CELL_NOTE_MAX_CHARS } = await import("./knowledge-store");
  expect([20, 23, 33, 41, 53, 60, 63].every(isWarpTile)).toBe(true);
  expect([1, 24, 34, 70, 77, 79].some(isWarpTile)).toBe(false);
  const room = 90004;
  recordRoomWarp(room, { tileValue: 77, from: [0, 38], to: [11, 10] }, "r"); // 誤検知（古い版が残したもの）
  recordRoomWarp(room, { tileValue: 30, from: [9, 16], to: [9, 21] }, "r");
  expect(roomCells(room).warps.map((w) => w.tile)).toEqual([30]);
  expect(roomCells(room).tileJumps).toEqual([{ tile: 30, jumps: [{ delta: [0, 5], count: 1 }] }]);
  expect(setCellNote(room, 1, 1, "あ".repeat(300))[0]!.length).toBe(CELL_NOTE_MAX_CHARS);
});
