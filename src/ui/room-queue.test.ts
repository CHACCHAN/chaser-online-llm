import { expect, test } from "bun:test";
import { formatRoomQueue, nextQueuedRoom, parseRoomQueue } from "./event-bus";

test("ルーム欄: 1つ・範囲・並べる（組み合わせも可）", () => {
  expect(parseRoomQueue("719")).toEqual([719]);
  expect(parseRoomQueue("555-560")).toEqual([555, 556, 557, 558, 559, 560]);
  expect(parseRoomQueue("555,568")).toEqual([555, 568]);
  expect(parseRoomQueue("555-557, 568 3、3")).toEqual([555, 556, 557, 568, 3]);
  expect(parseRoomQueue("560-558")).toEqual([560, 559, 558]);
  expect(parseRoomQueue("1-100000")).toHaveLength(100); // 打ち間違いの上限
  expect(parseRoomQueue("abc,-1,0")).toEqual([]);
  expect(formatRoomQueue([555, 556, 557, 568])).toBe("555-557,568");
  expect(formatRoomQueue([555, 556])).toBe("555,556");
});

test("複数のルーム: 今のルームの次へ進み、最後まで行ったら最初に戻る", () => {
  const q = [719, 555, 3];
  expect(nextQueuedRoom(q, 719)).toBe(555);
  expect(nextQueuedRoom(q, 3)).toBe(719);
  expect(nextQueuedRoom(q, 10)).toBe(719);
  expect(nextQueuedRoom([], 719)).toBeNull();
});
