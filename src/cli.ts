import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "./paths";
import { parseArgs } from "node:util";
import { verifySolverWithReplay } from "./evolution/replay-verifier";
import {
  getRoomProfile,
  loadTilesKnowledge,
  roomCells,
  setCellNote,
  upsertTileDefinition,
} from "./memory/knowledge-store";
import type { WorldMapSnapshot } from "./memory/world-map";
import { scrapeRoomWebMap } from "./perception/web-map-scraper";
import {
  runTacticalScriptOnSnapshot,
} from "./tools/script-runner";
import { consultReference } from "./tools/reference-fetcher";

/**
 * Claude Code CLI が Bash ツールから直接呼び出して使う専用 CLI ツールキット。
 */
async function main() {
  const argv = Bun.argv.slice(2);
  const subcommand = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      room: { type: "string" },
      url: { type: "string" },
      query: { type: "string" },
      tile: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      score: { type: "string" },
      passable: { type: "string" },
      hazard: { type: "string" },
      symbol: { type: "string" },
      notes: { type: "string" },
      snapshot: { type: "string" },
      code: { type: "string" },
      description: { type: "string" },
      "run-dir": { type: "string" },
      near: { type: "string" },
      radius: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      note: { type: "string" },
    },
    strict: false,
  });

  if (subcommand === "scrape-map") {
    const room = Number(values.room ?? Bun.env.CHASER_ROOM ?? "3");
    const res = await scrapeRoomWebMap({
      room,
      webMapUrl: typeof values.url === "string" ? values.url : undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (subcommand === "reference") {
    const res = await consultReference({
      query: typeof values.query === "string" ? values.query : undefined,
      tileId: typeof values.tile === "string" ? Number(values.tile) : undefined,
      url: typeof values.url === "string" ? values.url : undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (subcommand === "upsert-tile") {
    const id = Number(values.id);
    if (!Number.isInteger(id)) {
      throw new Error("--id <integer> is required for upsert-tile");
    }
    const score = Number(values.score ?? 0);
    const passable = values.passable !== "false";
    const hazard = values.hazard === "true";
    upsertTileDefinition(id, {
      name: typeof values.name === "string" ? values.name : `tile_${id}`,
      label: typeof values.label === "string" ? values.label : `タイル(${id})`,
      score,
      passable,
      hazard,
      symbol: typeof values.symbol === "string" ? values.symbol.slice(0, 2) : "?",
      known: true,
      source: "inferred",
      notes: typeof values.notes === "string" ? values.notes : undefined,
    });
    console.log(JSON.stringify({ ok: true, updatedTile: id, tiles: loadTilesKnowledge()[String(id)] }, null, 2));
    return;
  }

  if (subcommand === "run-script") {
    const snapPath =
      typeof values.snapshot === "string"
        ? path.resolve(process.cwd(), values.snapshot)
        : null;
    let snapshot: WorldMapSnapshot = {
      turn: 1,
      segmentId: 0,
      segmentCount: 1,
      position: [0, 0],
      globalPosition: null,
      globalMapLocked: false,
      lastMoveDir: null,
      lastGrid: null,
      stats: {
        turnsObserved: 1,
        estimatedTotalScore: 300,
        estimatedActionScore: 0,
        estimatedItemScore: 0,
        holeRevisits: 0,
        hazardHits: 0,
        pickups: {},
        unknownTiles: [],
        segmentCount: 1,
        globalMapLocked: false,
        warpLinksCount: 0,
      },
      tiles: [],
      warpLinks: [],
    };

    if (snapPath && existsSync(snapPath)) {
      const parsed = JSON.parse(readFileSync(snapPath, "utf-8")) as {
        snapshot?: WorldMapSnapshot;
      } & Partial<WorldMapSnapshot>;
      if (parsed.snapshot) {
        snapshot = parsed.snapshot;
      } else if (parsed.position && parsed.tiles) {
        snapshot = parsed as WorldMapSnapshot;
      }
    }

    const code = typeof values.code === "string" ? values.code : "";
    if (!code) {
      throw new Error("--code <js_function_body> is required");
    }

    const res = await runTacticalScriptOnSnapshot({ code, snapshot });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (subcommand === "verify") {
    const runDir =
      typeof values["run-dir"] === "string"
        ? path.resolve(process.cwd(), values["run-dir"])
        : path.join(RUNS_DIR, "nonexistent");
    const res = await verifySolverWithReplay(runDir);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  if (subcommand === "cells") {
    // ワープの記録（ハーネスが自動で書く）とマスのメモ。座標は絶対座標（Webマップの列・行）
    const room = Number(values.room ?? Bun.env.CHASER_ROOM ?? "3");
    const near = typeof values.near === "string" ? (values.near.split(",").map(Number) as [number, number]) : null;
    const radius = values.radius !== undefined ? Number(values.radius) : Infinity;
    console.log(JSON.stringify(roomCells(room, near, radius), null, 2));
    return;
  }

  if (subcommand === "cell-note") {
    const room = Number(values.room ?? Bun.env.CHASER_ROOM ?? "3");
    const x = Number(values.x);
    const y = Number(values.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      console.error("--x と --y（絶対座標）が必要");
      process.exit(1);
    }
    console.log(JSON.stringify({ room, x, y, notes: setCellNote(room, x, y, String(values.note ?? "")) }));
    return;
  }

  if (subcommand === "status") {
    const room = Number(values.room ?? Bun.env.CHASER_ROOM ?? "3");
    const profile = getRoomProfile(room);
    const tiles = loadTilesKnowledge();
    console.log(
      JSON.stringify(
        {
          roomProfile: profile,
          knownTileCount: Object.keys(tiles).length,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    [
      "Usage: bun src/cli.ts <subcommand> [options]",
      "Subcommands:",
      "  scrape-map   --room <n> [--url <url>]          Scrape room Web Map via HTTP",
      "  reference    [--query <q>] [--tile <id>]       Consult official CHaserOnline reference & tile DB",
      "  upsert-tile  --id <id> --score <s> ...         Register or update tile knowledge in tiles.json",
      "  run-script   --snapshot <file> --code <code>   Run on-the-fly tactical JS/TS on a map snapshot",
      "  verify       [--run-dir <dir>]                 Replay-verify active-solver.ts against turns.jsonl",
      "  status       [--room <n>]                      Show room high score, profile & known tile stats",
      "  cells        --room <n> [--near x,y] [--radius r]  Known warps (absolute coords) and cell notes",
      "  cell-note    --room <n> --x <x> --y <y> --note <text>  Add a note to a cell (empty --note clears)",
    ].join("\n"),
  );
}

await main();
