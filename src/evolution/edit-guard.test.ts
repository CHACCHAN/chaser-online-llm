import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { noteUserEdit, restoreProtectedFiles, setGuardRootForTest, snapshotProtectedFiles } from "./edit-guard";

/** 本物のプロジェクトに触れないよう、一時ディレクトリに保護対象の見本を作る */
function fakeProject() {
  const root = mkdtempSync(path.join(tmpdir(), "chaser-guard-"));
  const f = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
    return path.join(root, rel);
  };
  const files = {
    policy: f("agent/policies/default.md", "# 方針\n"),
    env: f(".env", "A=1\n"),
    solver: f("src/solver/evaluator.ts", "export {};\n"),
    runner: f("src/runner.ts", "// harness\n"),
  };
  setGuardRootForTest(root);
  return files;
}

test("振り返り中のエージェントの変更は戻し、WebUI からのユーザー編集は残す", () => {
  const p = fakeProject();
  const snap = snapshotProtectedFiles();
  expect(snap.has("agent/policies/default.md")).toBe(true);
  expect(snap.has(".env")).toBe(true);
  expect(snap.has("src/solver/evaluator.ts")).toBe(false); // 振り返りは評価関数を編集してよい
  writeFileSync(p.policy, "# 方針\n- エージェントが勝手に追加\n");
  writeFileSync(p.solver, "export const changed = 1;\n");
  writeFileSync(p.env, "A=2\n");
  noteUserEdit(p.env); // ユーザーが WebUI で保存
  const reverted = restoreProtectedFiles(snap);
  expect(reverted).toEqual(["agent/policies/default.md"]);
  expect(readFileSync(p.policy, "utf-8")).toBe("# 方針\n");
  expect(readFileSync(p.env, "utf-8")).toBe("A=2\n");
  expect(readFileSync(p.solver, "utf-8")).toBe("export const changed = 1;\n");
});

test("レビュー用のガードは評価関数・ハーネスの変更も戻し、新規ファイルは消す", () => {
  const p = fakeProject();
  const snap = snapshotProtectedFiles({ includeEvaluator: true });
  writeFileSync(p.solver, "// レビュー中に勝手に編集\n");
  writeFileSync(p.runner, "// 改変\n");
  writeFileSync(path.join(path.dirname(p.runner), "new.ts"), "x\n");
  const reverted = restoreProtectedFiles(snap);
  expect(reverted).toContain("src/solver/evaluator.ts");
  expect(reverted).toContain("src/runner.ts");
  expect(reverted).toContain("src/new.ts (新規作成を削除)");
  expect(readFileSync(p.solver, "utf-8")).toBe("export {};\n");
});

test("スナップショットの後に開発者がコミットした変更は戻さず、戻した中身は控えを残す", () => {
  const p = fakeProject();
  const root = path.dirname(path.dirname(p.runner));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const snap = snapshotProtectedFiles({ includeEvaluator: true });
  writeFileSync(p.runner, "// 開発者の修正\n");
  writeFileSync(path.join(root, "src/added.ts"), "// 開発者の新規\n");
  git("add", "-A");
  git("commit", "-qm", "dev");
  writeFileSync(p.policy, "# 方針\n- サブが勝手に追加\n");
  writeFileSync(path.join(root, "src/added.ts"), "// 開発者の新規\n// コミット後にサブが追記\n");
  writeFileSync(p.env, "A=9\n"); // コミットで変えていないファイルはスナップショットの中身に戻る
  const reverted = restoreProtectedFiles(snap);
  expect(reverted.sort()).toEqual([".env", "agent/policies/default.md", "src/added.ts"]);
  expect(readFileSync(p.env, "utf-8")).toBe("A=1\n");
  expect(readFileSync(p.runner, "utf-8")).toBe("// 開発者の修正\n");
  expect(readFileSync(path.join(root, "src/added.ts"), "utf-8")).toBe("// 開発者の新規\n");
  const backups = [...new Bun.Glob("var/edit-guard-backup/*/agent/policies/default.md").scanSync({ cwd: root })];
  expect(backups.length).toBe(1);
  expect(readFileSync(path.join(root, backups[0]!), "utf-8")).toContain("サブが勝手に追加");
});
