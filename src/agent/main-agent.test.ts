import { afterAll, beforeAll, expect, test } from "bun:test";
import { WorldMap } from "../memory/world-map";
import { decideTurnAction } from "../solver/active-solver";
import { type AskResult, ClaudeSession, type ClaudeSessionOptions } from "./claude-session";
import { MainAgent } from "./main-agent";
import { emptyUsage, type UsageTotals } from "./usage";

/**
 * Claude を呼ばない偽セッション。問い合わせ1回ごとに入力 1000 トークンを使ったことにする。
 * メインの返答には memo を付け、次のフェーズのメッセージにそれが引き継がれるかを確かめる。
 */
const proto = ClaudeSession.prototype as unknown as Record<string, unknown>;
const saved = new Map<string, PropertyDescriptor | undefined>();
const sent: { label: string; text: string; options: ClaudeSessionOptions }[] = [];
let spawned = 0;
let killed = 0;

beforeAll(() => {
  for (const k of ["start", "ask", "stop", "kill", "busy", "alive", "usage"]) {
    saved.set(k, Object.getOwnPropertyDescriptor(ClaudeSession.prototype, k));
  }
  type Fake = { options: ClaudeSessionOptions; fake?: { usage: UsageTotals; started: boolean } };
  const st = (s: Fake) => (s.fake ??= { usage: emptyUsage(), started: false });
  proto.start = function (this: Fake) {
    st(this).started = true;
    spawned++;
  };
  proto.stop = async function (this: Fake) {
    st(this).started = false;
  };
  proto.kill = function (this: Fake) {
    st(this).started = false;
    killed++;
  };
  Object.defineProperty(proto, "busy", { get: () => false, configurable: true });
  Object.defineProperty(proto, "alive", { get: function (this: Fake) { return st(this).started; }, configurable: true });
  Object.defineProperty(proto, "usage", { get: function (this: Fake) { return { ...st(this).usage }; }, configurable: true });
  proto.ask = async function (this: Fake, text: string): Promise<AskResult> {
    const f = st(this);
    const label = this.options.label ?? "";
    sent.push({ label, text, options: this.options });
    f.usage = { ...f.usage, calls: f.usage.calls + 1, inputTokens: f.usage.inputTokens + 1000 };
    const m = text.match(/\[TURN (\d+) \/ (CMD[12])\]/);
    const reply = m
      ? `{"turn": ${m[1]}, "phase": "${m[2]}", "action": "continue", "note": "ok", "memo": "T${m[1]}${m[2]}まで: 北へ"}`
      : "READY";
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
  }
  return sources;
}

test("毎フェーズ使い捨ての問い合わせで、メモと直近の経過だけを引き継ぐ", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  spawned = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const sources = await playPhases(agent, 6);

  expect(sources.every((s) => s === "main")).toBe(true);
  const mains = sent.filter((s) => s.label === "main");
  expect(mains.length).toBe(6);
  // 問い合わせごとに別プロセス（＋次の分を先に起動）、ツールなし・保存なし・システムプロンプト置き換え
  expect(spawned).toBe(7); // メイン6回分 ＋ 次のフェーズ用に先に起動した1（サブは仕事が来た時だけ起動）
  for (const s of mains) {
    expect(s.options.tools).toBe("");
    expect(s.options.noSessionPersistence).toBe(true);
    expect(s.options.systemPrompt).toContain("ユーザー定義の作戦方針");
  }
  // 前のフェーズのメモと経過がメッセージに入る
  expect(mains[0]!.text).toContain("(まだない)");
  expect(mains[3]!.text).toContain("T2CMD1まで: 北へ");
  expect(mains[3]!.text).toContain("T1 CMD1");
  expect(agent.currentMemo).toBe("T3CMD2まで: 北へ");
  // 1回あたりの入力が一定（会話が伸びない）
  expect(agent.usage().lastCallInputTokens).toBe(1000);
  expect(agent.usage().totalTokens).toBe(6000);
  await agent.end();
});

test("1試合のトークン上限を超えたらソルバーのみで続ける", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "2000";
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const sources = await playPhases(agent, 5);
  expect(sources.slice(0, 2)).toEqual(["main", "main"]);
  expect(sources.slice(2).every((s) => s === "solver")).toBe(true);
  expect(agent.usage().limitReached).toBe(true);
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});
