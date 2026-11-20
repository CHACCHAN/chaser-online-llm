import { Client } from "./client";
import { loadAgentConfig } from "./config";
import { runPostMatchEvolution } from "./evolve";
import { waitAwareClientConfig } from "./client/wait-status";
import { boolSetting } from "./settings";
import { getRoomProfile, loadRoomProfiles } from "./memory/knowledge-store";
import { MainAgent } from "./agent/main-agent";
import { runAgentMatch } from "./runner";
import { logger } from "./tools";
import { type UiControlCommand, uiBus } from "./ui/event-bus";
import { startWebUiServer } from "./ui/server";

async function main() {
  const config = loadAgentConfig();
  const server = startWebUiServer(config.port);
  const settingsState = () => ({
    room: config.room,
    model: config.model ?? "",
    subModel: config.subModel ?? "",
    effort: config.effort ?? "",
    subEffort: config.subEffort ?? "",
    turnBudgetSec: config.turnBudgetSec,
    maxTurns: config.maxTurns,
  });

  const initialProfile = getRoomProfile(config.room);
  const allProfiles = loadRoomProfiles().rooms;

  // Web ダッシュボード優先起動: 起動直後は IDLE で待機し、Web画面からルーム選択・開始する
  uiBus.patchState({
    ...settingsState(),
    roomProfiles: allProfiles,
    status: "idle",
    statusMessage: `Webダッシュボード起動完了 (http://localhost:${server.port}) — ルームを選んで「開始」を押してください`,
    autoContinue: true,
    running: false,
    pauseRequested: false,
    stopRequested: false,
  });
  uiBus.updateScores({
    roomHighScore: initialProfile.highScore,
  });

  /** 試合中（入室〜振り返り）か。試合中のルーム変更は記録が混ざるので次の試合まで保留する */
  let inMatch = false;
  let pendingRoom: number | null = null;

  let wakeResolver: (() => void) | null = null;
  const wakeUp = () => {
    if (wakeResolver) {
      const fn = wakeResolver;
      wakeResolver = null;
      fn();
    }
  };

  /** WebUI からの設定変更を config と画面状態に反映する（start/update_settings 共通） */
  const applySettings = (cmd: UiControlCommand) => {
    if (typeof cmd.room === "number" && Number.isInteger(cmd.room) && cmd.room > 0 && cmd.room !== config.room) {
      if (inMatch) {
        pendingRoom = cmd.room;
        uiBus.pushClaudeEvent({ context: "system", kind: "system", title: "ルーム変更を保留", content: `試合中のため Room ${cmd.room} へは次の試合から切り替える（今の試合は Room ${config.room} のまま）` });
      } else {
        config.room = cmd.room;
        pendingRoom = null;
        uiBus.updateScores({ roomHighScore: getRoomProfile(config.room).highScore });
      }
    }
    if (typeof cmd.model === "string") config.model = cmd.model.trim() || undefined;
    if (typeof cmd.subModel === "string") config.subModel = cmd.subModel.trim() || undefined;
    if (typeof cmd.effort === "string") config.effort = cmd.effort.trim() || undefined;
    if (typeof cmd.subEffort === "string") config.subEffort = cmd.subEffort.trim() || undefined;
    if (typeof cmd.turnBudgetSec === "number" && cmd.turnBudgetSec >= 3) config.turnBudgetSec = cmd.turnBudgetSec;
    if (cmd.maxTurns !== undefined) {
      config.maxTurns =
        cmd.maxTurns !== null && Number.isInteger(cmd.maxTurns) && cmd.maxTurns > 0 ? cmd.maxTurns : null;
    }
    if (typeof cmd.autoContinue === "boolean") uiBus.patchState({ autoContinue: cmd.autoContinue });
    uiBus.patchState(settingsState());
  };

  uiBus.setControlHandler((cmd) => {
    if (cmd.action === "update_settings") applySettings(cmd);
    if (cmd.action === "start" || cmd.action === "resume") {
      applySettings(cmd);
      uiBus.patchState({ running: true, pauseRequested: false, stopRequested: false });
      wakeUp();
    }
    if (cmd.action === "stop") {
      uiBus.patchState({ running: false, stopRequested: true, pauseRequested: false });
      wakeUp();
    }
  });

  console.log(`\n=============================================================`);
  console.log(`  CHaserOnline × Claude Code Web Dashboard`);
  console.log(`  Open in browser: http://localhost:${server.port}`);
  console.log(`  (Select a room and click Start on the Web Dashboard)`);
  console.log(`=============================================================\n`);

  let matchIndex = 0;

  for (;;) {
    const st = uiBus.getState();

    // 待機状態: WebUI の「開始」ボタンが押されるまで何もしない
    if (!st.running || st.pauseRequested || st.stopRequested) {
      uiBus.patchState({
        status: st.pauseRequested ? "paused" : "idle",
        running: false,
        pauseRequested: false,
        stopRequested: false,
        roomProfiles: loadRoomProfiles().rooms,
        statusMessage: "待機中 — Webダッシュボードでルームを選択して「開始」を押してください",
      });
      await new Promise<void>((resolve) => {
        wakeResolver = resolve;
      });
      continue;
    }

    if (config.maxMatches !== null && matchIndex >= config.maxMatches) {
      uiBus.patchState({
        status: "idle",
        running: false,
        statusMessage: `指定試合数 (--max-matches=${config.maxMatches}) に到達しました`,
      });
      await new Promise<void>((resolve) => {
        wakeResolver = resolve;
      });
      continue;
    }

    if (pendingRoom !== null) {
      config.room = pendingRoom;
      pendingRoom = null;
      uiBus.updateScores({ roomHighScore: getRoomProfile(config.room).highScore });
      uiBus.patchState(settingsState());
    }
    matchIndex += 1;

    const runMatchCycle = async (client: Client, mainAgent: MainAgent | null) => {
      const summary = await runAgentMatch(client, config, matchIndex, mainAgent);
      const roomProfile = getRoomProfile(config.room);

      uiBus.patchState({
        roomProfiles: loadRoomProfiles().rooms,
      });

      logger.info(
        {
          matchIndex,
          runId: summary.runId,
          turns: summary.turns,
          webMapDetected: summary.webMapDetected,
          officialTotalScore: summary.officialResult?.totalScore ?? null,
          estimatedTotalScore: summary.estimatedScore.estimatedTotalScore,
          roomHighScore: roomProfile.highScore,
          claudeInterventions: summary.harnessTurns,
          runDir: summary.runDir,
        },
        "Match finished; starting Claude Code self-evolution",
      );

      if (!uiBus.getState().stopRequested && boolSetting("AGENT_EVOLVE")) {
        const evo = await runPostMatchEvolution(summary, mainAgent);
        logger.info(
          {
            matchIndex,
            invoked: evo.invoked,
            replayVerified: evo.replayVerified,
            rolledBack: evo.rolledBack,
          },
          "Claude Code self-evolution completed",
        );
      }

      if (!uiBus.getState().autoContinue || uiBus.getState().pauseRequested || uiBus.getState().stopRequested) {
        uiBus.patchState({ running: false });
        return;
      }

      uiBus.patchState({
        status: "cooldown",
        statusMessage: `Match #${matchIndex} 完了。4秒後に Room ${config.room} の次戦を開始します...`,
      });
      await Bun.sleep(4000);
    };

    inMatch = true;
    try {
      uiBus.patchState({
        status: "connecting",
        matchIndex,
        statusMessage: `Match #${matchIndex}: Room ${config.room} にログイン・入室中...`,
      });

      // メインエージェントは入室前に起動・準備させる（入室後にサーバを待たせない）
      const mainAgent = config.useMainAgent
        ? new MainAgent(
            { model: config.model, subModel: config.subModel, effort: config.effort, subEffort: config.subEffort },
            config.turnBudgetSec * 1000,
          )
        : null;
      try {
        if (mainAgent) {
          uiBus.patchState({ statusMessage: `Match #${matchIndex}: メインエージェント起動中...` });
          const profile = getRoomProfile(config.room);
          const ready = await mainAgent.begin({
            room: config.room,
            stageName: null,
            webMap: profile.webMapAvailable ?? false,
            highScore: profile.highScore ?? 0,
          });
          logger.info({ ready: ready.status }, "Main agent warm-up finished");
        }

        const client = new Client(waitAwareClientConfig(config.retryMs));
        await client.login();
        await client.enterRoom(config.room);
        await runMatchCycle(client, mainAgent);
      } finally {
        await mainAgent?.end();
      }
    } catch (err) {
      inMatch = false; // エラー停止中はルーム変更をすぐ反映してよい
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ matchIndex, err: msg }, "Match cycle failed; returning to idle dashboard");
      uiBus.patchState({
        status: "error",
        running: false,
        statusMessage: `エラー停止: ${msg} — 設定を確認して「開始」を押してください`,
      });
      uiBus.pushClaudeEvent({
        context: "system",
        kind: "error",
        title: "Match Cycle Error",
        content: msg,
      });
      await new Promise<void>((resolve) => {
        wakeResolver = resolve;
      });
    } finally {
      inMatch = false;
    }
  }
}

await main();
