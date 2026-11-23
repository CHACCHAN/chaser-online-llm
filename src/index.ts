import "./env-files"; // .env.local より .env を優先（最初に読む）
import { Client, loginWithRetry } from "./client";
import { loadAgentConfig } from "./config";
import { recoverInterruptedEvolution, runPostMatchEvolution, runPostMatchTraining, type Say } from "./evolve";
import { enqueuePostMatch } from "./evolution/post-match-queue";
import { waitAwareClientConfig } from "./client/wait-status";
import { boolSetting, getSetting, numSetting } from "./settings";
import { getRoomProfile, knownTotalTurns, loadRoomProfiles } from "./memory/knowledge-store";
import { MainAgent, type PrepResult, runPrepPhase } from "./agent/main-agent";
import { summarizeMatchPlan } from "./agent/match-plan";
import { totalTokens } from "./agent/usage";
import type { PrepUiState } from "./ui/event-bus";
import { runAgentMatch } from "./runner";
import { logger } from "./tools";
import { nextQueuedRoom, parseRoomQueue, type UiControlCommand, uiBus } from "./ui/event-bus";
import { startWebUiServer } from "./ui/server";
import { lab } from "./sim/lab";

async function main() {
  const config = loadAgentConfig();
  // 待ち受けるアドレス: WEBUI_BIND（既定 127.0.0.1）。docker の中ではホストの ports で範囲を決めるので全部で待ち受ける（compose.yaml の WEBUI_IN_CONTAINER）
  const server = startWebUiServer(config.port, Bun.env.WEBUI_IN_CONTAINER === "1" ? "0.0.0.0" : getSetting("WEBUI_BIND") || "127.0.0.1");
  // 試合をしていない間の学習（TRAIN_IDLE / WebUI の「学習」）は今のルームに似せた地図も使う
  lab.roomForIdle = () => config.room;
  lab.startIdleLoop();
  /** ルーム欄で複数のルーム（"555-560"・"555,568"）を指定した時の並び。1試合ごとに次へ進む（1つだけなら空） */
  let roomQueue: number[] = [];
  const settingsState = () => ({
    room: config.room,
    roomQueue,
    model: config.model ?? "",
    effort: config.effort ?? "",
    turnBudgetSec: config.turnBudgetSec,
    maxTurns: config.maxTurns,
  });

  // 前回の振り返り（ソルバー改修）が再起動で途切れていたら、検証し直して不合格なら戻す
  await recoverInterruptedEvolution();
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
    publishPrep({ state: "none", room: null, model: null, effort: null, at: null, durationMs: null, tokens: null, error: null, plan: null });
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
        const r = await runPrepPhase({ model: config.model, effort: config.effort }, config.room, prepAbort.signal);
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
          plan: ok ? summarizeMatchPlan(r.plan) : null,
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

  /** 試合中に保留したルーム変更・順に回る次のルームを反映する（試合の外でだけ呼ぶ。準備はそのルームでやり直し） */
  const applyPendingRoom = () => {
    if (pendingRoom === null || inMatch) return;
    config.room = pendingRoom;
    pendingRoom = null;
    uiBus.updateScores({ roomHighScore: getRoomProfile(config.room).highScore });
    uiBus.patchState(settingsState());
    if (prepared && prepared.key !== prepKey()) resetPrep();
    publishPrep({});
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
    if (typeof cmd.rooms === "string") {
      const list = parseRoomQueue(cmd.rooms);
      if (list.length > 0) {
        roomQueue = list.length > 1 ? list : [];
        // 今のルームが並びにあればそのまま、無ければ並びの先頭から
        cmd = { ...cmd, room: list.includes(config.room) ? config.room : list[0] };
      }
    }
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
    if (typeof cmd.effort === "string") config.effort = cmd.effort.trim() || undefined;
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

    applyPendingRoom();
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
    matchIndex += 1;

    /** 試合後の仕事を裏に渡したか（渡したら、試合中の LLM は仕事が終わってから閉じる） */
    let handedOff = false;
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

      const thisMatch = matchIndex;
      const postWork = async (say?: Say) => {
        // 空いている間の学習の LLM が評価関数を書き換えている最中なら、止まる（確かめていない改修を戻す）のを待つ。
        // 振り返りと学習の LLM が同時に評価関数を書き換えないため（lab.ts の inMatch が postMatchBusy を見て止める）
        for (let i = 0; i < 240 && lab.state().job?.trigger === "idle" && lab.state().job?.coach?.state === "running"; i++) await Bun.sleep(500);
        if (!uiBus.getState().stopRequested && boolSetting("AGENT_EVOLVE")) {
          const evo = await runPostMatchEvolution(summary, mainAgent, say);
          logger.info(
            {
              matchIndex: thisMatch,
              invoked: evo.invoked,
              replayVerified: evo.replayVerified,
              rolledBack: evo.rolledBack,
            },
            "Claude Code self-evolution completed",
          );
        }
        // シミュレータで方策を学習する（LLM の振り返りとは別。振り返りを切っていても行う）
        if (!uiBus.getState().stopRequested) await runPostMatchTraining(summary, say);
      };
      // 試合後の仕事を裏で行い、すぐ次の試合へ（POST_MATCH_BACKGROUND）。仕事は1つずつ順に行う
      const background = boolSetting("POST_MATCH_BACKGROUND") && !uiBus.getState().stopRequested;
      if (background) {
        handedOff = true;
        mainAgent?.detachFromUi();
        enqueuePostMatch(summary.runId, async (say) => {
          try {
            await postWork(say);
          } finally {
            await mainAgent?.end();
          }
        });
      } else {
        await postWork();
      }

      // 順に回るルーム: 次の試合は並びの次のルーム（ループの頭で切り替わり、準備もそのルームでやり直す）
      const nextRoom = nextQueuedRoom(roomQueue, config.room);
      if (nextRoom !== null && nextRoom !== config.room) pendingRoom = nextRoom;

      if (!uiBus.getState().autoContinue || uiBus.getState().pauseRequested || uiBus.getState().stopRequested) {
        uiBus.patchState({ running: false });
        return;
      }

      uiBus.patchState({
        status: "cooldown",
        statusMessage: `Match #${matchIndex} 完了。4秒後に Room ${pendingRoom ?? config.room} の次戦を開始します...${roomQueue.length > 1 ? `（ルーム ${roomQueue.join(",")} を順に）` : ""}${handedOff ? "（試合後の仕事は裏で続ける）" : ""}`,
      });
      await Bun.sleep(4000);
    };

    inMatch = true;
    lab.setMatchActive(true);
    try {
      uiBus.patchState({
        status: "connecting",
        matchIndex,
        statusMessage: `Match #${matchIndex}: Room ${config.room} にログイン・入室中...`,
      });

      // メインエージェントは入室前に起動・準備させる（入室後にサーバを待たせない）
      const mainAgent = config.useMainAgent
        ? new MainAgent(
            { model: config.model, effort: config.effort },
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
            prep ? { memo: prep.memo, usage: prep.usage, plan: prep.plan } : null,
          );
          logger.info({ ready: ready.status }, "Main agent warm-up finished");
        }

        const client = new Client(waitAwareClientConfig(config.retryMs));
        currentClient = client;
        // 前の試合を停止・ターン上限で終えた直後は、そのセッションが切れるまで二重ログインで断られるので待ってやり直す
        uiBus.patchState({ statusMessage: `Match #${matchIndex}: Room ${config.room} にログイン中...` });
        await loginWithRetry(client, {
          shouldStop: () => uiBus.getState().stopRequested,
          onRetry: ({ attempt, remainingMs, error }) =>
            uiBus.patchState({
              statusMessage: `Match #${matchIndex}: ログインを待っています（${error}。前の試合のセッションが切れるまで、${attempt}回目・あと最大${Math.ceil(remainingMs / 60_000)}分、CHASER_LOGIN_WAIT_MIN）`,
            }),
        });
        if (uiBus.getState().stopRequested) throw new Error("停止ボタンで入室を中断");
        await client.enterRoom(config.room);
        // 準備は1試合ごとに使い切る（次の試合はその試合の結果も読んで準備し直す）。入室できなかった時は使わずに残す
        resetPrep();
        await runMatchCycle(client, mainAgent);
      } finally {
        if (!handedOff) await mainAgent?.end();
      }
    } catch (err) {
      inMatch = false; // エラー停止中はルーム変更をすぐ反映してよい
      applyPendingRoom();
      const msg = err instanceof Error ? err.message : String(err);
      if (uiBus.getState().stopRequested) {
        // 停止ボタンで打ち切った（ログイン待ち・入室中など）。エラーではないので待機に戻る
        logger.info({ matchIndex, err: msg }, "Match cycle stopped by user");
        uiBus.patchState({ running: false });
        continue;
      }
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
      lab.setMatchActive(false);
      currentClient = null;
      // 試合が終わったら保留のルームをすぐ反映する（連続を切って待機に戻った後の「準備」が前のルームにならないように）
      applyPendingRoom();
    }
  }
}

await main();
