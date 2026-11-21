import { expect, test } from "bun:test";
import { nextQueuedRoom, parseRoomQueue } from "./event-bus";

test("順に回るルーム: 並びを読み、今のルームの次へ進み、最後まで行ったら最初に戻る", () => {
  expect(parseRoomQueue("719, 555 3、 3,abc,-1")).toEqual([719, 555, 3]);
  expect(parseRoomQueue([719, 719, 555])).toEqual([719, 555]);
  const q = [719, 555, 3];
  expect(nextQueuedRoom(q, 719)).toBe(555);
  expect(nextQueuedRoom(q, 3)).toBe(719);
  expect(nextQueuedRoom(q, 10)).toBe(719); // 並びに無いルームからは先頭へ
  expect(nextQueuedRoom([], 719)).toBeNull();
  expect(nextQueuedRoom([719], 719)).toBe(719);
});
