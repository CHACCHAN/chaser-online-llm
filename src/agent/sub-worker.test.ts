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

test("依頼時の盤面をファイルに残し、サブには区画・座標世代とともにそのファイルを読ませる。結果はメインが受け取るまで残る", async () => {
  const w = new SubWorker({});
  w.start();
  const asked: string[] = [];
  (w as unknown as { newSession: () => unknown }).newSession = () => ({
    usage: { calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    ask: async (text: string) => {
      asked.push(text);
      return { status: "ok", text: "結果", durationMs: 10 };
    },
    stop: async () => {},
    kill: () => {},
  });
  const t = w.enqueue("東の箱を調べて", "T5 CMD1", { turn: 5, phase: "CMD1", segment: 2, frameVersion: 3, snapshot: '{"position":[1,2]}' });
  await Bun.sleep(5);
  expect(t.context?.snapshotPath).toContain("sub-snapshots/task-1.json");
  expect(asked[0]).toContain("sub-snapshots/task-1.json");
  expect(asked[0]).toContain("区画2・座標世代3");
  expect(w.peekFinished().map((x) => x.id)).toEqual([1]);
  expect(w.peekFinished().map((x) => x.id)).toEqual([1]); // 届けたことにするまで残る
  w.markReported([1]);
  expect(w.peekFinished()).toEqual([]);
  await w.stop();
});
