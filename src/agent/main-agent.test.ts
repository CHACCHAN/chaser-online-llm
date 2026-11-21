import { afterAll, beforeAll, expect, test } from "bun:test";
import { WorldMap } from "../memory/world-map";
import { decideTurnAction } from "../solver/active-solver";
import { type AskResult, ClaudeSession, type ClaudeSessionOptions } from "./claude-session";
import { readFileSync } from "node:fs";
import { CURRENT_ASK_SUB_PATH, CURRENT_MEMO_PATH } from "../paths";
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

test("サブへの依頼は TODO として次のフェーズ以降のメッセージに必ず載る", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  // 最初のフェーズで delegate を返させる
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  let once = true;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    if (once && this.options.label === "main") {
      once = false;
      sent.push({ label: "main", text, options: this.options });
      return { status: "ok", text: '{"turn": 1, "phase": "CMD1", "action": "continue", "delegate": "タイル15の得点を調べる"}', durationMs: 1 };
    }
    return origAsk.call(this, text);
  };
  await playPhases(agent, 3);
  proto.ask = origAsk;
  const mains = sent.filter((s) => s.label === "main");
  expect(mains[0]!.text).not.toContain("サブへの依頼（TODO）");
  expect(mains[1]!.text).toContain("サブへの依頼（TODO）");
  expect(mains[1]!.text).toMatch(/#1 \[(待機|作業中|完了)[^\]]*\] T1 CMD1に依頼: タイル15の得点を調べる/);
  // 人が見られるようにファイルにも書き出す
  expect(readFileSync(CURRENT_ASK_SUB_PATH, "utf-8")).toContain("タイル15の得点を調べる");
  expect(readFileSync(CURRENT_MEMO_PATH, "utf-8")).toContain("まで: 北へ");
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("memo に { } が入っていても返答を読める", async () => {
  const { parseMainReply } = await import("./main-agent");
  const text = '北へ向かう\n{"turn": 3, "phase": "CMD1", "action": "plan", "target": [2, -1], "memo": "敵は {東} に逃げた"}';
  expect(parseMainReply(text, 3, "CMD1", ["gr"])).toEqual({ action: "plan", target: [2, -1], note: undefined, delegate: undefined, memo: "敵は {東} に逃げた" });
  // コードブロックで囲まれていても読む
  expect(parseMainReply('```json\n{"turn": 3, "phase": "CMD1", "action": "continue"}\n```', 3, "CMD1", ["gr"])?.action).toBe("continue");
});

test("ワープで座標系が変わったら作戦目標を解除し、メッセージで知らせる", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    sent.push({ label: this.options.label ?? "", text, options: this.options });
    const m = text.match(/\[TURN (\d+) \/ (CMD[12])\]/)!;
    return { status: "ok", text: `{"turn": ${m[1]}, "phase": "${m[2]}", "action": "${m[2] === "CMD1" ? "plan" : "continue"}", "target": [1, 1]}`, durationMs: 1 };
  };
  const step = (turn: number, phase: "CMD1" | "CMD2") =>
    agent.decide({ turn, phase, worldMap: wm, events: [], solve: (plan) => decideTurnAction(wm, phase, turn, plan) });
  await step(1, "CMD1");
  expect(agent.currentPlan?.target).toEqual([1, 1]);
  (wm as unknown as { frameVersionCount: number }).frameVersionCount += 1; // ワープ
  await step(1, "CMD2");
  proto.ask = origAsk;
  expect(agent.currentPlan).toBeNull();
  expect(sent[sent.length - 1]!.text).toContain("ワープで座標系が変わった");
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("準備フェーズ（開始より前）: 読むだけのツールで調べさせ、そのメモから試合を始める", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    if (this.options.label === "prep") {
      sent.push({ label: "prep", text, options: this.options });
      return { status: "ok", text: '過去3試合を読んだ\n{"memo": "東に G の塊。南西の奈落に注意。序盤は北の土を一筆書き"}', durationMs: 5 };
    }
    return origAsk.call(this, text);
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>ver 20260217</html>")) as unknown as typeof fetch;
  const { runPrepPhase } = await import("./main-agent");
  const prep = await runPrepPhase({}, 1);
  globalThis.fetch = origFetch;
  proto.ask = origAsk;
  expect(prep.status).toBe("ok");
  expect(prep.memo).toBe("東に G の塊。南西の奈落に注意。序盤は北の土を一筆書き");
  expect(prep.official.version).toBe("20260217");
  const p = sent.find((x) => x.label === "prep")!;
  expect(p.options.tools).toBe("Read,Glob,Grep");
  expect(p.text).toContain("このルームの過去の試合");
  expect(p.text).toContain("ユーザー定義の作戦方針");

  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 }, { memo: prep.memo, usage: prep.usage });
  expect(agent.currentMemo).toBe(prep.memo);
  await playPhases(agent, 1);
  expect(sent.find((x) => x.label === "main")!.text).toContain("東に G の塊");
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("安全ガード: 行き先が罠・通行不可の直接指定を見分ける（未観測・静止は危険としない）", async () => {
  const { landingDanger } = await import("./main-agent");
  const wm = new WorldMap();
  // 上=ジオード(4) 左=奈落(12) 右=岩盤(10) 下=土(2)
  wm.applyObservation("CMD1", "gr", [2, 4, 2, 12, 1000, 10, 2, 2, 2], 1);
  expect(landingDanger(wm, "gru")).toContain("罠(4)");
  expect(landingDanger(wm, "wl")).toContain("罠(12)");
  expect(landingDanger(wm, "wr")).toContain("通行不可(10)");
  expect(landingDanger(wm, "wd")).toBeNull();
  expect(landingDanger(wm, "gr")).toBeNull();
  expect(landingDanger(wm, "keird")).toBeNull(); // 未観測
});

test("試合後: 振り返りと同じ会話でハーネスのレビューを聞く（使用量は二重に数えない）", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  await agent.postMatch("(diag)", "/tmp/run", 5000);
  const afterPost = agent.usage().main.calls;
  const review = await agent.reviewHarness({ runDir: "/tmp/run", reverted: [], verificationOk: true, rolledBack: false }, 5000);
  expect(review).toBe("READY");
  const post = sent.find((x) => x.text.startsWith("[POST-MATCH]"))!;
  const rev = sent.find((x) => x.text.startsWith("[HARNESS REVIEW]"))!;
  expect(rev.options).toBe(post.options); // 同じセッション（振り返りの経験を持ったまま）
  expect(rev.text).not.toContain("この試合のログ:"); // 続きなのでログの場所は繰り返さない
  expect(agent.usage().main.calls).toBe(afterPost + 1);
  await agent.end();
  expect(agent.usage().main.calls).toBe(afterPost + 1);
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("試合中のメインには knowledge/commands.md の中身を入れ、AGENTS.md（案内）は付けない", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  await playPhases(agent, 1);
  const main = sent.find((x) => x.label === "main")!;
  expect(main.options.systemPrompt).toContain("## ゲームのコマンド（knowledge/commands.md）");
  expect(main.options.systemPrompt).toContain("`w3u`");
  expect(main.options.systemPrompt).toContain("## ゲームのルール（knowledge/official-rules.md）");
  expect(main.options.agentsGuide).toBe(false);
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});
