import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ASSETS_DIR, PUBLIC_DIR, RUNS_DIR } from "../paths";
import { EFFORT_LEVELS, listGatewayModels } from "../agent/models";
import { verifySolverWithReplay } from "../evolution/replay-verifier";
import { loadRoomProfiles } from "../memory/knowledge-store";
import { WorldMap } from "../memory/world-map";
import { scrapeRoomWebMap } from "../perception/web-map-scraper";
import { logger } from "../tools";
import { loadProjectEnvEntries, saveProjectEnvEntries } from "./env-store";
import { uiBus, type UiControlCommand } from "./event-bus";

const PUBLIC_INDEX_PATH = path.join(PUBLIC_DIR, "index.html");

function listRecentRuns(limit = 20) {
  if (!existsSync(RUNS_DIR)) return [];
  const dirs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);

  const items: Array<{
    runId: string;
    room: number | null;
    turns: number;
    officialTotalScore: number | null;
    estimatedTotalScore: number | null;
    finishedAt: string | null;
    agent: unknown;
    evolution: unknown;
  }> = [];

  for (const name of dirs) {
    const summaryPath = path.join(RUNS_DIR, name, "summary.json");
    if (!existsSync(summaryPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(summaryPath, "utf-8")) as {
        runId?: string;
        room?: number;
        turns?: number;
        officialResult?: { totalScore?: number } | null;
        estimatedScore?: { estimatedTotalScore?: number };
        finishedAt?: string;
        agent?: unknown;
        evolution?: unknown;
      };
      items.push({
        runId: parsed.runId ?? name,
        room: parsed.room ?? null,
        turns: parsed.turns ?? 0,
        officialTotalScore: parsed.officialResult?.totalScore ?? null,
        estimatedTotalScore: parsed.estimatedScore?.estimatedTotalScore ?? null,
        finishedAt: parsed.finishedAt ?? null,
        agent: parsed.agent ?? null,
        evolution: parsed.evolution ?? null,
      });
    } catch {
      // skip malformed summary
    }
  }
  return items;
}

export function startWebUiServer(port: number) {
  const server = Bun.serve({
    port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await Bun.file(PUBLIC_INDEX_PATH).text();
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // 公式タイル GIF 等の静的素材 (assets/)
      if (url.pathname.startsWith("/assets/")) {
        const rel = path.normalize(decodeURIComponent(url.pathname.slice("/assets/".length)));
        if (rel.startsWith("..") || path.isAbsolute(rel)) return new Response("Forbidden", { status: 403 });
        const file = Bun.file(path.join(ASSETS_DIR, rel));
        return (await file.exists()) ? new Response(file) : new Response("Not Found", { status: 404 });
      }

      if (url.pathname === "/api/models") {
        const { models, error } = await listGatewayModels();
        return Response.json({ ok: error === null, models, efforts: EFFORT_LEVELS, error });
      }

      if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/turns")) {
        const safeId = path.basename(url.pathname.slice("/api/runs/".length, -"/turns".length));
        const turnsPath = path.join(RUNS_DIR, safeId, "turns.jsonl");
        const turns = existsSync(turnsPath)
          ? readFileSync(turnsPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown)
          : [];
        return Response.json({ ok: true, runId: safeId, turns });
      }

      if (url.pathname === "/api/state") {
        const profiles = loadRoomProfiles().rooms;
        uiBus.patchState({ roomProfiles: profiles });
        return Response.json(uiBus.getState());
      }

      if (url.pathname === "/api/env" && req.method === "GET") {
        return Response.json({ ok: true, entries: loadProjectEnvEntries() });
      }

      if (url.pathname === "/api/env" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            entries?: Array<{ key: string; value: string }>;
          };
          if (!Array.isArray(body.entries)) {
            return Response.json({ ok: false, error: "entries array is required" }, { status: 400 });
          }
          const result = saveProjectEnvEntries(body.entries);

          // CHASER_ROOM や LLM_MODEL_NAME が変更されていたら現在の実行設定にも即時同期
          const roomEntry = body.entries.find((e) => e.key.trim() === "CHASER_ROOM");
          const modelEntry = body.entries.find((e) => e.key.trim() === "LLM_MODEL_NAME");
          const nextRoom = roomEntry ? Number(roomEntry.value) : undefined;
          uiBus.dispatchControl({
            action: "update_settings",
            ...(nextRoom && Number.isInteger(nextRoom) && nextRoom > 0 ? { room: nextRoom } : {}),
            ...(modelEntry ? { model: modelEntry.value.trim() } : {}),
          });

          uiBus.pushClaudeEvent({
            context: "system",
            kind: "system",
            title: ".env Updated",
            content: `Saved .env (${result.updatedKeys.length} keys) and hot-applied to running process.`,
          });

          return Response.json({
            ok: true,
            updatedKeys: result.updatedKeys,
            entries: loadProjectEnvEntries(),
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/runs") {
        return Response.json({
          rooms: loadRoomProfiles().rooms,
          runs: listRecentRuns(25),
        });
      }

      if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/diagnosis")) {
        const runId = url.pathname.slice("/api/runs/".length, -"/diagnosis".length);
        const safeId = path.basename(runId);
        const diagPath = path.join(RUNS_DIR, safeId, "diagnosis.md");
        const evoPath = path.join(RUNS_DIR, safeId, "evolution-report.md");
        const diag = existsSync(diagPath) ? readFileSync(diagPath, "utf-8") : "(診断レポートなし)";
        const evo = existsSync(evoPath) ? readFileSync(evoPath, "utf-8") : "";
        return Response.json({ ok: true, runId: safeId, diagnosis: diag, evolution: evo });
      }

      if (url.pathname === "/api/control" && req.method === "POST") {
        try {
          const body = (await req.json()) as UiControlCommand;
          uiBus.dispatchControl(body);
          return Response.json({ ok: true, state: uiBus.getState() });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/api/action/preview-map" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as { room?: number };
          const room = Number(body.room ?? uiBus.getState().room);
          uiBus.pushClaudeEvent({
            context: "system",
            kind: "system",
            title: "Web Map Preview",
            content: `Room ${room} の Web マップ (MapView.jsp) を取得中...`,
          });
          const scraped = await scrapeRoomWebMap({ room });
          if (scraped.found && scraped.grid) {
            const wm = new WorldMap();
            wm.setGlobalGrid(scraped.grid, scraped.playerPos, scraped.stageName);
            uiBus.updateMap(wm.buildUiMapState(null));
            uiBus.patchState({
              webMapDetected: true,
              roomProfiles: loadRoomProfiles().rooms,
              statusMessage: `Webマップ取得成功: ${scraped.stageName ?? "Live"} (${scraped.dimensions?.join("x") ?? "?"})`,
            });
            if (scraped.liveScore) {
              uiBus.updateScores({ liveOfficial: scraped.liveScore });
            }
            uiBus.pushClaudeEvent({
              context: "system",
              kind: "text",
              title: "Web Map Loaded",
              content: `Stage: ${scraped.stageName ?? "Unknown"} | Size: ${scraped.dimensions?.join("x") ?? "?"} | Player: ${JSON.stringify(scraped.playerPos)} | LiveScore: ${JSON.stringify(scraped.liveScore)}`,
            });
          } else {
            uiBus.patchState({
              webMapDetected: false,
              statusMessage: `Room ${room} の Webマップは取得できませんでした（試合開始時に ReturnCode SLAM モードで自動構築します）`,
            });
            uiBus.pushClaudeEvent({
              context: "system",
              kind: "system",
              title: "Web Map Unavailable",
              content: `Room ${room}: Webマップなし（ReturnCode からの SLAM 構築を使用）`,
            });
          }
          return Response.json({ ok: true, scraped });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/action/verify-solver" && req.method === "POST") {
        const res = await verifySolverWithReplay(path.join(RUNS_DIR, "nonexistent"));
        uiBus.pushClaudeEvent({
          context: "system",
          kind: res.ok ? "system" : "error",
          title: "Solver Self-Verify",
          content: JSON.stringify(res, null, 2),
        });
        return Response.json(res);
      }

      if (url.pathname === "/api/events") {
        const encoder = new TextEncoder();
        let cleanup: (() => void) | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const send = (event: string, data: unknown) => {
              try {
                const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                controller.enqueue(encoder.encode(payload));
              } catch {
                // stream already closed
              }
            };

            send("state", {
              ...uiBus.getState(),
              roomProfiles: loadRoomProfiles().rooms,
            });

            cleanup = uiBus.subscribe((eventName, data) => {
              send(eventName, data);
            });

            pingTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                // ignore
              }
            }, 15_000);
          },
          cancel() {
            if (cleanup) cleanup();
            if (pingTimer) clearInterval(pingTimer);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info({ url: `http://localhost:${server.port}` }, "CHaserOnline Web Dashboard started");
  return server;
}
