import "./env-files"; // .env.local より .env を優先（最初に読む）
import path from "node:path";
import { CURRENT_SNAPSHOT_PATH, RUNS_DIR } from "./paths";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyPolicyWithReplay } from "./evolution/replay-verifier";
import {
  loadTilesKnowledge,
  roomCells,
  setCellNote,
  upsertTileDefinition,
} from "./memory/knowledge-store";
import { type MeasureTurn, measureTileScores } from "./memory/tile-measure";
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
      "run-dir": { type: "string" },
      near: { type: "string" },
      radius: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
      note: { type: "string" },
      abs: { type: "boolean" },
      n: { type: "string" },
      seed: { type: "string" },
      "max-turns": { type: "string" },
      minutes: { type: "string" },
      policy: { type: "string" },
      model: { type: "string" },
      evaluator: { type: "string" },
      "dry-run": { type: "boolean" },
      workers: { type: "string" },
    },
    strict: false,
  });

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
    // Webマップの公式の得点で実測した得点は、推測で書き換えない（名前・メモなどは更新できる）
    const prev = loadTilesKnowledge()[String(id)];
    const keepMeasured = prev?.source === "measured";
    upsertTileDefinition(id, {
      name: typeof values.name === "string" ? values.name : `tile_${id}`,
      label: typeof values.label === "string" ? values.label : `タイル(${id})`,
      score: keepMeasured ? prev.score : score,
      passable,
      hazard,
      symbol: typeof values.symbol === "string" ? values.symbol.slice(0, 2) : "?",
      known: true,
      source: keepMeasured ? "measured" : "inferred",
      ...(keepMeasured ? { measuredSamples: prev.measuredSamples } : {}),
      notes: typeof values.notes === "string" ? values.notes : prev?.notes,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          updatedTile: id,
          ...(keepMeasured && prev.score !== score ? { note: `得点は実測（${prev.score}）のまま。measured の得点は推測で書き換えない` } : {}),
          tiles: loadTilesKnowledge()[String(id)],
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "tile-scores") {
    // 試合の turns.jsonl（landed と webScore）から、Webマップの公式のアイテム得点で測ったタイルの得点を出す（読むだけ）。
    // 試合の終わりにハーネスが同じ計算をして knowledge/tiles.json に source: "measured" で残している
    const runDir = typeof values["run-dir"] === "string" ? path.resolve(process.cwd(), values["run-dir"]) : null;
    const file = runDir ? path.join(runDir, "turns.jsonl") : null;
    if (!file || !existsSync(file)) {
      console.error("--run-dir <var/runs/...>（turns.jsonl のあるフォルダ）が必要");
      process.exit(1);
    }
    const turns = readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MeasureTurn);
    const withScore = turns.filter((t) => t.webScore).length;
    const res = measureTileScores(turns);
    const db = loadTilesKnowledge();
    console.log(
      JSON.stringify(
        {
          turns: turns.length,
          turnsWithWebScore: withScore,
          ...res,
          tiles: res.tiles.map((t) => ({ ...t, tilesJson: db[String(t.value)]?.score ?? null })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "verify") {
    const runDir =
      typeof values["run-dir"] === "string"
        ? path.resolve(process.cwd(), values["run-dir"])
        : path.join(RUNS_DIR, "nonexistent");
    // その試合で使った評価関数（evaluator-snapshot.ts）があれば、罠へ動く手の回数を比べる
    const snap = path.join(runDir, "evaluator-snapshot.ts");
    const res = await verifyPolicyWithReplay(runDir, { baselineEvaluatorCode: existsSync(snap) ? readFileSync(snap, "utf-8") : null });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  // cells / cell-note の座標: 既定は var/current/snapshot.json の position と同じ座標（今の区画）。
  // 保存は絶対座標（Webマップの列・行）なので、snapshot の globalPosition との差で直す。--abs なら絶対座標をそのまま使う
  const offset = (): [number, number] | null => {
    if (!existsSync(CURRENT_SNAPSHOT_PATH)) return null;
    const s = JSON.parse(readFileSync(CURRENT_SNAPSHOT_PATH, "utf-8")) as { position?: [number, number]; globalPosition?: [number, number] | null };
    return s.position && s.globalPosition ? [s.globalPosition[0] - s.position[0], s.globalPosition[1] - s.position[1]] : null;
  };
  const needOffset = (): [number, number] => {
    if (values.abs) return [0, 0];
    const o = offset();
    if (!o) {
      console.error("今の盤面が Webマップで位置合わせできていない（var/current/snapshot.json の globalPosition が無い）。絶対座標が分かるなら --abs を付ける。Webマップの無いルームは記録できない");
      process.exit(1);
    }
    return o;
  };

  if (subcommand === "cells") {
    // ワープの記録（ハーネスが自動で書く）とマスのメモ。出力は絶対座標と、今の座標（local）の両方
    const room = Number(values.room ?? Bun.env.CHASER_ROOM ?? "3");
    const o: [number, number] | null = values.abs ? [0, 0] : offset();
    const near = typeof values.near === "string" ? (values.near.split(",").map(Number) as [number, number]) : null;
    if (near && !o) needOffset();
    const nearAbs = near && o ? ([near[0] + o[0], near[1] + o[1]] as [number, number]) : null;
    const radius = values.radius !== undefined ? Number(values.radius) : Infinity;
    const res = roomCells(room, nearAbs, radius);
    const local = (p: [number, number]) => (o && !values.abs ? [p[0] - o[0], p[1] - o[1]] : undefined);
    console.log(
      JSON.stringify(
        {
          ...res,
          coords: values.abs || !o ? "絶対座標" : "from/to/x,y は絶対座標、local は今の pos と同じ座標",
          warps: res.warps.map((w) => ({ ...w, localFrom: local(w.from), localTo: local(w.to) })),
          notes: res.notes.map((n) => ({ ...n, local: local([n.x, n.y]) })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "cell-note") {
    const room = Number(values.room ?? Bun.env.CHASER_ROOM ?? "3");
    const x = Number(values.x);
    const y = Number(values.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      console.error("--x と --y が必要（既定は今の pos と同じ座標。絶対座標なら --abs）");
      process.exit(1);
    }
    const [ox, oy] = needOffset();
    const [ax, ay] = [x + ox, y + oy];
    console.log(JSON.stringify({ room, x: ax, y: ay, coords: "絶対座標で保存", notes: setCellNote(room, ax, ay, String(values.note ?? "")) }));
    return;
  }

  if (subcommand === "sim" || subcommand === "bench" || subcommand === "train") {
    await simCommands(subcommand, values as Record<string, string | boolean | undefined>);
    return;
  }

  console.log(
    [
      "Usage: bun src/cli.ts <subcommand> [options]",
      "Subcommands:",
      "  reference    [--query <q>] [--tile <id>]       Consult official CHaserOnline reference & tile DB",
      "  upsert-tile  --id <id> --score <s> ...         Register or update tile knowledge in tiles.json",
      "  verify       [--run-dir <dir>]                 試合の記録（turns.jsonl）の盤面で方策（planner＋evaluator.ts）を動かして確かめる",
      "  tile-scores  --run-dir <dir>  Tile scores measured from the official item score on the Web map (read only)",
      "  cells        --room <n> [--near x,y] [--radius r] [--abs]  Known warps and cell notes (coords = snapshot pos frame unless --abs)",
      "  cell-note    --room <n> --x <x> --y <y> --note <text> [--abs]  Add a note to a cell (empty --note clears)",
      "  sim          [--room <n>] [--n 8] [--seed s] [--max-turns t] [--model id]  シミュレータで試合をして成績を出す（--model: knowledge/styles.json のモデル。既定は試合で使うモデル）",
      "  bench        [--room <n>] [--n 24] [--evaluator <file>] [--model id]  シミュレータで比べる（--evaluator: 今の evaluator.ts とそのファイル。無し: 既定のパラメータと学習したパラメータ）",
      "  train        [--room <n>] [--minutes 5] [--dry-run] [--model id]  そのモデルのパラメータを、そのモデルの目的で学習する（はっきり良くなった時だけ保存）",
    ].join("\n"),
  );
}

async function simCommands(sub: "sim" | "bench" | "train", v: Record<string, string | boolean | undefined>): Promise<void> {
  const { SimPool } = await import("./sim/pool");
  const { comparePolicies, evaluatePolicy, makeEvalSet, perTurn, trainPolicy } = await import("./sim/train");
  const { loadModelParams, playModelId } = await import("./solver/models");
  const model = typeof v.model === "string" ? v.model : playModelId();
  const room = typeof v.room === "string" ? Number(v.room) : null;
  const maxTurns = typeof v["max-turns"] === "string" ? Number(v["max-turns"]) : 200;
  const pool = new SimPool(typeof v.workers === "string" ? Number(v.workers) : undefined);
  try {
    if (sub === "sim") {
      const n = Number(v.n ?? 8);
      const set = makeEvalSet(Number(v.seed ?? 1), n, room, maxTurns);
      const policy = { kind: "planner", params: loadModelParams(model) } as const;
      const rs = await evaluatePolicy(pool, policy, set);
      for (const [i, r] of rs.entries()) console.log(`seed ${set.seeds[i]} ${r.scenario} web=${r.webMap} T=${r.totalTurns} 得点 ${r.score}（${perTurn(r).toFixed(1)}/ターン）罠 ${r.hazardHits} 相手 ${r.opponentKinds.map((k, j) => `${k}:${r.opponents[j]}`).join(",") || "-"} 当てた ${r.put} 当てられた ${r.putDamage}${r.won === null ? "" : r.won ? " 勝ち" : " 負け"} ${r.msPerPhase}ms/手`);
      const vs = rs.filter((r) => r.won !== null);
      console.log(`平均 ${(rs.reduce((s, r) => s + perTurn(r), 0) / rs.length).toFixed(1)} 点/ターン${vs.length ? `・相手のいる地図 ${vs.length} 枚で勝ち ${vs.filter((r) => r.won).length}・当てられた合計 ${vs.reduce((s, r) => s + r.putDamage, 0)}` : ""}`);
      return;
    }
    if (sub === "bench") {
      const n = Number(v.n ?? 24);
      const set = makeEvalSet(Number(v.seed ?? 500_000), n, room, maxTurns);
      const params = loadModelParams(model);
      const { defaultParams } = await import("./solver/evaluator");
      const a = typeof v.evaluator === "string" ? ({ kind: "planner", params } as const) : ({ kind: "planner", params: defaultParams() } as const);
      const b = typeof v.evaluator === "string" ? ({ kind: "planner", params, evaluatorPath: path.resolve(v.evaluator) } as const) : ({ kind: "planner", params } as const);
      const c = await comparePolicies(pool, a, b, set);
      const label = typeof v.evaluator === "string" ? ["今の evaluator.ts", v.evaluator] : ["既定のパラメータ", `学習したパラメータ（モデル ${model}）`];
      console.log(JSON.stringify({ policyA: label[0], policyB: label[1], ...c }, null, 2));
      return;
    }
    const minutes = Number(v.minutes ?? 5);
    const r = await trainPolicy({ pool, room, budgetMs: minutes * 60_000, maxTurns, dryRun: v["dry-run"] === true, trigger: "cli", model, log: (m) => console.log(m) });
    console.log(JSON.stringify({ model: r.model, accepted: r.accepted, generations: r.generations, episodes: r.episodes, comparison: r.comparison, after: r.after }, null, 2));
  } finally {
    pool.close();
  }
}

await main();
