import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearEvolutionPending, markEvolutionPending, recoverPendingEvolution } from "./pending";
import type { ReplayVerificationResult } from "./replay-verifier";

const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "chaser-pending-"));
  const paths = { marker: path.join(dir, "pending.json"), backup: path.join(dir, "backup.ts"), solver: path.join(dir, "solver.ts") };
  writeFileSync(paths.solver, "old", "utf-8");
  return paths;
};
const info = { runId: "r1", runDir: "/x", startedAt: "2026-11-22T00:00:00Z", stage: "postMatch" as const };
const verdict = (ok: boolean) => async () => ({ ok, errors: ok ? [] : ["罠へ動く手が増えた"] }) as unknown as ReplayVerificationResult;

describe("途切れた振り返りの検証し直し", () => {
  test("印が無ければ何もしない", async () => {
    expect(await recoverPendingEvolution(verdict(false), setup())).toBeNull();
  });

  test("改修後のソルバーが不合格なら改修前に戻す", async () => {
    const p = setup();
    markEvolutionPending(info, "old", p);
    writeFileSync(p.solver, "new", "utf-8");
    const r = await recoverPendingEvolution(verdict(false), p);
    expect(r?.rolledBack).toBe(true);
    expect(readFileSync(p.solver, "utf-8")).toBe("old");
    expect(existsSync(p.marker)).toBe(false);
  });

  test("合格なら改修後のまま。変わっていなければ検証もしない", async () => {
    const p = setup();
    markEvolutionPending(info, "old", p);
    writeFileSync(p.solver, "new", "utf-8");
    expect((await recoverPendingEvolution(verdict(true), p))?.rolledBack).toBe(false);
    expect(readFileSync(p.solver, "utf-8")).toBe("new");
    markEvolutionPending(info, "new", p);
    let called = false;
    const r = await recoverPendingEvolution(async () => ((called = true), { ok: false, errors: [] }) as unknown as ReplayVerificationResult, p);
    expect(called).toBe(false);
    expect(r?.verified).toBeNull();
  });

  test("検証が例外でも改修前に戻す", async () => {
    const p = setup();
    markEvolutionPending(info, "old", p);
    writeFileSync(p.solver, "broken", "utf-8");
    const r = await recoverPendingEvolution(async () => { throw new Error("import failed"); }, p);
    expect(r?.rolledBack).toBe(true);
    clearEvolutionPending(p);
  });
});
