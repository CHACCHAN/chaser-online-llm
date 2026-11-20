import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths";

/**
 * 試合後の振り返りでメインエージェントが触ってよいのは
 * src/solver/active-solver.ts（とそのテスト）・knowledge/・agent/tools/ だけ。
 * それ以外の保護対象（ハーネス本体・プロンプト・設定）が変わっていたら元に戻す。
 */
const PROTECTED_GLOBS = ["src/**/*", "agent/prompts/**/*", "CLAUDE.md", "package.json", "tsconfig.json", ".env.example"];
const ALLOWED = new Set(["src/solver/active-solver.ts", "src/solver/active-solver.test.ts"]);

export type ProtectedSnapshot = Map<string, string>;

export function snapshotProtectedFiles(): ProtectedSnapshot {
  const snap: ProtectedSnapshot = new Map();
  for (const pattern of PROTECTED_GLOBS) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: PROJECT_ROOT, onlyFiles: true })) {
      if (!ALLOWED.has(rel)) snap.set(rel, readFileSync(path.join(PROJECT_ROOT, rel), "utf-8"));
    }
  }
  return snap;
}

/** 保護対象の変更・追加・削除を元に戻し、戻したファイルの一覧を返す */
export function restoreProtectedFiles(before: ProtectedSnapshot): string[] {
  const reverted: string[] = [];
  const after = snapshotProtectedFiles();
  for (const [rel, content] of before) {
    if (after.get(rel) !== content) {
      writeFileSync(path.join(PROJECT_ROOT, rel), content, "utf-8");
      reverted.push(rel);
    }
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) {
      const abs = path.join(PROJECT_ROOT, rel);
      if (existsSync(abs)) rmSync(abs);
      reverted.push(`${rel} (新規作成を削除)`);
    }
  }
  return reverted;
}
