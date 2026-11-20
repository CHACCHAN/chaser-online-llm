import path from "node:path";
import { RUNS_DIR } from "./paths";
import { verifySolverWithReplay } from "./evolution/replay-verifier";
import { WorldMap } from "./memory/world-map";
import { parseGridFromHtml } from "./perception/web-map-scraper";
import { decideTurnAction } from "./solver/active-solver";
import { runTacticalScriptOnSnapshot } from "./tools/script-runner";

async function runSelfTest() {
  const wm = new WorldMap();
  const sampleHtml = `
    <table>
      <tr><td>10</td><td>10</td><td>10</td><td>10</td><td>10</td></tr>
      <tr><td>10</td><td>2</td><td>3</td><td>70</td><td>10</td></tr>
      <tr><td>10</td><td>2</td><td>0</td><td>5</td><td>10</td></tr>
      <tr><td>10</td><td>4</td><td>2</td><td>2</td><td>10</td></tr>
      <tr><td>10</td><td>10</td><td>10</td><td>10</td><td>10</td></tr>
    </table>
  `;
  const parsed = parseGridFromHtml(sampleHtml);
  if (!parsed.grid || parsed.grid.length !== 5) {
    throw new Error("WebMap HTML table parser failed");
  }
  wm.setGlobalGrid(parsed.grid);
  wm.applyObservation("CMD1", "gr", [2, 3, 70, 2, 0, 5, 4, 2, 2], 1);

  if (!wm.isGlobalMapLocked()) {
    throw new Error("Global map localization failed on unique 3x3 observation");
  }

  const d1 = decideTurnAction(wm, "CMD1", 1);
  const d2 = decideTurnAction(wm, "CMD2", 1);

  const scriptRes = await runTacticalScriptOnSnapshot({
    worldMap: wm,
    code: `return { pos: snapshot.position, globalPos: snapshot.globalPosition, tilesCount: snapshot.tiles.length };`,
  });
  if (!scriptRes.ok) {
    throw new Error(`Tactical script test failed: ${scriptRes.error}`);
  }

  const replayRes = await verifySolverWithReplay(path.join(RUNS_DIR, "nonexistent"));
  if (!replayRes.ok) {
    throw new Error(`Replay verifier failed: ${replayRes.errors.join(", ")}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        globalPosition: wm.getGlobalPosition(),
        sampleCmd1: d1,
        sampleCmd2: d2,
        scriptResult: scriptRes.result,
        replaySmokeTest: replayRes,
      },
      null,
      2,
    ),
  );
}

await runSelfTest();
