import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { knownTotalTurns } from "./knowledge-store";

test("knownTotalTurns: 記録が無ければ過去の公式結果（取得＋残ターン数）から全ターン数を求める", () => {
  const runs = mkdtempSync(path.join(tmpdir(), "runs-"));
  const put = (name: string, officialResult: unknown) => {
    mkdirSync(path.join(runs, name));
    writeFileSync(path.join(runs, name, "summary.json"), JSON.stringify({ officialResult }));
  };
  put("2026-01-01_room555", { room: "555", acquiredTurns: 88, remainingTurns: 48 });
  put("2026-01-02_room556", { room: "556", acquiredTurns: 74, remainingTurns: 45 });
  put("2026-01-03_room557", null);
  expect(knownTotalTurns(555, runs)).toBe(136);
  expect(knownTotalTurns(556, runs)).toBe(119);
  expect(knownTotalTurns(557, runs)).toBeNull();
  expect(knownTotalTurns(9999, path.join(runs, "none"))).toBeNull();
});

test("Webマップの turn= は残りターン数（このターンを含む）: 自分のターンと足して全ターン数を出す", async () => {
  const { totalTurnsFromWeb } = await import("../perception/web-map-refresher");
  expect(totalTurnsFromWeb({ ourTurn: 31, webTurn: 1549 })).toBe(1579); // room719 の実測
  expect(totalTurnsFromWeb({ ourTurn: 253, webTurn: 1327 })).toBe(1579);
  expect(totalTurnsFromWeb({ ourTurn: 5, webTurn: null })).toBeNull();
  expect(totalTurnsFromWeb(null)).toBeNull();
});
