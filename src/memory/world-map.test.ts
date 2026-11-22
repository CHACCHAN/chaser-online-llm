import { describe, expect, test } from "bun:test";
import { getTileInfo, WorldMap } from "./world-map";

describe("WorldMap", () => {
  test("tracks gr, wu/wr, and gr* two-step collection accurately", () => {
    const map = new WorldMap();

    // Turn 1: gr sees item(3) at right (1,0) and fossil(5) at (2,0) after moving right
    map.applyObservation("CMD1", "gr", [0, 0, 0, 0, 1000, 3, 0, 0, 0], 1);
    expect(map.getPosition()).toEqual([0, 0]);

    // wr lands on (1,0) where item(3) was, and sees fossil_1(5) at right (2,0)
    map.applyObservation("CMD2", "wr", [0, 0, 0, 0, 3, 5, 0, 0, 0], 1);
    expect(map.getPosition()).toEqual([1, 0]);
    expect(map.getTile(1, 0)?.value).toBe(0); // consumed into hole
    expect(map.getTile(2, 0)?.value).toBe(5);
    expect(map.getStats().pickups["3"]).toBe(1);
    // 静止 gr は現在地(穴)への再着地として -20 (公式スコアとの突合で確認)
    // 得点は knowledge/tiles.json（実測で変わる）から
    expect(map.getStats().estimatedItemScore).toBe(getTileInfo(3).score - 20);

    // Turn 2: grr moves onto (2,0) where fossil_1(5) was, collects 125
    map.applyObservation("CMD1", "grr", [0, 0, 0, 0, 1000, 2, 0, 0, 0], 2);
    expect(map.getPosition()).toEqual([2, 0]);
    expect(map.getTile(2, 0)?.value).toBe(0);
    expect(map.getTile(3, 0)?.value).toBe(2);
    expect(map.getStats().pickups["5"]).toBe(1);
    expect(map.getStats().estimatedItemScore).toBe(getTileInfo(3).score + getTileInfo(5).score - 20);
  });

  test("dig は1マス移動し、移動後の位置から2マス先を中心に3×3 を見る（公式の説明どおり。実戦ログ18回で確認）", () => {
    const map = new WorldMap();
    map.applyObservation("CMD1", "gr", [0, 0, 0, 0, 1000, 0, 0, 0, 0], 1);
    map.applyObservation("CMD2", "du", [12, 12, 12, 12, 12, 12, 0, 0, 0], 1);
    expect(map.getPosition()).toEqual([0, -1]);
    expect(map.getTile(0, -4)?.value).toBe(12);
    expect(map.getTile(0, -3)?.value).toBe(12);
    expect(map.getTile(0, -2)?.value).toBe(0);
  });

  test("handles pd2wu, pr3sr, pu3lu, and keiru matching live probe v2", () => {
    const map = new WorldMap();

    // Turn 1..3 simplified setup matching probe v2 Turn 4 state at (0, -2)
    map.applyObservation("CMD1", "gr", [0, 0, 0, 0, 1000, 0, 0, 0, 0], 1);
    map.applyObservation("CMD2", "wu", [0, 0, 0, 0, 0, 0, 0, 0, 0], 1);
    expect(map.getPosition()).toEqual([0, -1]);

    // pd2wu: moves up to (0,-2), top row is 12
    map.applyObservation("CMD1", "gr", [0, 0, 0, 0, 1000, 0, 0, 0, 0], 3);
    map.applyObservation("CMD2", "pd2wu", [12, 12, 12, 0, 0, 0, 0, 0, 0], 3);
    expect(map.getPosition()).toEqual([0, -2]);
    expect(map.getTile(0, -3)?.value).toBe(12);

    // Turn 4: pr3sr puts 3 at (1,-2), moves clockwise down to (0,-1), ray right length 7
    map.applyObservation("CMD1", "gr", [12, 12, 12, 0, 1000, 0, 0, 0, 0], 4);
    map.applyObservation("CMD2", "pr3sr", [0, 0, 0, 0, 12, 12, 12], 4);
    expect(map.getPosition()).toEqual([0, -1]);
    expect(map.getTile(1, -2)?.value).toBe(3);
    expect(map.getTile(4, -1)?.value).toBe(0);
    expect(map.getTile(5, -1)?.value).toBe(12);

    // Turn 5: pu3lu puts 3 at (0,-2), moves clockwise right to (1,-1), looks 2 up -> center (1,-3)
    map.applyObservation("CMD1", "gr", [0, 0, 3, 0, 1000, 0, 0, 2, 0], 5);
    map.applyObservation("CMD2", "pu3lu", [12, 12, 12, 12, 12, 12, 3, 3, 0], 5);
    expect(map.getPosition()).toEqual([1, -1]);
    expect(map.getTile(0, -2)?.value).toBe(3);
    expect(map.getTile(1, -2)?.value).toBe(3);
    expect(map.getTile(1, -3)?.value).toBe(12);

    // Turn 6: keiru jumps (+1, -2) from (1,-1) to (2,-3)
    map.applyObservation("CMD1", "gr", [3, 3, 0, 0, 1000, 0, 2, 0, 0], 6);
    map.applyObservation("CMD2", "keiru", [12, 12, 12, 12, 12, 12, 3, 0, 0], 6);
    expect(map.getPosition()).toEqual([2, -3]);
    expect(map.getTile(1, -2)?.value).toBe(3);
    expect(map.getTile(2, -3)?.value).toBe(0);
  });

  test("detects bedrock block and warp segment switches", () => {
    const map = new WorldMap();
    map.applyObservation("CMD1", "gr", [10, 10, 10, 0, 1000, 3, 0, 2, 0], 1);

    // Attempting wu into bedrock(10) keeps same 3x3 -> position stays (0,0)
    map.applyObservation("CMD2", "wu", [10, 10, 10, 0, 0, 3, 0, 2, 0], 1);
    expect(map.getPosition()).toEqual([0, 0]);

    // Stepping onto a warp or unexpected terrain with >=3 mismatches starts a new segment
    map.applyObservation("CMD1", "gr", [10, 10, 10, 0, 1000, 3, 0, 2, 0], 2);
    map.applyObservation("CMD2", "wr", [70, 5, 6, 9, 20, 7, 8, 1, 71], 2);
    expect(map.getSegmentId()).toBe(1);
    expect(map.getSegmentCount()).toBe(2);
    expect(map.getPosition()).toEqual([0, 0]);
    expect(map.getTile(1, 0)?.value).toBe(7);
    expect(map.getTile(-1, -1)?.value).toBe(70);
  });

  test("evaluates hazards, recommends gr* when adjacent positive tile exists, and gr when surrounded by holes", () => {
    const map = new WorldMap();
    // Up=4(geode), Right=5(fossil1), Down=12(abyss), Left=10(bedrock)
    map.applyObservation("CMD1", "gr", [0, 4, 0, 10, 1000, 5, 0, 12, 0], 1);

    const evalCmd1WithReward = map.evaluateCandidates("CMD1");
    const gru = evalCmd1WithReward.candidates.find((c) => c.command === "gru");
    const grd = evalCmd1WithReward.candidates.find((c) => c.command === "grd");
    const grl = evalCmd1WithReward.candidates.find((c) => c.command === "grl");
    const grr = evalCmd1WithReward.candidates.find((c) => c.command === "grr");

    expect(gru?.safety).toBe("HAZARD");
    expect(grd?.safety).toBe("HAZARD");
    expect(grl?.safety).toBe("BLOCKED");
    expect(grr?.safety).toBe("SAFE");
    expect(grr?.note).toContain("DOUBLE_COLLECT_OPPORTUNITY");
    expect(evalCmd1WithReward.recommendedFallback).toBe("grr");

    const evalCmd2 = map.evaluateCandidates("CMD2");
    expect(evalCmd2.recommendedFallback).toBe("wr");

    // When surrounded solely by holes(0) and hazards, CMD1 fallback must be stationary "gr"
    const holeMap = new WorldMap();
    holeMap.applyObservation("CMD1", "gr", [0, 0, 0, 4, 1000, 0, 0, 12, 0], 1);
    const evalHoles = holeMap.evaluateCandidates("CMD1");
    expect(evalHoles.recommendedFallback).toBe("gr");
  });
});

describe("公式の番号で決まるタイルの種類", () => {
  test("ワープ・ブラックスター・ジオーメタルは tiles.json の推測で種類が変わらない（得点はジオーメタルの公式範囲内だけ使う）", async () => {
    const { getTileInfo } = await import("./world-map");
    expect(getTileInfo(61)).toMatchObject({ name: "blackstar", symbol: "B", score: 5 });
    expect(getTileInfo(63)).toMatchObject({ name: "blackstar", symbol: "B", score: 5 });
    expect(getTileInfo(32)).toMatchObject({ name: "warp", symbol: "W", score: 5 });
    expect(getTileInfo(71)).toMatchObject({ name: "geometal", symbol: "G" });
    expect(getTileInfo(79).score).toBeGreaterThanOrEqual(200);
  });
});

describe("ワープを踏んだ直後", () => {
  test("移動後の観測の中心がワープの番号なら、その場でワープとして扱い、次の手を古い地図で選ばない", () => {
    const map = new WorldMap();
    map.applyObservation("CMD1", "gr", [0, 0, 12, 33, 1000, 12, 0, 0, 12], 1);
    // 左の 33 を踏んだ。観測は入口のまわり（地図と矛盾しない）で、中心は自機ではなく 33
    map.applyObservation("CMD1", "grl", [0, 0, 0, 0, 33, 0, 0, 0, 0], 2);
    const f = map.getLastEventFlags();
    expect(f.warped).toBe(true);
    expect(f.warpPending).toBe(true);
    expect(map.getPosition()).toEqual([0, 0]);
    expect(map.getSegmentCount()).toBe(2);
    expect(map.getTile(0, 0)).toBeUndefined(); // 着地先のまわりはまだ分からない
    const link = map.getWarpLinks().at(-1)!;
    expect(link.tileValue).toBe(33);
    expect(link.fromPos).toEqual([-1, 0]);
    // 着地先で歩いた観測は新しい区画に入り、二重にワープ扱いしない
    map.applyObservation("CMD2", "wl", [0, 0, 0, 0, 12, 12, 0, 21, 0], 2);
    expect(map.getLastEventFlags().warped).toBe(false);
    expect(map.getPosition()).toEqual([-1, 0]);
  });
});

describe("フィールドの端の観測（要素が減る）", () => {
  test("左の列が無い観測を正しい位置に並べ、踏んだマスを穴にし、外を壁として覚える", () => {
    const map = new WorldMap();
    // 左端に立っている: 返り値は [中,右] ×3 行（本番の記録: "12,12,1000,12,12,12"）
    map.applyObservation("CMD1", "gr", [3, 0, 1000, 5, 0, 7], 1);
    expect(map.getTile(0, -1)?.value).toBe(3);
    expect(map.getTile(1, 0)?.value).toBe(5);
    expect(map.getTile(1, 1)?.value).toBe(7);
    expect(map.getTile(-1, 0)?.offField).toBe(true);
    expect(getTileInfo(map.getTile(-1, 0)!.value).passable).toBe(false);
    // 上へ歩いてアイテム(3)を拾う。着地したマスは穴(0)になる
    map.applyObservation("CMD2", "wu", [0, 0, 1000, 0, 0, 5], 1);
    expect(map.getPosition()).toEqual([0, -1]);
    expect(map.getTile(0, -1)?.value).toBe(0);
    expect(map.getTile(0, -1)?.visitedCount).toBe(1);
    // 外のマスは経路探索で回るが、位置合わせに使う「分かっているマスの数」には入らない
    let off = 0;
    map.forEachKnownTile((_x, _y, rec) => { if (rec.offField) off += 1; });
    expect(off).toBe(4); // x=-1 の y=-2..1
  });

  test("隅（4要素）・上の行が無い（6要素）も中心の自機の位置で決める", () => {
    const map = new WorldMap();
    // 右上の隅: [左,中] ×2 行、中心は index 1
    map.applyObservation("CMD1", "gr", [4, 1000, 9, 0], 1);
    expect(map.getTile(-1, 0)?.value).toBe(4);
    expect(map.getTile(-1, 1)?.value).toBe(9);
    expect(map.getTile(0, 1)?.value).toBe(0);
    expect(map.getTile(1, 0)?.offField).toBe(true);
    expect(map.getTile(0, -1)?.offField).toBe(true);
    // 中心が自機でなく決められない観測は使わない
    const m2 = new WorldMap();
    m2.applyObservation("CMD1", "gr", [12, 12, 12], 1);
    expect(m2.knownTileCount()).toBe(0);
  });
});
