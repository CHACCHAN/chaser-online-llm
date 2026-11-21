import { Client } from "./client";
import { loadAgentConfig } from "./config";
import { runPostMatchEvolution } from "./evolve";
import { waitAwareClientConfig } from "./client/wait-status";
import { boolSetting, numSetting } from "./settings";
import { getRoomProfile, knownTotalTurns, loadRoomProfiles } from "./memory/knowledge-store";
import { MainAgent, type PrepResult, runPrepPhase } from "./agent/main-agent";
import { totalTokens } from "./agent/usage";
import type { PrepUiState } from "./ui/event-bus";
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
  /** 試合中のクライアント（停止ボタンで通信中のリクエストを打ち切る） */
  let currentClient: Client | null = null;
  let pendingRoom: number | null = null;

  // ---- 準備フェーズ（「開始」より前。ルームには入らない） ----
  /** 準備済みの結果。ルーム・モデル・effort が変わったら無効 */
  let prepared: { key: string; result: PrepResult } | null = null;
  let preparing: Promise<boolean> | null = null;
  let prepAbort: AbortController | null = null;
  const prepKey = () => `${config.room}|${config.model ?? ""}|${config.effort ?? ""}`;
  const prepRequired = () => config.useMainAgent && boolSetting("AGENT_PREP");
  const isPrepared = () => !prepRequired() || prepared?.key === prepKey();
  const publishPrep = (patch: Partial<PrepUiState>) =>
    uiBus.patchState({ prep: { ...uiBus.getState().prep, required: prepRequired(), ...patch } });
  const resetPrep = () => {
    prepared = null;
    publishPrep({ state: "none", room: null, model: null, effort: null, at: null, durationMs: null, tokens: null, error: null });
  };
  const idleStatus = () =>
    prepRequired() && !isPrepared()
      ? { status: "idle" as const, statusMessage: "待機中 — ルーム・モデルを選んで「準備」を押してください（準備が済むと「開始」で入室できます）" }
      : { status: "standby" as const, statusMessage: `スタンバイOK — Room ${config.room}。「開始」で入室します` };

  /** 準備フェーズを実行する（既に実行中ならその完了を待つ）。成功で true */
  const doPrep = (): Promise<boolean> => {
    if (preparing) return preparing;
    preparing = (async () => {
      const key = prepKey();
      prepAbort = new AbortController();
      publishPrep({ state: "preparing", room: config.room, model: config.model ?? null, effort: config.effort ?? null, error: null });
      uiBus.patchState({ status: "preparing", statusMessage: `準備中 — メインが Room ${config.room} のルール・過去の試合・作戦方針を読んで最初のメモを作成中（ルームにはまだ入っていません）` });
      try {
        const r = await runPrepPhase({ model: config.model, subModel: config.subModel, effort: config.effort, subEffort: config.subEffort }, config.room, prepAbort.signal);
        const aborted = prepAbort.signal.aborted;
        const ok = !aborted && key === prepKey() && r.status === "ok" && r.memo.length > 0;
        prepared = ok ? { key, result: r } : null;
        publishPrep({
          state: ok ? "ready" : aborted ? "none" : "failed",
          at: new Date().toISOString(),
          durationMs: r.durationMs,
          tokens: totalTokens(r.usage),
          error: ok ? null : aborted ? "中止" : key !== prepKey() ? "準備中に設定が変わった" : r.error ?? "メモが空",
          officialVersion: r.official.version,
          knownVersion: r.official.knownVersion,
          versionChanged: r.official.changed,
        });
        if (ok) uiBus.patchState({ agentMemo: r.memo });
        if (r.official.changed) {
          uiBus.pushClaudeEvent({ context: "system", kind: "error", title: "公式のバージョンが変わった", content: `記録 ${r.official.knownVersion} → 公式 ${r.official.version}。アイテムID・コマンド・ルールが変わった可能性があります（agent/SETUP.md §4 の見直しを推奨）` });
        }
        if (!uiBus.getState().running) {
          uiBus.patchState(ok ? idleStatus() : { status: "idle", statusMessage: `準備できませんでした（${aborted ? "中止" : r.error ?? "メモが空"}）— 「準備」をやり直してください` });
        }
        return ok;
      } finally {
        preparing = null;
        prepAbort = null;
      }
    })();
    return preparing;
  };

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
    // ルーム・モデル・effort が変わったら準備はやり直し
    if (prepared && prepared.key !== prepKey()) {
      resetPrep();
      if (!uiBus.getState().running) uiBus.patchState(idleStatus());
    } else {
      publishPrep({});
    }
  };

  uiBus.setControlHandler((cmd) => {
    if (cmd.action === "update_settings") applySettings(cmd);
    if (cmd.action === "prepare") {
      if (uiBus.getState().running || inMatch) return;
      applySettings(cmd);
      void doPrep();
    }
    if (cmd.action === "start" || cmd.action === "resume") {
      if (preparing) return;
      applySettings(cmd);
      if (!isPrepared()) {
        uiBus.patchState({ status: "idle", statusMessage: "先に「準備」を押してください（スタンバイOK になってから入室します）" });
        return;
      }
      uiBus.patchState({ running: true, pauseRequested: false, stopRequested: false });
      wakeUp();
    }
    if (cmd.action === "stop") {
      uiBus.patchState({ running: false, stopRequested: true, pauseRequested: false });
      currentClient?.abort();
      prepAbort?.abort();
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
        ...(preparing ? {} : st.pauseRequested ? { status: "paused" as const, statusMessage: "一時停止中" } : idleStatus()),
        running: false,
        pauseRequested: false,
        stopRequested: false,
        roomProfiles: loadRoomProfiles().rooms,
      });
      publishPrep({});
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
    // 連続モードの次の試合など、準備が済んでいなければ入室前に準備する（直前の試合も読ませる）
    if (!isPrepared()) {
      let ok = await doPrep();
      // 連続モードで準備に失敗したら（LLM の利用制限など）、待ってやり直す。止める・一時停止・連続を切ると抜ける
      const retryMin = numSetting("AGENT_PREP_RETRY_MIN", { min: 0 });
      const keepTrying = () => {
        const s = uiBus.getState();
        return retryMin > 0 && s.autoContinue && !s.stopRequested && !s.pauseRequested;
      };
      for (let attempt = 1; !ok && matchIndex > 0 && keepTrying(); attempt++) {
        const until = Date.now() + retryMin * 60_000;
        const error = uiBus.getState().prep.error ?? "不明";
        while (Date.now() < until && keepTrying()) {
          uiBus.patchState({
            status: "cooldown",
            statusMessage: `次の試合の準備に失敗（${error.slice(0, 80)}）。${Math.ceil((until - Date.now()) / 60_000)}分後にやり直します（${attempt}回目、AGENT_PREP_RETRY_MIN）`,
          });
          await Bun.sleep(5000);
        }
        if (!keepTrying()) break;
        ok = await doPrep();
      }
      if (!ok || uiBus.getState().stopRequested) {
        uiBus.patchState({ running: false });
        continue;
      }
    }
    // （prepared はクロージャから更新されるので、ここで型を明示して読む）
    const preparedNow = prepared as { key: string; result: PrepResult } | null;
    const prep = prepRequired() ? (preparedNow?.result ?? null) : null;
    // 準備は1試合ごとに使い切る（次の試合はその試合の結果も読んで準備し直す）
    resetPrep();
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
          const ready = await mainAgent.begin(
            {
              room: config.room,
              stageName: null,
              webMap: profile.webMapAvailable ?? false,
              highScore: profile.highScore ?? 0,
              totalTurns: knownTotalTurns(config.room),
            },
            prep ? { memo: prep.memo, usage: prep.usage } : null,
          );
          logger.info({ ready: ready.status }, "Main agent warm-up finished");
        }

        const client = new Client(waitAwareClientConfig(config.retryMs));
        currentClient = client;
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
      currentClient = null;
    }
  }
}

await main();
