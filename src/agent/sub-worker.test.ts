import { expect, test } from "bun:test";
import { SubWorker } from "./sub-worker";

test("サブの待機は上限まで: 新しい依頼が来たら古い待機を取り消す（待ちが溜まって古い盤面の結果が届くのを防ぐ）", () => {
  Bun.env.AGENT_SUB_MAX_QUEUED = "1";
  const w = new SubWorker({});
  (w as unknown as { running: boolean }).running = true; // 実行中の仕事がある状態（実際のセッションは起動しない）
  const a = w.enqueue("A", "T1 CMD1");
  expect(a.cancelled).toEqual([]);
  const b = w.enqueue("B", "T1 CMD2");
  expect(b.cancelled.map((t) => t.id)).toEqual([a.task.id]);
  w.enqueue("C", "T2 CMD1");
  expect(w.all().map((t) => t.status)).toEqual(["cancelled", "cancelled", "queued"]);
  expect(w.all()[0]!.result).toContain("#2");
  expect(w.takeFinished()).toEqual([]); // 取り消しは結果として届けない（取り消した時に知らせる）
  expect(w.summary()).toContain("待機 1件");
  delete Bun.env.AGENT_SUB_MAX_QUEUED;
});
