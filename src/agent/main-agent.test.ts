import { afterAll, beforeAll, expect, test } from "bun:test";
import { WorldMap } from "../memory/world-map";
import { decideTurnAction } from "../solver/active-solver";
import { type AskResult, ClaudeSession } from "./claude-session";
import { MainAgent } from "./main-agent";
import { emptyUsage, type UsageTotals } from "./usage";

/**
 * Claude を呼ばない偽セッション。問い合わせごとに会話が 1000 トークン伸び、使用量も 1000 ずつ増える。
 * 要約係 (label=compact) は少し時間をかけて要約を返す。
 */
const proto = ClaudeSession.prototype as unknown as Record<string, unknown>;
const saved = new Map<string, PropertyDescriptor | undefined>();
const sent: { label: string; text: string }[] = [];

beforeAll(() => {
  for (const k of ["start", "ask", "stop", "busy", "alive", "usage", "contextSize"]) {
    saved.set(k, Object.getOwnPropertyDescriptor(ClaudeSession.prototype, k));
  }
  type Fake = { options: { label?: string }; fake?: { ctx: number; usage: UsageTotals; started: boolean } };
  const st = (s: Fake) => (s.fake ??= { ctx: 0, usage: emptyUsage(), started: false });
  proto.start = function (this: Fake) {
    st(this).started = true;
  };
  proto.stop = async function (this: Fake) {
    st(this).started = false;
  };
  Object.defineProperty(proto, "busy", { get: () => false, configurable: true });
  Object.defineProperty(proto, "alive", { get: function (this: Fake) { return st(this).started; }, configurable: true });
  Object.defineProperty(proto, "usage", { get: function (this: Fake) { return { ...st(this).usage }; }, configurable: true });
  Object.defineProperty(proto, "contextSize", { get: function (this: Fake) { return st(this).ctx || null; }, configurable: true });
  proto.ask = async function (this: Fake, text: string): Promise<AskResult> {
    const f = st(this);
    const label = this.options.label ?? "";
    sent.push({ label, text });
    f.ctx += 1000;
    f.usage = { ...f.usage, calls: f.usage.calls + 1, inputTokens: f.usage.inputTokens + 1000 };
    if (label === "compact") {
      await Bun.sleep(30);
      return { status: "ok", text: "要約: 北の未探索域を目指していた", durationMs: 30 };
    }
    const m = text.match(/\[TURN (\d+) \/ (CMD[12])\]/);
    const reply = m ? `{"turn": ${m[1]}, "phase": "${m[2]}", "action": "continue", "note": "ok"}` : "READY";
    return { status: "ok", text: reply, durationMs: 1 };
  };
});

afterAll(() => {
  for (const [k, d] of saved) if (d) Object.defineProperty(ClaudeSession.prototype, k, d);
});

async function playPhases(agent: MainAgent, n: number) {
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  const sources: string[] = [];
  for (let i = 0; i < n; i++) {
    const turn = Math.floor(i / 2) + 1;
    const phase = i % 2 === 0 ? "CMD1" : "CMD2";
    const r = await agent.decide({ turn, phase, worldMap: wm, events: [], solve: (plan) => decideTurnAction(wm, phase, turn, plan) });
    sources.push(r.source);
    await Bun.sleep(15); // サーバ往復ぶん（この間に裏の要約が進む）
  }
  return sources;
}

test("会話が閾値を超えると裏で要約し、試合を止めずにメインを入れ替える", async () => {
  Bun.env.AGENT_COMPACT_AT_TOKENS = "4000";
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const sources = await playPhases(agent, 12);

  // 要約中も毎フェーズ main が答えている（待たされていない）
  expect(sources.every((s) => s === "main")).toBe(true);
  const u = agent.usage();
  expect(u.compactions).toBeGreaterThanOrEqual(1);
  // 新しいメインは要約入りの RESUME から始まり、会話は小さく保たれる
  expect(sent.some((s) => s.label === "main" && s.text.startsWith("[MATCH RESUME]") && s.text.includes("要約: 北の未探索域"))).toBe(true);
  expect(sent.some((s) => s.label === "compact")).toBe(true);
  // ユーザー定義の作戦方針は開始時と入れ替え後の両方で渡る
  expect(sent[0]?.text).toContain("ユーザー定義の作戦方針");
  expect(sent.find((s) => s.text.startsWith("[MATCH RESUME]"))?.text).toContain("ユーザー定義の作戦方針");
  expect(u.mainContextTokens).toBeLessThan(12_000);
  // 使用量は入れ替え前のメイン・要約係も含めて数える
  expect(u.totalTokens).toBe(sent.length * 1000);
  await agent.end();
});

test("1試合のトークン上限を超えたらソルバーのみで続ける", async () => {
  Bun.env.AGENT_COMPACT_AT_TOKENS = "0";
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "3000";
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const sources = await playPhases(agent, 5);
  expect(sources.slice(0, 2)).toEqual(["main", "main"]);
  expect(sources.slice(2).every((s) => s === "solver")).toBe(true);
  expect(agent.usage().limitReached).toBe(true);
  await agent.end();
  delete Bun.env.AGENT_COMPACT_AT_TOKENS;
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});
