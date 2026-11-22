import { afterAll, beforeAll, expect, test } from "bun:test";
import { WorldMap } from "../memory/world-map";
import { makePlannerPolicy } from "../solver/policy";
import type { AgentPlan } from "../solver/types";
import { type AskResult, ClaudeSession, type ClaudeSessionOptions } from "./claude-session";
import { readFileSync } from "node:fs";
import { CURRENT_MEMO_PATH } from "../paths";
import { type MainDecision, MainAgent } from "./main-agent";
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

const policy = makePlannerPolicy();
const ctxOf = (wm: WorldMap, turn: number, phase: "CMD1" | "CMD2") => ({
  turn,
  phase,
  worldMap: wm,
  events: [] as string[],
  solve: (plan: AgentPlan | null) => policy(wm, phase, turn, { totalTurns: null, directive: plan }),
});

/** 裏で聞いて、返答が届くまで待つ（テストでは1回ずつ順に） */
function askOnce(agent: MainAgent, wm: WorldMap, turn: number, phase: "CMD1" | "CMD2"): Promise<MainDecision | null> {
  return new Promise((resolve) => {
    if (!agent.startBackground(ctxOf(wm, turn, phase), (r) => resolve(r))) resolve(null);
  });
}

async function playPhases(agent: MainAgent, n: number) {
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  const sources: string[] = [];
  for (let i = 0; i < n; i++) {
    const turn = Math.floor(i / 2) + 1;
    const phase = i % 2 === 0 ? "CMD1" : "CMD2";
    const r = await askOnce(agent, wm, turn, phase);
    sources.push(r?.source ?? "none");
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
  expect(spawned).toBe(7); // 6回分 ＋ 次の問い合わせ用に先に起動した1
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

test("1試合のトークン上限を超えたら方策だけで続ける", async () => {
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

test("メモは人が見られるようにファイルにも書き出す", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  await playPhases(agent, 2);
  expect(readFileSync(CURRENT_MEMO_PATH, "utf-8")).toContain("まで: 北へ");
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("memo に { } が入っていても返答を読める", async () => {
  const { parseMainReply } = await import("./main-agent");
  const text = '北へ向かう\n{"turn": 3, "phase": "CMD1", "action": "plan", "target": [2, -1], "memo": "敵は {東} に逃げた"}';
  expect(parseMainReply(text, 3, "CMD1", ["gr"])).toEqual({ action: "plan", target: [2, -1], note: undefined, memo: "敵は {東} に逃げた" });
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
  const step = (turn: number, phase: "CMD1" | "CMD2") => askOnce(agent, wm, turn, phase);
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

test("試合後: 振り返りと同じ会話でハーネスのレビューを聞く（使用量は二重に数えない）", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  await agent.postMatch("(diag)", "/tmp/run", 5000);
  const afterPost = agent.usage().main.calls;
  const review = await agent.reviewHarness({ runDir: "/tmp/run", reverted: [], evaluatorChanged: false, rolledBack: false }, 5000);
  expect(review).toBe("READY");
  const post = sent.find((x) => x.text.startsWith("[POST-MATCH]"))!;
  const rev = sent.find((x) => x.text.startsWith("[HARNESS REVIEW]"))!;
  expect(rev.options).toBe(post.options); // 同じセッション（振り返りの経験を持ったまま）
  expect(post.options.tools).toBe("Bash,Read,Edit,Write,Glob,Grep"); // 別の Claude セッションへ送る SendMessage などは渡さない
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
  expect(main.options.systemPrompt).toContain("`w3*`");
  expect(main.options.systemPrompt).toContain("## ゲームのルール（knowledge/official-rules.md）");
  expect(main.options.agentsGuide).toBe(false);
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("memo_add: 全文を書き直さずにメモの末尾へ1行足せる（上限を超える時は入れずに知らせる）", async () => {
  const { parseMainReply } = await import("./main-agent");
  const r = parseMainReply('{"turn": 3, "phase": "CMD1", "action": "continue", "memo_add": "東にワープ(23)"}', 3, "CMD1", ["gr"]);
  expect(r?.memoAdd).toBe("東にワープ(23)");
  expect(parseMainReply('{"action": "continue", "memo_add": ["北は穴", "西に77"]}', 3, "CMD1", ["gr"])?.memoAdd).toBe("北は穴\n西に77");
  const agent = new MainAgent({}, 5000) as unknown as { memo: string; notices: string[]; applyMemo(r: unknown): void };
  Bun.env.AGENT_MEMO_MAX_CHARS = "100";
  agent.memo = "北は回収済み";
  agent.applyMemo({ action: "continue", memoAdd: "東にワープ(23)" });
  expect(agent.memo).toBe("北は回収済み\n東にワープ(23)");
  agent.applyMemo({ action: "continue", memoAdd: "x".repeat(100) });
  expect(agent.memo).toBe("北は回収済み\n東にワープ(23)");
  expect(agent.notices.at(-1)).toContain("memo_add はメモの上限");
  delete Bun.env.AGENT_MEMO_MAX_CHARS;
});

test("memo_set: メモの行を番号で書き換え・削除できる（行番号を書き写しても残さない）", async () => {
  const { parseMainReply } = await import("./main-agent");
  const r = parseMainReply('{"action": "continue", "memo_set": {"2": "西は回収済み", "3": "", "x": "無視"}}', 3, "CMD1", ["gr"]);
  expect(r?.memoSet).toEqual({ 2: "西は回収済み", 3: "" });
  const agent = new MainAgent({}, 5000) as unknown as { memo: string; notices: string[]; applyMemo(r: unknown): void };
  agent.memo = "目標 57万点\n西に77が3つ\n(2,0)はワープ\n北は罠";
  agent.applyMemo({ action: "continue", memoSet: { 2: "西は回収済み", 3: "", 9: "x" } });
  expect(agent.memo).toBe("目標 57万点\n西は回収済み\n北は罠");
  expect(agent.notices.at(-1)).toContain("行番号 9");
  agent.applyMemo({ action: "continue", memo: "1| 書き直し\n2| 二行目", memoAdd: "3| 追記" });
  expect(agent.memo).toBe("書き直し\n二行目\n追記");
});

test("既知のワープ・マスのメモを、今の座標（[ ] に絶対座標）で見せる。Webマップなしはこの試合の今の区画だけ", async () => {
  const { recordRoomWarp, setCellNote } = await import("../memory/knowledge-store");
  recordRoomWarp(90003, { tileValue: 23, from: [24, 14], to: [24, 29] }, "r");
  setCellNote(90003, 25, 14, "東は罠");
  const agent = new MainAgent({}, 5000) as unknown as { room: number | null; knownCellLines(wm: unknown): string[] };
  agent.room = 90003;
  const webMap = { getGlobalOffset: () => [20, 10], getGlobalPosition: () => [24, 15], getSegmentIndex: () => 0, getWarpLinks: () => [] };
  expect(agent.knownCellLines(webMap)).toEqual(["既知のワープ（過去の試合も含む実測）: (4,4)[24,14] 23番→(4,19)[24,29] 1回", "マスのメモ: (5,4)[25,14] 東は罠"]);
  const noWeb = {
    getGlobalOffset: () => null,
    getGlobalPosition: () => null,
    getSegmentIndex: () => 1,
    getWarpLinks: () => [
      { tileValue: 31, fromSegment: 1, fromPos: [2, 0], toSegment: 2, toPos: [0, 0], observedTurn: 3 },
      { tileValue: 23, fromSegment: 0, fromPos: [5, 5], toSegment: 1, toPos: [0, 0], observedTurn: 1 },
    ],
  };
  expect(agent.knownCellLines(noWeb)).toEqual(["この試合で入ったワープ（今の区画）: (2,0) 31番→別の区画"]);
});

test("通知は、LLM が正常に返答した問い合わせで届けたことにする（時間切れの問い合わせに載ったものは次に再掲）", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  Bun.env.AGENT_HEDGE_SEC = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  (agent as unknown as { notices: string[] }).notices.push("大事な知らせ");
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  let n = 0;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    if (this.options.label === "main" && n++ === 0) {
      sent.push({ label: "main", text, options: this.options });
      return { status: "timeout", durationMs: 5000 };
    }
    return origAsk.call(this, text);
  };
  await playPhases(agent, 3);
  proto.ask = origAsk;
  const mains = sent.filter((s) => s.label === "main");
  expect(mains[0]!.text).toContain("大事な知らせ"); // 時間切れ
  expect(mains[1]!.text).toContain("大事な知らせ"); // 再掲 → 正常に返答
  expect(mains[2]!.text).not.toContain("大事な知らせ");
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
  delete Bun.env.AGENT_HEDGE_SEC;
});

test("AGENT_HEDGE_SEC たっても返らなければ、もう1つのプロセスにも送り、先に返った方を使う", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  Bun.env.AGENT_HEDGE_SEC = "0.05";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  let n = 0;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    if (this.options.label === "main" && n++ === 0) {
      await Bun.sleep(400); // 詰まった1つ目
      return { status: "timeout", durationMs: 400 };
    }
    return origAsk.call(this, text);
  };
  const t0 = Date.now();
  const sources = await playPhases(agent, 1);
  proto.ask = origAsk;
  expect(sources).toEqual(["main"]);
  expect(Date.now() - t0).toBeLessThan(350);
  expect(agent.usage().hedges).toBe(1);
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
  delete Bun.env.AGENT_HEDGE_SEC;
});

test("手を待たずに裏で聞き、考え中は重ねて聞かない。返答の作戦は届いた時から使う", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    sent.push({ label: this.options.label ?? "", text, options: this.options });
    await gate;
    const m = text.match(/\[TURN (\d+) \/ (CMD[12])\]/)!;
    return { status: "ok", text: `{"turn": ${m[1]}, "phase": "${m[2]}", "action": "plan", "target": [1, 1], "memo": "裏で考えた"}`, durationMs: 1 };
  };
  const done: string[] = [];
  const ctx = (turn: number, phase: "CMD1" | "CMD2") => ctxOf(wm, turn, phase);
  expect(agent.startBackground(ctx(1, "CMD1"), (r) => done.push(r?.action ?? "error"))).toBe(true);
  // 考え中: 次のフェーズでは聞かない（手は待たない）
  expect(agent.startBackground(ctx(1, "CMD2"), () => done.push("x"))).toBe(false);
  expect(agent.thinking).toBe(true);
  expect(agent.currentPlan).toBeNull();
  release();
  await agent.settleBackground(1000);
  expect(done).toEqual(["plan"]);
  expect(agent.currentPlan?.target).toEqual([1, 1]);
  expect(agent.currentMemo).toBe("裏で考えた");
  expect(agent.thinking).toBe(false);
  // 作戦係としての説明がシステムプロンプトに入る
  expect(sent[0]!.options.systemPrompt).toContain("作戦係");
  proto.ask = origAsk;
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("考えている間にワープしたら、返答の作戦目標（古い座標）は使わない", async () => {
  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 });
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    (wm as unknown as { frameVersionCount: number }).frameVersionCount += 1; // 考えている間にワープ
    const m = text.match(/\[TURN (\d+) \/ (CMD[12])\]/)!;
    return { status: "ok", text: `{"turn": ${m[1]}, "phase": "${m[2]}", "action": "plan", "target": [1, 1]}`, durationMs: 1 };
  };
  agent.startBackground(ctxOf(wm, 1, "CMD1"), () => {});
  await agent.settleBackground(1000);
  expect(agent.currentPlan).toBeNull();
  proto.ask = origAsk;
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});

test("準備の返答から試合の設定（最初のモデル・きっかけ・目安）を読み、範囲の外・知らないものは直す", async () => {
  const { parsePrepReply } = await import("./main-agent");
  const { parseMatchPlan, summarizeMatchPlan, matchPlanChoicesText } = await import("./match-plan");
  const r = parsePrepReply(
    '読んだ\n{"memo": "東へ", "model": "guardian", "triggers": {"enabled": {"heartbeat": false}, "thresholds": {"enemyNear": 99, "noTarget": 8}}, "guide": {"enemyNear": "離れる", "nope": "x"}}',
  );
  expect(r.memo).toBe("東へ");
  const plan = parseMatchPlan(r.json);
  expect(plan.model).toBe("guardian");
  expect(plan.triggers.enabled.heartbeat).toBe(false);
  expect(plan.triggers.thresholds.enemyNear).toBe(12); // 範囲 1〜12 に収める
  expect(plan.triggers.thresholds.noTarget).toBe(8);
  expect(plan.guide).toEqual({ enemyNear: "離れる" });
  expect(plan.notes.join()).toContain("敵が近い");
  expect(summarizeMatchPlan(plan)).toContain("使わない: 定期");
  expect(parseMatchPlan({ model: "nope" }).model).toBeNull();
  // JSON が無い返答は本文をメモにし、設定は既定
  expect(parsePrepReply("ただのメモ").json).toBeNull();
  expect(parseMatchPlan(null).triggers.enabled.enemyNear).toBe(true);
  // 準備に見せる選択肢: モデルの id ときっかけの範囲
  const text = matchPlanChoicesText();
  expect(text).toContain("`guardian`");
  expect(text).toContain("`enemyNear`");
  expect(text).toContain("範囲 1〜12");
});

test("きっかけで呼んだ時: きっかけ・準備の目安・モデルの手を見せ、返答でモデルを選べる（知らない id は使わない）", async () => {
  const { parseMainReply } = await import("./main-agent");
  const ids = ["standard", "hunter"];
  expect(parseMainReply('{"turn":3,"phase":"CMD1","action":"continue","model":"hunter"}', 3, "CMD1", [], ids)?.model).toBe("hunter");
  expect(parseMainReply('{"turn":3,"phase":"CMD1","action":"continue","model":"zzz"}', 3, "CMD1", [], ids)?.model).toBeUndefined();
  expect(parseMainReply('{"turn":3,"phase":"CMD1","action":"continue","model":"hunter"}', 3, "CMD1", [])?.model).toBeUndefined();

  Bun.env.AGENT_MATCH_TOKEN_LIMIT = "0";
  sent.length = 0;
  const { parseMatchPlan } = await import("./match-plan");
  const agent = new MainAgent({}, 5000);
  await agent.begin({ room: 1, stageName: null, webMap: false, highScore: 0 }, { memo: "m", usage: emptyUsage(), plan: parseMatchPlan({ guide: { enemyNear: "ガーディアンにして離れる" } }) });
  expect(agent.matchPlan.guide.enemyNear).toBe("ガーディアンにして離れる");
  const wm = new WorldMap();
  wm.applyObservation("CMD1", "gr", [2, 2, 2, 2, 1000, 2, 2, 2, 2], 1);
  const origAsk = proto.ask as (this: unknown, text: string) => Promise<AskResult>;
  proto.ask = async function (this: { options: ClaudeSessionOptions }, text: string): Promise<AskResult> {
    sent.push({ label: this.options.label ?? "", text, options: this.options });
    return { status: "ok", text: '{"turn": 2, "phase": "CMD1", "action": "continue", "model": "hunter"}', durationMs: 1 };
  };
  const res = await new Promise<MainDecision | null>((resolve) => {
    agent.startBackground(
      {
        ...ctxOf(wm, 2, "CMD1"),
        triggers: [{ id: "enemyNear", label: "敵が近い", phase: "CMD1", value: 2, detail: "P2 が 2 マス" }],
        models: { active: "standard", list: [{ id: "standard", name: "バランス", trait: "標準" }, { id: "hunter", name: "ハンター", trait: "攻撃型" }], votes: { standard: "wr", hunter: "pr" } },
      },
      (r) => resolve(r),
    );
  });
  const msg = sent.find((x) => x.label === "main")!.text;
  expect(msg).toContain("## 呼んだきっかけ");
  expect(msg).toContain("敵が近い（CMD1）: P2 が 2 マス ／ 準備で決めた目安: ガーディアンにして離れる");
  expect(msg).toContain("今のモデル: standard（バランス）");
  expect(msg).toContain("バランス wr・ハンター pr");
  expect(res?.model).toBe("hunter");
  expect(res?.note).toContain("モデルを ハンター へ");
  proto.ask = origAsk;
  await agent.end();
  delete Bun.env.AGENT_MATCH_TOKEN_LIMIT;
});
