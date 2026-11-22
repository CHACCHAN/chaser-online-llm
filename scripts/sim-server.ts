/**
 * シミュレータの偽 CHaser サーバを起動する（手元でハーネス全体を試すため。本番サーバには触れない）。
 *
 *   bun scripts/sim-server.ts [--port 3990] [--seed 1] [--room <似せるルーム>] [--turns 100] [--web true|false]
 *
 * 別の端末で（var/ を汚さないよう一時フォルダを使う）:
 *   HOST_URL=http://127.0.0.1:3990/CHaserOnline003/user/ CHASER_USER=sim CHASER_PASS=sim CHASER_TEST_VAR_DIR=var/tmp/sim-var \
 *     AGENT_PREP=false bun run play --room 1 --solver-only
 */
import { parseArgs } from "node:util";
import { startFakeServer } from "../src/sim/fake-server";
import { totalScore } from "../src/sim/engine";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: "string" }, seed: { type: "string" }, room: { type: "string" }, turns: { type: "string" }, web: { type: "string" } },
  strict: false,
});
const s = startFakeServer({
  port: Number(values.port ?? 3990),
  seed: Number(values.seed ?? 1),
  room: values.room ? Number(values.room) : null,
  totalTurns: values.turns ? Number(values.turns) : undefined,
  webMap: values.web === undefined ? undefined : values.web === "true",
});
console.log(`偽サーバ: ${s.url}`);
const timer = setInterval(() => {
  const g = s.game();
  if (!g) return;
  if (g.over) {
    console.log(`終了: ${g.totalTurns} ターン、得点 ${g.players.map((p) => `${p.id}:${totalScore(p.score)}`).join(" ")}`);
    clearInterval(timer);
    s.stop();
    process.exit(0);
  }
}, 500);
