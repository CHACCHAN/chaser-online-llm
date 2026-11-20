import type { WorldMap, WorldMapSnapshot } from "../memory/world-map";

/** 盤面スナップショットに対して任意の JS 関数本体を実行する（cli の run-script 用）。 */
export async function runTacticalScriptOnSnapshot(options: {
  code: string;
  worldMap?: WorldMap;
  snapshot?: WorldMapSnapshot;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ ok: boolean; result?: unknown; durationMs: number; error?: string }> {
  const start = performance.now();
  const snapshot = options.snapshot ?? options.worldMap?.toSnapshot();
  if (!snapshot) {
    return { ok: false, durationMs: 0, error: "Either worldMap or snapshot must be provided" };
  }
  const timeoutMs = options.timeoutMs ?? 2500;

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (
      snapshot: WorldMapSnapshot,
      args: Record<string, unknown>,
    ) => Promise<unknown>;

    const wrappedBody =
      options.code.includes("return ") || options.code.includes("\n")
        ? options.code
        : `return (${options.code});`;

    const fn = new AsyncFunction("snapshot", "args", wrappedBody);

    const execPromise = fn(snapshot, options.args ?? {});
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tactical script timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    const result = await Promise.race([execPromise, timeoutPromise]);
    return {
      ok: true,
      result,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
