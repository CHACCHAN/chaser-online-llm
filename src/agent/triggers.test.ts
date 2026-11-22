import { describe, expect, test } from "bun:test";
import type { WorldMap } from "../memory/world-map";
import type { PolicyFn } from "../solver/policy";
import { defaultTriggerConfig, normalizeTriggerConfig, TriggerMonitor } from "./triggers";

/** きっかけの計算に要る所だけの盤面 */
function fakeMap(o: { pos?: [number, number]; est?: number; item?: number; unknown?: number[]; enemies?: { x: number; y: number; tileId: number; lastSeenTurn: number }[] } = {}): WorldMap {
  return {
    getPosition: () => o.pos ?? [0, 0],
    getSegmentId: () => 0,
    getStats: () => ({ estimatedTotalScore: o.est ?? 0, estimatedItemScore: o.item ?? 0 }),
    getLastEventFlags: () => ({ newUnknownTiles: o.unknown ?? [] }),
    getEnemySightings: () => o.enemies ?? [],
  } as unknown as WorldMap;
}
const dec = (command: string, reason = "回収", score?: number) => ({ command, reason, confidence: 1, ...(score !== undefined ? { insight: { route: [], score, candidates: 1 } } : {}) }) as never;

describe("試合中の LLM を呼ぶきっかけ", () => {
  test("設定は範囲に収め、知らない項目は捨てる", () => {
    const c = normalizeTriggerConfig({ thresholds: { stuck: 99, enemyNear: 2.6, nope: 1 }, enabled: { heartbeat: false }, cooldownTurns: -3 });
    expect(c.thresholds.stuck).toBe(6);
    expect(c.thresholds.enemyNear).toBe(3);
    expect(c.enabled.heartbeat).toBe(false);
    expect(c.cooldownTurns).toBe(0);
    expect(normalizeTriggerConfig("x")).toEqual(defaultTriggerConfig());
  });

  test("モデルの不一致: 違う手を出したモデルの数がしきい値（比べるモデルの数まで）以上で鳴り、手を残す", () => {
    const voter = (cmd: string): PolicyFn => () => dec(cmd);
    const m = new TriggerMonitor([{ id: "hunter", name: "ハンター", policy: voter("wl") }]);
    const r = m.phase({ wm: fakeMap(), phase: "CMD2", turn: 1, totalTurns: 100, play: dec("wr") });
    expect(r.fired.map((f) => f.id)).toContain("modelSplit");
    expect(r.votes).toEqual({ hunter: "wl" });
    const same = new TriggerMonitor([{ id: "hunter", name: "ハンター", policy: voter("wr") }]).phase({ wm: fakeMap(), phase: "CMD2", turn: 1, totalTurns: 100, play: dec("wr") });
    expect(same.fired).toEqual([]);
    expect(same.votes).toBeNull();
  });

  test("見込みの急落・敵が近い・知らないタイル（同じきっかけはクールダウンの間は鳴らない）", () => {
    const m = new TriggerMonitor([]);
    m.phase({ wm: fakeMap({ est: 1000 }), phase: "CMD1", turn: 1, totalTurns: null, play: dec("grr", "回収", 2000) });
    const r = m.phase({ wm: fakeMap({ est: 1000, unknown: [85], enemies: [{ x: 2, y: 0, tileId: 2000, lastSeenTurn: 1 }] }), phase: "CMD2", turn: 1, totalTurns: null, play: dec("wr", "回収", 500) });
    expect(r.fired.map((f) => f.id).sort()).toEqual(["enemyNear", "unknownTile", "valueDrop"]);
    const again = m.phase({ wm: fakeMap({ est: 1000, enemies: [{ x: 1, y: 0, tileId: 2000, lastSeenTurn: 2 }] }), phase: "CMD1", turn: 2, totalTurns: null, play: dec("grr", "回収", 500) });
    expect(again.fired.map((f) => f.id)).not.toContain("enemyNear");
    expect(m.summary(2).raw.enemyNear).toBe(2);
  });

  test("行ったり来たり・当てられた・得点のずれ・終盤・定期", () => {
    const cfg = defaultTriggerConfig();
    cfg.thresholds.heartbeat = 10;
    const m = new TriggerMonitor([], cfg);
    const ids: string[] = [];
    for (let t = 1; t <= 10; t++) {
      const pos: [number, number] = [0, t % 2];
      const web = t === 9 ? { ourTurn: 9, itemPoint: 0, totalScore: 5000, putDamage: 0 } : t === 10 ? { ourTurn: 10, itemPoint: 0, totalScore: 0, putDamage: -5000 } : null;
      ids.push(...m.turnEnd({ wm: fakeMap({ pos, est: 3000 }), turn: t, totalTurns: 11, web }).map((f) => f.id));
    }
    expect(ids).toEqual(expect.arrayContaining(["stuck", "hit", "scoreGap", "endgame", "heartbeat"]));
  });
});
