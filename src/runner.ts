import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { EVALUATOR_PATH, RUNS_DIR } from "./paths";
import { Client, fetchLatestResult, type OfficialResult } from "./client";
import { isResultForRun } from "./client/result";
import type { AgentConfig } from "./config";
import { analyzeMatchRun, type DiagnosticReport } from "./evolution/analyzer";
import type { AgentUsageReport, MainAgent } from "./agent/main-agent";
import { evaluateBreakpoint } from "./agent/turn-events";
import { getRoomProfile, isWarpTile, knownTotalTurns, recordMeasuredTileScores, recordRoomWarp, reloadTilesKnowledge, saveRoomProfile } from "./memory/knowledge-store";
import { type MeasureResult, measureTileScores, type ScoreSample } from "./memory/tile-measure";
import { WorldMap, type WebAlignInfo } from "./memory/world-map";
import { totalTurnsFromWeb, WebMapRefresher } from "./perception/web-map-refresher";
import { GameOver, logger } from "./tools";
import { boolSetting, getSetting, numSetting } from "./settings";
import { saveRealMap } from "./sim/mapgen";
import * as defaultEvaluator from "./solver/evaluator";
import type { EvaluatorModule } from "./solver/planner";
import { type FiredTrigger, loadAllModels, TriggerMonitor, votersFrom } from "./agent/triggers";
import { summarizeMatchPlan } from "./agent/match-plan";
import { formatActionLine } from "./agent/action-log";
import { type LlmReply, renderTriggerReview, reviewRun } from "./agent/trigger-review";
import { getStyle, loadModelParams, playModelId } from "./solver/models";
import { makePlannerPolicy, type PolicyFn } from "./solver/policy";
import { TRIGGER_DEFS } from "./agent/triggers";
import type { AgentPlan, SolverDecision } from "./solver/types";
import { type UiPredictionState, uiBus } from "./ui/event-bus";

export interface TurnRecord {
  turn: number;
  cmd1: string | null;
  cmd1Reason: string | null;
  cmd1Values: number[] | null;
  cmd2: string | null;
  cmd2Reason: string | null;
  cmd2Values: number[] | null;
  usedFallback: boolean;
  /** メインエージェントがこのターンの手を決めたか */
  usedHarness: boolean;
  cmd1Source: "main" | "solver" | null;
  cmd2Source: "main" | "solver" | null;
  mainLatencyMs: number[];
  /** ソルバー手を採用した理由（時間切れ・多忙など）。main が決めたフェーズは含まない */
  solverFallbackNotes: string[];
  /** メインの返答種別 (例: "CMD1:continue", "CMD2:plan(followed)")。括弧は作戦目標に対して送った手が followed=向かう / no_route=経路なし / other=別の手 */
  mainActions: string[];
  /** このターンに LLM が使ったトークン */
  agentTokens?: number;
  /** このターン最後のメイン問い合わせ1回の入力トークン（キャッシュ込み） */
  mainInputTokens?: number | null;
  breakpointReasons: string[];
  /** 試合中の LLM を呼ぶきっかけで、このターンに鳴ったもの（src/agent/triggers.ts） */
  triggers?: FiredTrigger[];
  /** 特性ごとのモデルの手（試合で使うモデルと違う手を出したモデルがあった時だけ） */
  modelVotes?: Partial<Record<"CMD1" | "CMD2", Record<string, string>>>;
  /** このターンに試合中の LLM を呼んだきっかけ（フェーズごと。毎回呼ぶ設定では空の配列） */
  calledBy?: Partial<Record<"CMD1" | "CMD2", string[]>>;
  /** このターンの終わりに使っていたモデル（試合中に切り替えた時だけ） */
  model?: string;
  /** このターンの間に届いた試合中の LLM の返答（聞いたターン・きっかけ・目標・モデル。返答なしは action null） */
  llmReplies?: LlmReply[];
  /** 最後に取れた Webマップの `turn=` とその時のハーネスのターン（Webマップのターン表示の意味を確かめるため） */
  webMapTurn?: { ourTurn: number; webTurn: number | null } | null;
  /** このターンに踏んだタイル（番号 → 回数）。タイルの得点の実測に使う */
  landed?: Record<string, number>;
  /** このターンの間に届いた Webマップの公式のアイテム得点（届いた時だけ） */
  webScore?: ScoreSample;
  /** ワープを踏んだ直後に Webマップでの位置合わせを待った時間（aligned=false なら間に合わなかった） */
  warpWaits?: { phase: string; ms: number; aligned: boolean }[];
  /** このターンの間の Webマップでの位置合わせ（あった時だけ。corrected があれば、それまでの位置合わせがずれていた） */
  webAlign?: WebAlignInfo;
  positionAfter: [number, number];
  globalPositionAfter: [number, number] | null;
  estimatedScoreAfter: number;
  gameOver: boolean;
  gameOverReason: string | null;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  startedAt: string;
  finishedAt: string;
  room: number;
  model: string | null;
  /** 手を出した方策のモデル（knowledge/styles.json の id。設定 POLICY_MODEL） */
  policyModel?: string;
  /** 試合中の LLM を呼ぶきっかけの集計（鳴った回数・条件を満たした回数・比べたモデルの数・しきい値） */
  triggers?: ReturnType<TriggerMonitor["summary"]>;
  /** 試合中の LLM を呼んだ時（trigger = きっかけが鳴った時だけ / every = 毎回）。LLM なしは null */
  callMode?: "trigger" | "every" | null;
  /** 準備の LLM が決めた試合の設定（最初のモデル・きっかけ・判断の目安） */
  matchPlan?: { model: string | null; triggers: unknown; guide: Record<string, string>; notes: string[] } | null;
  /** 試合中に LLM がモデルを切り替えた記録 */
  modelSwitches?: { turn: number; phase: string; from: string; to: string; by: string[] }[];
  /** 試合の終わりに使っていたモデル */
  finalModel?: string;
  webMapDetected: boolean;
  webMapUrl: string | null;
  turns: number;
  gameOverReason: string | null;
  estimatedScore: ReturnType<WorldMap["getStats"]>;
  officialResult: OfficialResult | null;
  tilePickups: Record<string, number>;
  /** Webマップの公式のアイテム得点から測ったタイルの得点（src/memory/tile-measure.ts） */
  tileMeasurement?: MeasureResult;
  commandCounts: Record<string, number>;
  holeRevisits: number;
  hazardHits: number;
  fallbackTurns: number;
  harnessTurns: number;
  /** メインエージェントの設定と成績 */
  agent: {
    enabled: boolean;
    model: string | null;
    effort: string | null;
    turnBudgetSec: number;
    mainDecisionRate: number | null;
    avgLatencyMs: number | null;
    maxLatencyMs: number | null;
    /** 試合終了時点の使用量（振り返りは含まない） */
    usage?: AgentUsageReport;
  };
  /** 試合後の進化結果（evolve.ts が追記） */
  evolution?: {
    /** 改修した評価関数が試合の記録での確かめに通ったか（改修していなければ true） */
    replayVerified: boolean;
    /** 改修した評価関数を元に戻したか */
    rolledBack: boolean;
    /** 評価関数（src/solver/evaluator.ts）を改修したか・確かめて採用したか */
    evaluatorChanged?: boolean;
    evaluatorAccepted?: boolean;
  };
  unknownTiles: number[];
  diagnosis?: DiagnosticReport;
}

function makeRunId(room: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}_room${room}`;
}

/** 評価関数（エージェントが試合後に改修する）を試合開始時に読み込む。読めなければ同梱の版 */
let evaluatorCache: { mtimeMs: number; mod: EvaluatorModule } | null = null;
async function loadEvaluator(): Promise<EvaluatorModule> {
  try {
    const mtimeMs = statSync(EVALUATOR_PATH).mtimeMs;
    if (evaluatorCache && evaluatorCache.mtimeMs === mtimeMs) return evaluatorCache.mod;
    const mod = (await import(`${EVALUATOR_PATH}?t=${mtimeMs}`)) as EvaluatorModule;
    if (typeof mod.stepCost === "function" && typeof mod.targetValue === "function") {
      evaluatorCache = { mtimeMs, mod };
      return mod;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "evaluator.ts の読み込みに失敗。同梱の版で続ける");
    uiBus.pushClaudeEvent({ context: "system", kind: "error", title: "評価関数の読み込みに失敗", content: msg });
  }
  return defaultEvaluator;
}

function syncUiPredictionAndMap(
  worldMap: WorldMap,
  turn: number,
  phase: "CMD1" | "CMD2",
  decision: SolverDecision,
  source: "solver" | "main" | "fallback",
  breakpointReasons: string[],
  agentInfo: Partial<Pick<UiPredictionState, "mainAction" | "mainNote" | "mainLatencyMs" | "plan" | "triggers">> = {},
): void {
  const evalSummary = worldMap.evaluateCandidates(phase);
  uiBus.updatePrediction({
    turn,
    phase,
    command: decision.command,
    reason: decision.reason,
    confidence: decision.confidence,
    source,
    breakpointReasons,
    topTargets: evalSummary.topValueTargets,
    nearestFrontiers: evalSummary.nearestFrontiers,
    candidates: evalSummary.candidates,
    ...agentInfo,
  });
  uiBus.updateMap(worldMap.buildUiMapState(decision.command, agentInfo.plan?.target ?? null));
}

export async function runAgentMatch(
  client: Client,
  config: AgentConfig,
  matchIndex = 1,
  mainAgent: MainAgent | null = null,
): Promise<RunSummary> {
  const runId = makeRunId(config.room);
  const runDir = path.join(RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  uiBus.clearMatchLogs(config.room, matchIndex, runId);

  const startedAt = new Date().toISOString();
  // 試合中に WebUI で設定を変えても、この試合の記録は開始時の設定で残す（変更は次の試合から）
  const agentSettings = {
    model: config.model ?? null,
    effort: config.effort ?? null,
    turnBudgetSec: config.turnBudgetSec,
  };
  const worldMap = new WorldMap();
  // 過去の試合で記録したワープ（絶対座標）。Webマップで位置合わせできたら、方策が行き先の分かっているワープを道として使う
  worldMap.setKnownGlobalWarps((getRoomProfile(config.room).warps ?? []).filter((w) => isWarpTile(w.tile)));
  const roomProfileBefore = getRoomProfile(config.room);
  /** 1試合の全ターン数（過去の公式結果、なければ Webマップの残りターンから分かった時に入る） */
  let totalTurns: number | null = roomProfileBefore.totalTurns ?? knownTotalTurns(config.room);
  /** 記録済みのワープ（worldMap.getWarpLinks() の番号） */
  const recordedWarps = new Set<number>();
  /** turns.jsonl に書いた最後の Webマップの得点（同じものを二度書かない） */
  let recordedScore: ScoreSample | null = null;
  let recordedAlign: WebAlignInfo | null = null;

  // Web マップは裏で取得する。取れない間は自作マップ、途中で取れたら全体マップ表示に切り替わる
  let realMapSaved = false;
  const webMap = new WebMapRefresher(config.room, config.webMapUrl, worldMap, (r) => {
    if (r.liveScore) uiBus.updateScores({ liveOfficial: r.liveScore });
    // 最初に取れた全体マップを本物の地図としてシミュレータ用に残す（試合後の学習で使う）
    if (!realMapSaved && r.grid) {
      realMapSaved = true;
      try {
        saveRealMap(config.room, runId, r.grid, totalTurns);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "地図の保存に失敗");
      }
    }
    uiBus.updateMap(worldMap.buildUiMapState(null, mainAgent?.currentPlan?.target ?? null));
  });
  await webMap.start();

  uiBus.patchState({
    status: "playing",
    statusMessage: `Room ${config.room} (${webMap.stageName ?? "自作マップ"}) 対戦中`,
    webMapDetected: webMap.available,
  });
  uiBus.updateScores({
    estimatedTotal: 0,
    estimatedAction: 0,
    estimatedItem: 0,
    liveOfficial: null,
    roomHighScore: roomProfileBefore.highScore,
    holeRevisits: 0,
    hazardHits: 0,
  });
  uiBus.updateMap(worldMap.buildUiMapState(null));

  // 方策（経路探索 ＋ 評価関数 ＋ 学習したパラメータ）は試合開始時に1回だけ読み込む（試合中にファイルが変わっても、この試合は同じもので通す）
  // 特性ごとのモデルは全部読み込んでおき、試合中の LLM が切り替えられる。最初のモデルは準備の LLM が選ぶ（無ければ POLICY_MODEL）
  const matchPlan = mainAgent?.matchPlan ?? null;
  const evaluator = await loadEvaluator();
  const models = loadAllModels(evaluator);
  const settingModel = playModelId();
  const policyModel = matchPlan?.model && models.some((m) => m.id === matchPlan.model) ? matchPlan.model : settingModel;
  const matchParams = loadModelParams(policyModel);
  let activeModel = policyModel;
  const modelNames = Object.fromEntries(models.map((m) => [m.id, m.name]));
  const modelNameOf = (id: string) => modelNames[id] ?? id;
  let planner: PolicyFn = models.find((m) => m.id === policyModel)?.policy ?? makePlannerPolicy(matchParams, evaluator);
  const modelSwitches: { turn: number; phase: string; from: string; to: string; by: string[] }[] = [];
  const switchModel = (to: string, turn: number, phase: string, by: string[]) => {
    const m = models.find((x) => x.id === to);
    if (!m || to === activeModel) return;
    modelSwitches.push({ turn, phase, from: activeModel, to, by });
    activeModel = to;
    planner = m.policy;
    triggerMonitor.setVoters(votersFrom(models, to));
    uiBus.patchState({ matchModel: { id: to, name: m.name, callMode: mainAgent ? callMode : null, switches: modelSwitches.length, names: modelNames } });
  };
  // 試合中の LLM を呼ぶきっかけ（準備の LLM が選んだ設定）。ほかの特性のモデルにも同じ盤面で手を出させて比べる
  const triggerMonitor = new TriggerMonitor(votersFrom(models, policyModel), matchPlan?.triggers);
  /** trigger = きっかけが鳴った時だけ LLM を呼ぶ / every = 毎回（前の動き） */
  const callMode = getSetting("AGENT_CALL_MODE") === "every" ? "every" : "trigger";
  const pendingLabel = (ids: string[]) => ids.map((id) => TRIGGER_DEFS.find((d) => d.id === id)?.label ?? id).join("・");
  /** 鳴ったが、LLM が考え中でまだ渡せていないきっかけ（次に呼ぶ時にまとめて渡す。同じきっかけは新しい方） */
  let pendingTriggers: FiredTrigger[] = [];
  /** 持ち越したきっかけが鳴ったターン（古くなったものは渡さない。知らないタイル・終盤は残す） */
  const pendingAt = new Map<string, number>();
  const PENDING_KEEP_TURNS = 5;
  const dropStalePending = (turn: number) => {
    pendingTriggers = pendingTriggers.filter((f) => f.id === "unknownTile" || f.id === "endgame" || turn - (pendingAt.get(f.id) ?? turn) <= PENDING_KEEP_TURNS);
  };
  uiBus.patchState({ matchModel: { id: policyModel, name: getStyle(policyModel).name, callMode: mainAgent ? callMode : null, switches: 0, names: modelNames } });
  if (mainAgent && matchPlan) {
    uiBus.pushClaudeEvent({
      context: "in_game",
      kind: "system",
      title: "試合の設定（準備）",
      content: `${summarizeMatchPlan(matchPlan)}${policyModel !== settingModel ? `（設定は ${getStyle(settingModel).name}）` : ""} / LLM を呼ぶ時: ${callMode === "trigger" ? "きっかけが鳴った時だけ" : "毎回"}${matchPlan.notes.length ? ` / 直したこと: ${matchPlan.notes.join("; ")}` : ""}`,
    });
  }
  /** 前のターンの終わりに鳴ったきっかけ（次のフェーズの画面に出す） */
  let turnEndFired: FiredTrigger[] = [];
  /** 方策が例外を投げても試合は止めない（安全な手にして続ける。UI には最初の1回と以後100回ごとに知らせる） */
  let solverErrors = 0;
  const decideSolver = (wm: WorldMap, phase: "CMD1" | "CMD2", turn: number, plan: AgentPlan | null): SolverDecision => {
    try {
      return planner(wm, phase, turn, { totalTurns, directive: plan ? { target: plan.target, note: plan.note } : null });
    } catch (err) {
      solverErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ turn, phase, err: msg, count: solverErrors }, "ソルバーが例外を投げた（安全な手で続ける）");
      if (solverErrors === 1 || solverErrors % 100 === 0) {
        uiBus.pushClaudeEvent({ context: "system", kind: "error", title: "ソルバーの例外", content: `T${turn} ${phase}: ${msg}（${solverErrors}回目。安全な手で続けている）` });
      }
      return { command: wm.pickSafeFallback(phase) as SolverDecision["command"], reason: `solver error: ${msg.slice(0, 120)}`, confidence: 0 };
    }
  };
  const turnLogs: TurnRecord[] = [];
  /** LLM（裏で作戦を考える）: 届いた返答（次に書くターンの記録に入れる） */
  const asyncMainActions: string[] = [];
  const asyncMainLatency: number[] = [];
  /** 届いた返答（構造化。試合後のきっかけの評価に使う） */
  const asyncReplies: LlmReply[] = [];
  const commandCounts: Record<string, number> = {};
  let gameOverReason: string | null = null;

  const incCommand = (cmd: string | null) => {
    if (!cmd) return;
    commandCounts[cmd] = (commandCounts[cmd] ?? 0) + 1;
  };

  try {
    for (let turn = 1; ; turn++) {
      if (uiBus.getState().stopRequested) {
        gameOverReason = "Stopped by user from WebUI";
        break;
      }
      if (config.maxTurns !== null && turn > config.maxTurns) {
        gameOverReason = `Reached --max-turns (${config.maxTurns})`;
        break;
      }
      if (client.getStatus.game.phase === "GAME_OVER") {
        gameOverReason = "Phase is GAME_OVER";
        break;
      }
      webMap.onTurnStart(turn);
      const pickupsBefore = worldMap.getStats().pickups;
      // Webマップの残りターン数から全ターン数が分かれば、メインの「残り」をそれに合わせる（初めてのルームでも分かる）
      const webTotal = totalTurnsFromWeb(webMap.lastTurn);
      if (webTotal !== null) {
        mainAgent?.setTotalTurns(webTotal);
        totalTurns = webTotal;
      }

      let cmd1: string | null = null;
      let cmd1Reason: string | null = null;
      let cmd1Values: number[] | null = null;
      let cmd2: string | null = null;
      let cmd2Reason: string | null = null;
      let cmd2Values: number[] | null = null;
      let turnCompleted = false;
      let gameOver = false;
      let turnGameOverReason: string | null = null;
      let usedFallback = false;
      let usedHarness = false;
      let cmd1Source: "main" | "solver" | null = null;
      let cmd2Source: "main" | "solver" | null = null;
      const mainLatencyMs: number[] = [];
      const solverFallbackNotes: string[] = [];
      const mainActions: string[] = [];
      const tokensAtTurnStart = mainAgent?.usage().totalTokens ?? 0;
      const breakpointReasons: string[] = [];
      const warpWaits: { phase: string; ms: number; aligned: boolean }[] = [];
      const firedThisTurn: FiredTrigger[] = [];
      /** このターンに LLM を呼んだきっかけ（フェーズごと） */
      const calledBy: Partial<Record<"CMD1" | "CMD2", string[]>> = {};
      const modelVotes: Partial<Record<"CMD1" | "CMD2", Record<string, string>>> = {};

      /** ソルバー候補 → メインエージェント判断 → 送信 → 観測反映 を1フェーズ分行う */
      const playPhase = async (phase: "CMD1" | "CMD2"): Promise<{ command: string; reason: string; values: number[] | null; source: "main" | "solver" }> => {
        uiBus.patchState({ turn, phase: phase === "CMD1" ? "READY_CMD1" : "READY_CMD2" });
        const solverDecision: SolverDecision =
          decideSolver(worldMap, phase, turn, mainAgent?.currentPlan ?? null);
        const events = evaluateBreakpoint({ turn, worldMap, solverDecision }).reasons;
        for (const r of events) if (!breakpointReasons.includes(r)) breakpointReasons.push(r);
        // きっかけ: LLM の目標なしの方策の手と、ほかのモデルの手・観測から（例外は試合に響かせない）
        let uiTriggers: { id: string; label: string; detail: string }[] = [];
        let lastVotes: Record<string, string> | null = null;
        try {
          const play = mainAgent?.currentPlan ? planner(worldMap, phase, turn, { totalTurns, directive: null }) : solverDecision;
          const tr = triggerMonitor.phase({ wm: worldMap, phase, turn, totalTurns, play });
          firedThisTurn.push(...tr.fired);
          if (tr.votes) modelVotes[phase] = { [activeModel]: play.command, ...tr.votes };
          const now = [...(phase === "CMD1" ? turnEndFired : []), ...tr.fired];
          uiTriggers = now.map((f) => ({ id: f.id, label: f.label ?? f.id, detail: f.detail }));
          for (const f of now) {
            pendingTriggers = [...pendingTriggers.filter((p) => p.id !== f.id), f];
            pendingAt.set(f.id, turn);
          }
          dropStalePending(turn);
          lastVotes = tr.votes ? { [activeModel]: play.command, ...tr.votes } : null;
        } catch (err) {
          logger.warn({ turn, phase, err: err instanceof Error ? err.message : String(err) }, "きっかけを計算できなかった");
        }
        syncUiPredictionAndMap(worldMap, turn, phase, solverDecision, "solver", events, { triggers: uiTriggers });

        let decision = solverDecision;
        let source: "main" | "solver" = "solver";
        if (mainAgent) {
          // LLM は待たない。座標系の変化・目標への到達を反映してから今の作戦で手を決め直し、LLM が空いていれば裏で聞く
          mainAgent.syncFrame(worldMap);
          decision = decideSolver(worldMap, phase, turn, mainAgent.currentPlan);
          const askedAt = `T${turn} ${phase}`;
          // trigger: 鳴ったきっかけがある時だけ呼ぶ（考え中なら次に持ち越す）。every: 空いていれば毎回
          const callNow = !mainAgent.thinking && (callMode === "every" || pendingTriggers.length > 0);
          const by = pendingTriggers.map((f) => f.id);
          const started = callNow && mainAgent.startBackground(
            {
              turn,
              phase,
              worldMap,
              events,
              solve: (plan) => decideSolver(worldMap, phase, turn, plan),
              triggers: pendingTriggers,
              models: { active: activeModel, list: models.map((m) => ({ id: m.id, name: m.name, trait: getStyle(m.id).trait })), votes: lastVotes },
            },
            (res, error) => {
              if (!res) {
                asyncMainActions.push(`${askedAt}:error(${(error ?? "").slice(0, 60)})`);
                asyncReplies.push({ asked: turn, phase, by, action: null });
                return;
              }
              if (res.model) switchModel(res.model, turn, phase, by);
              asyncReplies.push({
                asked: turn,
                phase,
                by,
                action: res.source === "main" ? res.action : null,
                ...(res.model ? { model: res.model } : {}),
                ...(res.action === "plan" && mainAgent.currentPlan ? { target: mainAgent.currentPlan.target } : {}),
                ms: res.durationMs,
              });
              asyncMainActions.push(`${askedAt}${by.length ? `[${by.join(",")}]` : ""}:${res.source === "main" ? res.action : `solver(${res.note})`}${res.planStatus ? `(${res.planStatus})` : ""}${res.model ? `(model→${res.model})` : ""}`);
              if (res.durationMs !== null) asyncMainLatency.push(res.durationMs);
              reloadTilesKnowledge();
              uiBus.pushClaudeEvent({
                context: "in_game",
                kind: "system",
                title: `メインの返答（${askedAt} に聞いた分）`,
                content: `${res.source === "main" ? res.action : "返答なし"}: ${res.note}${mainAgent.currentPlan ? ` / 作戦目標 (${mainAgent.currentPlan.target.join(",")})` : ""}`,
              });
            },
          );
          if (started) {
            calledBy[phase] = by;
            pendingTriggers = [];
          }
          syncUiPredictionAndMap(worldMap, turn, phase, decision, "solver", events, {
            mainAction: started ? "thinking" : mainAgent.thinking ? "thinking" : null,
            mainNote: started
              ? `${askedAt} の盤面で考え始めた${by.length ? `（きっかけ: ${pendingLabel(by)}）` : ""}`
              : mainAgent.thinking
                ? "考え中（前の問い合わせ）"
                : "待機（きっかけが鳴ったら呼ぶ）",
            mainLatencyMs: null,
            plan: mainAgent.currentPlan,
            triggers: uiTriggers,
          });
        }

        const r = phase === "CMD1" ? await client.command1(decision.command) : await client.command2(decision.command);
        worldMap.applyObservation(phase, decision.command, r.values, turn);
        // 観測直後にもマップを更新（次の判断を待たずに画面へ反映）
        uiBus.updateMap(worldMap.buildUiMapState(null, mainAgent?.currentPlan?.target ?? null));
        // ワープ直後は位置合わせのためすぐ取り直す（裏で実行）
        if (worldMap.getLastEventFlags().warped) webMap.onWarp(turn);
        // ワープを踏んだ直後は着地先のまわりが分からない。次の手を古い地図で選ばないよう、Webマップでの位置合わせを少し待つ
        if (worldMap.getLastEventFlags().warpPending && webMap.available) {
          const waitSec = numSetting("CHASER_WARP_ALIGN_WAIT_SEC", { min: 0 });
          if (waitSec > 0) {
            const t0 = Date.now();
            const ok = await webMap.waitForAlignment(waitSec * 1000);
            warpWaits.push({ phase, ms: Date.now() - t0, aligned: ok });
          }
        }
        return { command: decision.command, reason: decision.reason, values: r.values, source };
      };

      try {
        const p1 = await playPhase("CMD1");
        cmd1 = p1.command;
        cmd1Reason = p1.reason;
        cmd1Values = p1.values;
        cmd1Source = p1.source;

        if (client.getStatus.game.phase === "READY_CMD2") {
          const p2 = await playPhase("CMD2");
          cmd2 = p2.command;
          cmd2Reason = p2.reason;
          cmd2Values = p2.values;
          cmd2Source = p2.source;
          // ターン終了と並行して Web マップを取り直し、盤面（敵の位置を含む）を毎ターン最新にする
          await client.command3("#");
          turnCompleted = true;
        }
      } catch (err) {
        if (err instanceof GameOver) {
          gameOver = true;
          turnGameOverReason = err.message;
          turnCompleted = true;
        } else if (client.aborted) {
          throw err; // 停止ボタン
        } else if (err instanceof Error && /応答しない|Timeout waiting for|Stopped while waiting/.test(err.message)) {
          // 応答の時間切れはサーバが受け付けていた可能性があり、送り直すと応答と手がずれる。他プレイヤー待ちの上限切れも送り直さない
          throw err;
        } else {
          // 通信の一時的な失敗など。下の耐障害フォールバックで、まだ送っていないフェーズを安全な手で送り直す
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ turn, err: msg, phase: client.getStatus.game.phase }, "ターンの途中で例外。安全な手で送り直す");
          solverFallbackNotes.push(`error: ${msg.slice(0, 120)}`);
        }
      }
      usedHarness = cmd1Source === "main" || cmd2Source === "main";

      // 耐障害フォールバック
      if (!turnCompleted && !gameOver) {
        usedFallback = true;
        try {
          if (client.getStatus.game.phase === "READY_CMD1") {
            const fb1 = worldMap.pickSafeFallback("CMD1");
            const r1 = await client.command1(fb1);
            worldMap.applyObservation("CMD1", fb1, r1.values, turn);
            cmd1 = fb1;
            cmd1Reason = "fallback";
            cmd1Values = r1.values;
          }
          if (client.getStatus.game.phase === "READY_CMD2") {
            const fb2 = worldMap.pickSafeFallback("CMD2");
            const r2 = await client.command2(fb2);
            worldMap.applyObservation("CMD2", fb2, r2.values, turn);
            cmd2 = fb2;
            cmd2Reason = "fallback";
            cmd2Values = r2.values;
          }
          if (client.getStatus.game.phase === "READY_CMD3") {
            await client.command3("#");
            turnCompleted = true;
          }
        } catch (fbErr) {
          if (fbErr instanceof GameOver) {
            gameOver = true;
            turnGameOverReason = fbErr.message;
            turnCompleted = true;
          } else {
            throw fbErr;
          }
        }
      }

      incCommand(cmd1);
      incCommand(cmd2);

      const curStats = worldMap.getStats();
      const landed: Record<string, number> = {};
      for (const [v, c] of Object.entries(curStats.pickups)) if (c > (pickupsBefore[v] ?? 0)) landed[v] = c - (pickupsBefore[v] ?? 0);
      const newScore: ScoreSample | null = webMap.lastScore && webMap.lastScore !== recordedScore ? webMap.lastScore : null;
      if (newScore) recordedScore = newScore;
      const align = worldMap.getLastAlign();
      const newAlign: WebAlignInfo | null = align && align !== recordedAlign ? align : null;
      if (newAlign) {
        recordedAlign = newAlign;
        if (newAlign.corrected) {
          logger.warn({ ...newAlign, turn }, "Webマップで位置合わせを直した（それまでずれていた）");
          uiBus.pushClaudeEvent({
            context: "system",
            kind: "system",
            title: "位置合わせを直した",
            content: `T${turn}: Webマップの自機の位置に合わせ直した（ずれ ${newAlign.corrected.to[0] - newAlign.corrected.from[0]},${newAlign.corrected.to[1] - newAlign.corrected.from[1]}）`,
          });
        }
      }
      try {
        turnEndFired = triggerMonitor.turnEnd({
          wm: worldMap,
          turn,
          totalTurns,
          web: webMap.lastScore,
          warpMisaligned: warpWaits.some((w) => !w.aligned),
          cmd2,
        });
        firedThisTurn.push(...turnEndFired);
      } catch (err) {
        turnEndFired = [];
        logger.warn({ turn, err: err instanceof Error ? err.message : String(err) }, "きっかけを計算できなかった");
      }
      const record: TurnRecord = {
        turn,
        cmd1,
        cmd1Reason,
        cmd1Values,
        cmd2,
        cmd2Reason,
        cmd2Values,
        usedFallback,
        usedHarness,
        cmd1Source,
        cmd2Source,
        mainLatencyMs: [...mainLatencyMs, ...asyncMainLatency.splice(0)],
        solverFallbackNotes,
        mainActions: [...mainActions, ...asyncMainActions.splice(0)],
        ...(asyncReplies.length > 0 ? { llmReplies: asyncReplies.splice(0) } : {}),
        ...(mainAgent
          ? { agentTokens: mainAgent.usage().totalTokens - tokensAtTurnStart, mainInputTokens: mainAgent.usage().lastCallInputTokens }
          : {}),
        breakpointReasons,
        ...(firedThisTurn.length > 0 ? { triggers: firedThisTurn } : {}),
        ...(Object.keys(modelVotes).length > 0 ? { modelVotes } : {}),
        ...(Object.keys(calledBy).length > 0 ? { calledBy } : {}),
        ...(activeModel !== policyModel || modelSwitches.length > 0 ? { model: activeModel } : {}),
        webMapTurn: webMap.lastTurn,
        landed,
        ...(newScore ? { webScore: newScore } : {}),
        ...(newAlign ? { webAlign: newAlign } : {}),
        ...(warpWaits.length > 0 ? { warpWaits } : {}),
        positionAfter: worldMap.getPosition(),
        globalPositionAfter: worldMap.getGlobalPosition(),
        estimatedScoreAfter: curStats.estimatedTotalScore,
        gameOver,
        gameOverReason: turnGameOverReason,
      };
      turnLogs.push(record);
      // ワープを絶対座標で記録する（Webマップで入口・着地の両方の位置が分かったものだけ。次の試合でも使う）
      for (const link of worldMap.getGlobalWarpLinks()) {
        if (recordedWarps.has(link.index)) continue;
        recordedWarps.add(link.index);
        // 入口がワープのタイルでないものは、ワープの誤検知か位置合わせのずれなので残さない
        if (!isWarpTile(link.tileValue)) continue;
        try {
          recordRoomWarp(config.room, link, runId);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ワープの記録に失敗");
        }
      }

      // WebUI に最新盤面・スコア・ターン記録を即時反映
      uiBus.updateScores({
        estimatedTotal: curStats.estimatedTotalScore,
        estimatedAction: curStats.estimatedActionScore,
        estimatedItem: curStats.estimatedItemScore,
        holeRevisits: curStats.holeRevisits,
        hazardHits: curStats.hazardHits,
      });
      uiBus.updateMap(worldMap.buildUiMapState(null, mainAgent?.currentPlan?.target ?? null));
      uiBus.pushTurnRecord(record);

      // 1行ずつ追記（毎ターン全件を書き直すと 1500 ターンで数百MBの書き込みになる）
      await appendFile(path.join(runDir, "turns.jsonl"), `${JSON.stringify(record)}\n`);
      // 行動ログ（人が読む1ターン1行）
      try {
        const prevEst = turnLogs.length >= 2 ? turnLogs[turnLogs.length - 2]!.estimatedScoreAfter : 0;
        await appendFile(path.join(runDir, "actions.log"), `${formatActionLine(record, prevEst, modelNameOf)}\n`);
      } catch {
        // 書けなくても試合は続ける
      }

      logger.info(
        {
          turn,
          cmd1: record.cmd1,
          cmd2: record.cmd2,
          pos: record.positionAfter,
          globalPos: record.globalPositionAfter,
          estScore: record.estimatedScoreAfter,
          claudeIntervened: record.usedHarness,
          fallback: record.usedFallback,
        },
        "Turn finished",
      );

      if (gameOver) {
        gameOverReason = turnGameOverReason ?? "Game Over";
        break;
      }
    }
  } catch (err) {
    gameOverReason = err instanceof Error ? err.message : String(err);
    if (!client.aborted) {
      logger.error({ err: gameOverReason, turns: turnLogs.length }, "試合がエラーで終わった");
      uiBus.pushClaudeEvent({ context: "system", kind: "error", title: "試合がエラーで終わった", content: `T${turnLogs.length + 1}: ${gameOverReason}` });
    }
  }

  const finishedAt = new Date().toISOString();
  const stats = worldMap.getStats();
  await webMap.drain();
  // LLM が考え中なら少し待つ（返答のメモを記録に残す）
  await mainAgent?.settleBackground(5000);
  // 試合の終わった後に届いた返答は、最後のターンの記録に入れる（きっかけの評価に数える。turns.jsonl は書き終えている）
  const lastLog = turnLogs[turnLogs.length - 1];
  if (lastLog && asyncReplies.length > 0) lastLog.llmReplies = [...(lastLog.llmReplies ?? []), ...asyncReplies.splice(0)];
  // 試合中に届いた公式のアイテム得点から、タイルの本当の得点を測って knowledge/tiles.json に残す（振り返りの前に）
  let tileMeasurement: MeasureResult | undefined;
  try {
    tileMeasurement = measureTileScores(turnLogs);
    if (tileMeasurement.tiles.length > 0) recordMeasuredTileScores(tileMeasurement.tiles, runId);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "タイルの得点の実測に失敗");
  }
  // 公式成績のページは最新の行を返す。この試合が記録されていなければ前の試合の成績なので、ターン数が合わなければ使わない
  const latestResult = await fetchLatestResult(config.room);
  const officialResult = latestResult && isResultForRun(latestResult, turnLogs.length, getRoomProfile(config.room).lastOfficialStartedAt) ? latestResult : null;
  if (latestResult && !officialResult) {
    logger.warn({ turns: turnLogs.length, resultTurns: latestResult.acquiredTurns, resultStartedAt: latestResult.startedAt }, "公式成績の取得ターン数がこの試合と合わない（前の対戦のもの）ので使わない");
  }
  const fallbackTurns = turnLogs.filter((r) => r.usedFallback).length;
  const harnessTurns = turnLogs.filter((r) => r.usedHarness).length;
  const phaseSources = turnLogs.flatMap((r) => [r.cmd1Source, r.cmd2Source]).filter((s) => s !== null);
  const latencies = turnLogs.flatMap((r) => r.mainLatencyMs);

  const summary: RunSummary = {
    runId,
    runDir,
    startedAt,
    finishedAt,
    room: config.room,
    model: agentSettings.model,
    policyModel,
    triggers: triggerMonitor.summary(turnLogs.length),
    callMode: mainAgent ? callMode : null,
    matchPlan: matchPlan ? { model: matchPlan.model, triggers: matchPlan.triggers, guide: matchPlan.guide, notes: matchPlan.notes } : null,
    modelSwitches,
    finalModel: activeModel,
    webMapDetected: webMap.available,
    webMapUrl: webMap.sourceUrl,
    turns: turnLogs.length,
    gameOverReason,
    estimatedScore: stats,
    officialResult,
    tilePickups: stats.pickups,
    ...(tileMeasurement ? { tileMeasurement } : {}),
    commandCounts,
    holeRevisits: stats.holeRevisits,
    hazardHits: stats.hazardHits,
    fallbackTurns,
    harnessTurns,
    agent: {
      enabled: mainAgent !== null,
      ...agentSettings,
      mainDecisionRate: phaseSources.length > 0 ? phaseSources.filter((s) => s === "main").length / phaseSources.length : null,
      avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
      ...(mainAgent ? { usage: mainAgent.usage(), finalMemo: mainAgent.currentMemo } : {}),
    },
    unknownTiles: stats.unknownTiles,
  };

  const diagnosis = analyzeMatchRun(summary, turnLogs, officialResult);
  // きっかけの評価（次の準備が読む）。診断の最後にも付ける（試合後の振り返り・画面）
  try {
    const review = reviewRun(turnLogs, summary as unknown as Record<string, unknown>);
    await Bun.write(path.join(runDir, "trigger-review.json"), JSON.stringify(review, null, 2));
    diagnosis.markdownReport = `${diagnosis.markdownReport.trimEnd()}\n\n${renderTriggerReview(review)}\n`;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "きっかけの評価を作れなかった");
  }
  summary.diagnosis = diagnosis;

  const updatedProfile = getRoomProfile(config.room);
  uiBus.updateScores({
    lastOfficialTotal: officialResult?.totalScore ?? null,
    roomHighScore: updatedProfile.highScore,
  });
  uiBus.patchState({
    diagnosisMarkdown: diagnosis.markdownReport,
  });

  await Bun.write(path.join(runDir, "final-map.txt"), worldMap.renderAscii(15));
  await Bun.write(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  await Bun.write(path.join(runDir, "diagnosis.md"), diagnosis.markdownReport);
  mainAgent?.archiveFiles(runDir);
  // 公式結果が取れなかった時は、Webマップの残りターン数から求めた全ターン数を残す
  const webTotalTurns = totalTurnsFromWeb(webMap.lastTurn);
  if (!officialResult && webTotalTurns !== null && !updatedProfile.totalTurns) {
    updatedProfile.totalTurns = webTotalTurns;
    saveRoomProfile(updatedProfile);
  }

  // この試合で使った方策（試合後の改修・学習の前）を残す。verify で改修前と比べる時や、強かった試合の方策を見る時に使う
  try {
    if (existsSync(EVALUATOR_PATH)) copyFileSync(EVALUATOR_PATH, path.join(runDir, "evaluator-snapshot.ts"));
    writeFileSync(path.join(runDir, "policy-params.json"), `${JSON.stringify({ version: 1, model: policyModel, params: matchParams, updatedAt: new Date().toISOString(), source: "match" }, null, 2)}\n`);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "方策の控えを残せなかった");
  }

  return summary;
}
