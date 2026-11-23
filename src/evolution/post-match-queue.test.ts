import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EVALUATOR_PATH } from "../paths";
import { uiBus } from "../ui/event-bus";
import { beginEvaluatorEdit, endEvaluatorEdit, enqueuePostMatch, evaluatorPathForMatch, postMatchBusy, settlePostMatch, VERIFIED_EVALUATOR_PATH } from "./post-match-queue";

test("試合後の仕事は裏で1つずつ順に行い、進み具合は background に出す", async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  enqueuePostMatch("run-a", async (say) => {
    say("振り返り中");
    log.push("a start");
    await gate;
    log.push("a end");
  });
  enqueuePostMatch("run-b", async () => {
    log.push("b");
  });
  await Bun.sleep(20);
  expect(postMatchBusy()).toBe(true);
  expect(uiBus.getState().background).toMatchObject({ runId: "run-a", message: "振り返り中", pending: 1 });
  expect(log).toEqual(["a start"]);
  release();
  await settlePostMatch(2000);
  expect(log).toEqual(["a start", "a end", "b"]);
  expect(uiBus.getState().background).toBeNull();
});

test("評価関数を書き換えている間に始まった試合は、書き換える前の写しを使う（相対の import は絶対パスに）", () => {
  expect(evaluatorPathForMatch()).toBe(EVALUATOR_PATH);
  beginEvaluatorEdit();
  try {
    expect(evaluatorPathForMatch()).toBe(VERIFIED_EVALUATOR_PATH);
    const copy = readFileSync(VERIFIED_EVALUATOR_PATH, "utf-8");
    expect(copy).not.toMatch(/from\s+["']\.\.?\//);
    expect(copy).toContain("/src/memory/world-map");
  } finally {
    endEvaluatorEdit();
  }
  expect(evaluatorPathForMatch()).toBe(EVALUATOR_PATH);
});

test("書き換える前の写しは評価関数として読み込める", async () => {
  beginEvaluatorEdit();
  try {
    const mod = (await import(`${VERIFIED_EVALUATOR_PATH}?t=${Date.now()}`)) as { stepCost?: unknown; targetValue?: unknown };
    expect(typeof mod.stepCost).toBe("function");
    expect(typeof mod.targetValue).toBe("function");
  } finally {
    endEvaluatorEdit();
  }
});
