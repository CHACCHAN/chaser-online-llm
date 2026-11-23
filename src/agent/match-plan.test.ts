import { expect, test } from "bun:test";
import { formatActionLine } from "./action-log";
import { parseMatchPlan } from "./match-plan";
import { WorldMap } from "../memory/world-map";
import * as defaultTactics from "../solver/tactics";
import { TacticsRuntime } from "../solver/tactics-runtime";

test("準備の返答の modelRules を読み、範囲に収め、知らないモデルは捨てる", () => {
  const plan = parseMatchPlan({ model: "collector", modelRules: { enemy: { model: "hunter", radius: 99 }, calm: { model: "nope", afterTurns: 3 } } });
  expect(plan.modelRules).toEqual({ enemy: { model: "hunter", radius: 12 } });
  expect(plan.notes.join(" ")).toContain("nope");
  expect(parseMatchPlan({}).modelRules).toBeNull();
});

test("作戦スクリプト（既定）: 切り替えの決まりは状態が変わった時だけ動く（その間は LLM の切り替えを上書きしない）", () => {
  const models = ["standard", "hunter", "collector"].map((id) => ({ id, name: id, trait: "" }));
  const rt = new TacticsRuntime(defaultTactics, { models, startModel: "collector", rules: { enemy: { model: "hunter", radius: 5 }, calm: { model: "collector", afterTurns: 3 } }, inSim: true });
  let model = "collector";
  const step = (turn: number, nearest: number | null) => {
    const wm = new WorldMap();
    if (nearest !== null) wm.recordEnemySightingForTest(2000, nearest, 0, turn);
    const a = rt.step({ wm, phase: "CMD1", turn, totalTurns: 100, model, llmTarget: null, llm: { available: false, thinking: false, lastAskedTurn: null, calls: 0 }, signals: [] }).action;
    if (a.model) model = a.model;
    return a.model ?? null;
  };
  expect(step(1, null)).toBeNull();
  expect(step(2, 7)).toBeNull();
  expect(step(3, 5)).toBe("hunter");
  expect(step(4, 2)).toBeNull();
  expect(step(5, null)).toBeNull();
  expect(step(6, null)).toBeNull();
  expect(step(7, null)).toBe("collector");
  expect(step(8, 4)).toBe("hunter");
  expect(rt.stats.errors).toBe(0);
});

test("作戦スクリプトの例外・おかしな値は使わずに数える", () => {
  const models = [{ id: "standard", name: "s", trait: "" }];
  const rt = new TacticsRuntime({ onPhase: (s) => { if (s.turn === 1) throw new Error("boom"); return { model: "nope", target: [1.5, 2] as [number, number], askLlm: "x" }; } }, { models, startModel: "standard", rules: null, inSim: true });
  const input = (turn: number) => ({ wm: new WorldMap(), phase: "CMD1" as const, turn, totalTurns: 10, model: "standard", llmTarget: null, llm: { available: false, thinking: false, lastAskedTurn: null, calls: 0 }, signals: [] });
  expect(rt.step(input(1)).action).toEqual({});
  const a = rt.step(input(2)).action;
  expect(a.model).toBeUndefined();
  expect(a.target).toBeUndefined();
  expect(a.askLlm).toBe("x");
  expect(rt.stats.errors).toBe(3);
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
