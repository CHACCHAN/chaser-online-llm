import { getSetting, numSetting, boolSetting } from "../settings";
import { defaultParams, PARAM_SPACE } from "../solver/evaluator";
import { loadPolicyParams, loadPolicyParamsFile } from "../solver/policy";
import { lab, LAB_POLICIES, readTrainLog, realMapCounts, type LabPolicy } from "../sim/lab";
import { loadProfile } from "../sim/mapgen";
import { setProjectEnvValue } from "./env-store";

/**
 * WebUI の「学習」画面の API（/api/lab/…）。シミュレータだけを使い、CHaser サーバには触れない。
 * 状態の変化は SSE の "lab" で配る（server.ts）。
 */

const roomOf = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isInteger(n) || n <= 0 ? null : n;
};
const policyOf = (v: unknown, fallback: LabPolicy): LabPolicy => (LAB_POLICIES as readonly string[]).includes(String(v)) ? (v as LabPolicy) : fallback;
const clampNum = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function labOverview() {
  const file = loadPolicyParamsFile();
  let profile: unknown = null;
  try {
    profile = loadProfile(null);
  } catch {
    profile = null;
  }
  return {
    ok: true,
    lab: lab.state(),
    policy: {
      play: getSetting("PLAY_POLICY") || "planner",
      async: boolSetting("AGENT_ASYNC"),
      params: loadPolicyParams(),
      defaults: defaultParams(),
      space: PARAM_SPACE,
      source: file?.source ?? "default",
      updatedAt: file?.updatedAt ?? null,
      bench: file?.bench ?? null,
    },
    history: readTrainLog(60),
    maps: { real: realMapCounts(), profile },
    settings: {
      trainAfterMatchMin: numSetting("TRAIN_AFTER_MATCH_MIN", { min: 0 }),
      idleChunkMin: numSetting("TRAIN_IDLE_CHUNK_MIN", { min: 1 }),
      simMaxTurns: numSetting("SIM_MAX_TURNS", { min: 10, integer: true }),
    },
  };
}

/** /api/lab で始まる要求を処理する（それ以外は null） */
export async function handleLabRequest(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/lab")) return null;
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  if (url.pathname === "/api/lab" && req.method === "GET") return Response.json(labOverview());

  if (url.pathname === "/api/lab/train" && req.method === "POST") {
    if (lab.busy && lab.state().job?.trigger !== "idle") return Response.json({ ok: false, error: "ほかの仕事が動いています（止めてから始めてください）" }, { status: 409 });
    const minutes = clampNum(body.minutes, 0.5, 240, 5);
    // 待たずに返す（進み具合は SSE の "lab" で届く）
    void lab.train({ room: roomOf(body.room), minutes, dryRun: body.dryRun === true, trigger: "manual" });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/lab/bench" && req.method === "POST") {
    if (lab.busy && lab.state().job?.trigger !== "idle") return Response.json({ ok: false, error: "ほかの仕事が動いています（止めてから始めてください）" }, { status: 409 });
    const n = Math.round(clampNum(body.n, 4, 400, 24));
    void lab.bench({ room: roomOf(body.room), n, a: policyOf(body.a, "default"), b: policyOf(body.b, "current") });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/lab/stop" && req.method === "POST") {
    lab.stop();
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/lab/idle" && req.method === "POST") {
    const enabled = body.enabled === true;
    // 次に起動した時も同じにする（.env に保存）
    setProjectEnvValue("TRAIN_IDLE", enabled ? "true" : "false");
    lab.setIdle(enabled);
    return Response.json({ ok: true, lab: lab.state() });
  }

  if (url.pathname === "/api/lab/episode" && req.method === "POST") {
    try {
      const seed = Math.round(clampNum(body.seed, 0, 2 ** 31 - 1, Math.floor(Math.random() * 1e8)));
      const maxTurns = body.maxTurns === null || body.maxTurns === "" || body.maxTurns === undefined ? null : Math.round(clampNum(body.maxTurns, 5, 3000, 200));
      const r = await lab.episode({ seed, room: roomOf(body.room), maxTurns, policy: policyOf(body.policy, "current") });
      return Response.json({ ok: true, seed, result: r });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) }, { status: 500 });
    }
  }

  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}
