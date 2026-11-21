import { expect, test } from "bun:test";
import { SubWorker } from "./sub-worker";

/** 実際の Claude セッションは起動せず、ask の終わりを外から決められる偽のセッション */
function fakeSessions() {
  const pending: Array<() => void> = [];
  const make = () => ({
    usage: { calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    ask: () => new Promise((resolve) => pending.push(() => resolve({ status: "ok", text: "結果", durationMs: 1000 }))),
    stop: async () => {},
    kill: () => {},
  });
  return { pending, make };
}

test("サブは AGENT_SUB_CONCURRENCY 件まで同時に動き、超えた依頼は待機して、空いたら順に始まる（待機の上限は無い）", async () => {
  Bun.env.AGENT_SUB_CONCURRENCY = "5";
  const w = new SubWorker({});
  const fake = fakeSessions();
  (w as unknown as { newSession: () => unknown }).newSession = fake.make;
  for (let i = 1; i <= 8; i++) w.enqueue(`依頼${i}`, `T${i} CMD1`);
  const status = () => w.all().map((t) => t.status);
  expect(status()).toEqual(["running", "running", "running", "running", "running", "queued", "queued", "queued"]);
  expect(w.summary()).toContain("作業中 5件");
  expect(w.summary()).toContain("待機 3件");
  expect(w.summary()).toContain("同時に5件まで");
  fake.pending[0]!(); // 1件目が終わる
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(status()).toEqual(["done", "running", "running", "running", "running", "running", "queued", "queued"]);
  expect(w.takeFinished().map((t) => t.id)).toEqual([1]);
  expect(w.summary()).toContain("1件あたり平均1s");
  delete Bun.env.AGENT_SUB_CONCURRENCY;
});
