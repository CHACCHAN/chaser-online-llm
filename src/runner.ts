import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { BEST_SOLVERS_DIR, RUNS_DIR, SOLVER_PATH } from "./paths";
import { Client, fetchLatestResult, type OfficialResult } from "./client";
import type { AgentConfig } from "./config";
import { analyzeMatchRun, type DiagnosticReport } from "./evolution/analyzer";
import type { AgentUsageReport, MainAgent } from "./agent/main-agent";
import { evaluateBreakpoint } from "./agent/turn-events";
import { getRoomProfile, recordRoomWarp, reloadTilesKnowledge, saveRoomProfile } from "./memory/knowledge-store";
import { WorldMap } from "./memory/world-map";
import { WebMapRefresher } from "./perception/web-map-refresher";
import { GameOver, logger } from "./tools";
import { decideTurnAction as defaultDecideTurnAction, type SolverDecision } from "./solver/active-solver";
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
  /** メインの返答種別 (例: "CMD1:continue", "CMD2:plan") */
  mainActions: string[];
  /** サブへ依頼した仕事 */
  delegations: string[];
  /** このターンにエージェント全体（メイン・サブ）が使ったトークン */
  agentTokens?: number;
  /** このターン最後のメイン問い合わせ1回の入力トークン（キャッシュ込み） */
  mainInputTokens?: number | null;
  breakpointReasons: string[];
  /** 最後に取れた Webマップの `turn=` とその時のハーネスのターン（Webマップのターン表示の意味を確かめるため） */
  webMapTurn?: { ourTurn: number; webTurn: number | null } | null;
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
  webMapDetected: boolean;
  webMapUrl: string | null;
  turns: number;
  gameOverReason: string | null;
  estimatedScore: ReturnType<WorldMap["getStats"]>;
  officialResult: OfficialResult | null;
  tilePickups: Record<string, number>;
  commandCounts: Record<string, number>;
  holeRevisits: number;
  hazardHits: number;
  fallbackTurns: number;
  harnessTurns: number;
  /** メインエージェントの設定と成績 */
  agent: {
    enabled: boolean;
    model: string | null;
    subModel: string | null;
    effort: string | null;
    subEffort: string | null;
    turnBudgetSec: number;
    mainDecisionRate: number | null;
    avgLatencyMs: number | null;
    maxLatencyMs: number | null;
    /** 試合終了時点の使用量（振り返りは含まない） */
    usage?: AgentUsageReport;
  };
  /** 試合後の進化結果（evolve.ts が追記） */
  evolution?: { solverChanged: boolean; replayVerified: boolean; rolledBack: boolean };
  unknownTiles: number[];
  diagnosis?: DiagnosticReport;
}

function makeRunId(room: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}_room${room}`;
}

/** 読み込み済みのソルバー（ファイルの更新時刻が変わった時だけ読み直す。同じものを何度も読み込むとモジュールが溜まり続ける） */
let solverCache: { mtimeMs: number; fn: typeof defaultDecideTurnAction } | null = null;

async function loadActiveSolver(): Promise<typeof defaultDecideTurnAction> {
  const solverPath = SOLVER_PATH;
  try {
    const mtimeMs = statSync(solverPath).mtimeMs;
    if (solverCache && solverCache.mtimeMs === mtimeMs) return solverCache.fn;
    const mod = (await import(`${solverPath}?t=${mtimeMs}`)) as {
      decideTurnAction?: typeof defaultDecideTurnAction;
    };
    if (typeof mod.decideTurnAction === "function") {
      solverCache = { mtimeMs, fn: mod.decideTurnAction };
      return mod.decideTurnAction;
    }
  } catch (err) {
    // 改修失敗に気づけるよう握りつぶさない（試合は静的 import 版で継続）
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "active-solver.ts の読み込みに失敗。静的 import 版で継続");
    uiBus.pushClaudeEvent({ context: "system", kind: "error", title: "Solver Load Failed", content: msg });
  }
  return defaultDecideTurnAction;
}

function syncUiPredictionAndMap(
  worldMap: WorldMap,
  turn: number,
  phase: "CMD1" | "CMD2",
  decision: SolverDecision,
  source: "solver" | "main" | "fallback",
  breakpointReasons: string[],
  agentInfo: Partial<Pick<UiPredictionState, "mainAction" | "mainNote" | "mainLatencyMs" | "plan" | "delegated">> = {},
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
    subModel: config.subModel ?? null,
    effort: config.effort ?? null,
    subEffort: config.subEffort ?? null,
    turnBudgetSec: config.turnBudgetSec,
  };
  const worldMap = new WorldMap();
  const roomProfileBefore = getRoomProfile(config.room);
  /** 記録済みのワープ（worldMap.getWarpLinks() の番号） */
  const recordedWarps = new Set<number>();

  // Web マップは裏で取得する。取れない間は自作マップ、途中で取れたら全体マップ表示に切り替わる
  const webMap = new WebMapRefresher(config.room, config.webMapUrl, worldMap, (r) => {
    if (r.liveScore) uiBus.updateScores({ liveOfficial: r.liveScore });
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

  // ソルバーは試合開始時に1回だけ読み込む（試合中にファイルが変わっても、この試合は同じソルバーで通す）
  const decideSolver = await loadActiveSolver();
  const turnLogs: TurnRecord[] = [];
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
      const delegations: string[] = [];
      const tokensAtTurnStart = mainAgent?.usage().totalTokens ?? 0;
      const breakpointReasons: string[] = [];

      /** ソルバー候補 → メインエージェント判断 → 送信 → 観測反映 を1フェーズ分行う */
      const playPhase = async (phase: "CMD1" | "CMD2"): Promise<{ command: string; reason: string; values: number[] | null; source: "main" | "solver" }> => {
        uiBus.patchState({ turn, phase: phase === "CMD1" ? "READY_CMD1" : "READY_CMD2" });
        const solverDecision: SolverDecision =
          decideSolver(worldMap, phase, turn, mainAgent?.currentPlan ?? null);
        const events = evaluateBreakpoint({ turn, worldMap, solverDecision }).reasons;
        for (const r of events) if (!breakpointReasons.includes(r)) breakpointReasons.push(r);
        syncUiPredictionAndMap(worldMap, turn, phase, solverDecision, "solver", events);

        let decision = solverDecision;
        let source: "main" | "solver" = "solver";
        if (mainAgent) {
          uiBus.patchState({ status: "claude_in_game", statusMessage: `T${turn} ${phase} メインエージェント判断中` });
          const res = await mainAgent.decide({
            turn,
            phase,
            worldMap,
            events,
            solve: (plan) => decideSolver(worldMap, phase, turn, plan),
          });
          if (res.action) mainActions.push(`${phase}:${res.action}`);
          if (res.delegated) delegations.push(res.delegated);
          reloadTilesKnowledge();
          if (res.durationMs !== null) mainLatencyMs.push(res.durationMs);
          decision = res.decision;
          source = res.source;
          if (source === "solver") solverFallbackNotes.push(`${phase}: ${res.note}`);
          if (source === "main") {
            decision = { ...decision, reason: `[main] ${decision.reason} (${res.note})` };
          } else {
            decision = { ...decision, reason: `${decision.reason} [solver: ${res.note}]` };
          }
          syncUiPredictionAndMap(worldMap, turn, phase, decision, source, events, {
            mainAction: res.action,
            mainNote: res.note,
            mainLatencyMs: res.durationMs,
            plan: mainAgent.currentPlan,
            delegated: res.delegated,
          });
          uiBus.patchState({ status: "playing", statusMessage: `Room ${config.room} 対戦中` });
        }

        const r = phase === "CMD1" ? await client.command1(decision.command) : await client.command2(decision.command);
        worldMap.applyObservation(phase, decision.command, r.values, turn);
        // 観測直後にもマップを更新（次の判断を待たずに画面へ反映）
        uiBus.updateMap(worldMap.buildUiMapState(null, mainAgent?.currentPlan?.target ?? null));
        // ワープ直後は位置合わせのためすぐ取り直す（裏で実行）
        if (worldMap.getLastEventFlags().warped) webMap.onWarp(turn);
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
        } else {
          throw err;
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
        mainLatencyMs,
        solverFallbackNotes,
        mainActions,
        delegations,
        ...(mainAgent
          ? { agentTokens: mainAgent.usage().totalTokens - tokensAtTurnStart, mainInputTokens: mainAgent.usage().lastCallInputTokens }
          : {}),
        breakpointReasons,
        webMapTurn: webMap.lastTurn,
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
  }

  const finishedAt = new Date().toISOString();
  const stats = worldMap.getStats();
  await webMap.drain();
  const officialResult = await fetchLatestResult(config.room);
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
    webMapDetected: webMap.available,
    webMapUrl: webMap.sourceUrl,
    turns: turnLogs.length,
    gameOverReason,
    estimatedScore: stats,
    officialResult,
    tilePickups: stats.pickups,
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

  // この試合で使ったソルバー（試合後の改修前）を残す。最高記録ならルームの最良ソルバーとしても保存
  const solverPath = SOLVER_PATH;
  if (existsSync(solverPath)) {
    copyFileSync(solverPath, path.join(runDir, "solver-snapshot.ts"));
    if (updatedProfile.bestRunId === runId) {
      const bestSolverPath = path.join(BEST_SOLVERS_DIR, `room${config.room}.ts`);
      mkdirSync(BEST_SOLVERS_DIR, { recursive: true });
      copyFileSync(solverPath, bestSolverPath);
      updatedProfile.bestSolverFile = bestSolverPath;
      saveRoomProfile(updatedProfile);
    }
  }

  return summary;
}
