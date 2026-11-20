/**
 * WebUI を使わずに1試合だけ実行する（実戦テスト・A/B 比較用）。
 *
 *   bun run play --room 3 --max-turns 5               # メインエージェントあり
 *   bun run play --room 3 --solver-only                # ソルバーのみ
 *   bun run play --room 3 --evolve                     # 試合後の振り返り・ソルバー改修まで行う
 *
 * --model / --sub-model / --effort / --sub-effort / --turn-budget は .env より優先（src/config.ts）。
 */
import { parseArgs } from "node:util";
import { MainAgent } from "./agent/main-agent";
import { Client } from "./client";
import { loadAgentConfig } from "./config";
import { runPostMatchEvolution } from "./evolve";
import { getRoomProfile } from "./memory/knowledge-store";
import { runAgentMatch } from "./runner";
import { numSetting } from "./settings";

const config = loadAgentConfig();
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { evolve: { type: "boolean" }, "login-wait-min": { type: "string" } },
  strict: false,
});
const loginWaitMs =
  (values["login-wait-min"] !== undefined ? Number(values["login-wait-min"]) : numSetting("CHASER_LOGIN_WAIT_MIN", { min: 0 })) * 60_000;

const mainAgent = config.useMainAgent
  ? new MainAgent({ model: config.model, subModel: config.subModel, effort: config.effort, subEffort: config.subEffort }, config.turnBudgetSec * 1000)
  : null;

try {
  if (mainAgent) {
    const profile = getRoomProfile(config.room);
    const t0 = Date.now();
    const ready = await mainAgent.begin({
      room: config.room,
      stageName: null,
      webMap: profile.webMapAvailable ?? false,
      highScore: profile.highScore ?? 0,
    });
    console.log(JSON.stringify({ warmup: ready.status, ms: Date.now() - t0 }));
  }

  // サーバは同一ユーザーの二重ログインを拒否する。途中退出した試合のセッションは数分で切れるので再試行する
  let lastWaitLog = 0;
  const client = new Client({
    retryIntervalMs: config.retryMs,
    onWaiting: ({ what, elapsedMs }) => {
      if (elapsedMs < 3000 || Date.now() - lastWaitLog < 15_000) return;
      lastWaitLog = Date.now();
      console.log(JSON.stringify({ waiting: what, elapsedSec: Math.round(elapsedMs / 1000) }));
    },
  });
  const loginStart = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await client.login();
      console.log(JSON.stringify({ loginOk: new Date().toISOString(), waitedSec: Math.round((Date.now() - loginStart) / 1000) }));
      break;
    } catch (err) {
      if (Date.now() - loginStart > loginWaitMs) throw err;
      console.log(JSON.stringify({ loginRetry: attempt + 1, at: new Date().toISOString() }));
      await Bun.sleep(numSetting("CHASER_LOGIN_RETRY_SEC", { min: 1 }) * 1000);
    }
  }
  await client.enterRoom(config.room);
  const summary = await runAgentMatch(client, config, 1, mainAgent);

  console.log(
    JSON.stringify({
      runId: summary.runId,
      turns: summary.turns,
      gameOverReason: summary.gameOverReason,
      official: summary.officialResult?.totalScore ?? null,
      estimated: summary.estimatedScore.estimatedTotalScore,
      agent: summary.agent,
    }),
  );

  if (values.evolve === true) {
    const evo = await runPostMatchEvolution(summary, mainAgent);
    console.log(JSON.stringify({ evolution: { ok: evo.ok, verified: evo.replayVerified, rolledBack: evo.rolledBack } }));
  }
} finally {
  await mainAgent?.end();
}
process.exit(0);
