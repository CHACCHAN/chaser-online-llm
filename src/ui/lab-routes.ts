import { lab } from "../sim/lab";
import { setProjectEnvValue } from "./env-store";

/**
 * WebUI の「学習」画面の API（/api/lab/…）。シミュレータだけを使い、CHaser サーバには触れない。
 * 状態の変化は SSE の "lab" で配る（server.ts）。
 */

const roomOf = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isInteger(n) || n <= 0 ? null : n;
};
const clampNum = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const busyRes = () => Response.json({ ok: false, error: "ほかの仕事が動いています（止めてから始めてください）" }, { status: 409 });
const othersBusy = () => lab.busy && lab.state().job?.trigger !== "idle";

/** /api/lab で始まる要求を処理する（それ以外は null） */
export async function handleLabRequest(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/lab")) return null;
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  // 状態（仕事・地図の組の概要・空き時間の学習）
  if (url.pathname === "/api/lab" && req.method === "GET") return Response.json({ ok: true, lab: lab.state() });

  // 並べる地図（地図・学習前と学習後の再生用の記録）
  if (url.pathname === "/api/lab/set" && req.method === "GET") return Response.json({ ok: true, ...lab.mapSet() });

  // 地図を作って今の方策で打たせる（すぐ返る。終わりは SSE の "lab" で分かる）
  if (url.pathname === "/api/lab/maps" && req.method === "POST") {
    if (othersBusy()) return busyRes();
    void lab.makeMaps({ n: Math.round(clampNum(body.n, 1, 48, 12)), room: roomOf(body.room) });
    return Response.json({ ok: true });
  }

  // 並べた地図で学習する
  if (url.pathname === "/api/lab/train" && req.method === "POST") {
    if (othersBusy()) return busyRes();
    if (!lab.state().set) return Response.json({ ok: false, error: "先に「地図を作る」を押してください" }, { status: 400 });
    void lab.train({ room: null, minutes: clampNum(body.minutes, 0.5, 240, 5), trigger: "manual", onSet: true });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/lab/stop" && req.method === "POST") {
    lab.stop();
    return Response.json({ ok: true });
  }

  // 試合をしていない間の学習（.env の TRAIN_IDLE に保存し、次に起動した時も同じにする）
  if (url.pathname === "/api/lab/idle" && req.method === "POST") {
    const enabled = body.enabled === true;
    setProjectEnvValue("TRAIN_IDLE", enabled ? "true" : "false");
    lab.setIdle(enabled);
    return Response.json({ ok: true, lab: lab.state() });
  }

  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}
