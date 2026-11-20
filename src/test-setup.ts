/**
 * bun test の前に読み込まれる（bunfig.toml の [test] preload）。
 * テストが試合中の実ファイル（var/current/MEMO.md 等・作戦方針・ソルバー）に触れないよう、
 * var/ と編集ガードの基準を一時ディレクトリに向ける。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

Bun.env.CHASER_TEST_VAR_DIR ??= mkdtempSync(path.join(tmpdir(), "chaser-test-var-"));
const { setGuardRootForTest } = await import("./evolution/edit-guard");
setGuardRootForTest(mkdtempSync(path.join(tmpdir(), "chaser-test-guard-")));
