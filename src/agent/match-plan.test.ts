import { expect, test } from "bun:test";
import { formatActionLine } from "./action-log";
import { ModelRuleWatcher, parseMatchPlan } from "./match-plan";

test("準備の返答の modelRules を読み、範囲に収め、知らないモデルは捨てる", () => {
  const plan = parseMatchPlan({ model: "collector", modelRules: { enemy: { model: "hunter", radius: 99 }, calm: { model: "nope", afterTurns: 3 } } });
  expect(plan.modelRules).toEqual({ enemy: { model: "hunter", radius: 12 } });
  expect(plan.notes.join(" ")).toContain("nope");
  expect(parseMatchPlan({}).modelRules).toBeNull();
});

test("切り替えの決まりは状態が変わった時だけ動く（その間は LLM の切り替えを上書きしない）", () => {
  const w = new ModelRuleWatcher({ enemy: { model: "hunter", radius: 5 }, calm: { model: "collector", afterTurns: 3 } });
  expect(w.check(1, null)).toBeNull(); // 敵を見ていないうちは calm も動かない
  expect(w.check(2, 7)).toBeNull();
  expect(w.check(3, 5)?.model).toBe("hunter");
  expect(w.check(4, 2)).toBeNull(); // 入ったまま
  expect(w.check(5, null)).toBeNull();
  expect(w.check(6, null)).toBeNull();
  expect(w.check(7, null)?.model).toBe("collector"); // 離れて 3 ターン
  expect(w.check(8, null)).toBeNull();
  expect(w.check(9, 4)?.model).toBe("hunter"); // また入った
});

test("行動ログに当てた・当てられた・置いた・直した目標を出す", () => {
  const line = formatActionLine(
    {
      turn: 62,
      cmd1: "grr",
      cmd2: "pr3sr",
      estimatedScoreAfter: 35110,
      putChange: { put: 0, putDamage: -14390 },
      llmReplies: [{ asked: 41, phase: "CMD1", by: ["stuck"], action: "plan", shift: { from: [-3, 8], to: [5, 7], reason: "x" } }],
    },
    49500,
  );
  expect(line).toContain("当てられた -14390");
  expect(line).toContain("置いた（pr3sr）");
  expect(line).toContain("目標 (-3,8) → ワープ後の座標 (5,7) に直した");
});
