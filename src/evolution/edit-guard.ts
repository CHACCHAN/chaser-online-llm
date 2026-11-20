import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths";

/**
 * 試合後の振り返りでメインエージェントが触ってよいのは
 * src/solver/active-solver.ts（とそのテスト）・knowledge/・agent/tools/ だけ。
 * それ以外の保護対象（ハーネス本体・プロンプト・ユーザーの作戦方針・設定・手順書）が変わっていたら元に戻す。
 */
const PROTECTED_GLOBS = [
  "src/**/*",
  "agent/prompts/**/*",
  "agent/policies/**/*",
  "agent/SETUP.md",
  "agent/SELF_CHECK.md",
  "CLAUDE.md",
  "package.json",
  "tsconfig.json",
  ".env",
  ".env.example",
];
const ALLOWED = new Set(["src/solver/active-solver.ts", "src/solver/active-solver.test.ts"]);

export type ProtectedSnapshot = Map<string, string>;

/** 振り返り中に取っているスナップショット（ユーザーの WebUI 編集を「正」として反映するため） */
const activeSnapshots = new Set<ProtectedSnapshot>();
/** ソルバーも保護するスナップショット（試合中のサブ用。試合中はソルバーも編集禁止） */
const includesSolver = new WeakSet<ProtectedSnapshot>();

/**
 * ユーザーが WebUI から保護対象（.env・作戦方針）を書き換えた時に呼ぶ。
 * 振り返り中なら、その内容を「元に戻す先」にして、ユーザーの編集が巻き戻されないようにする。
 */
export function noteUserEdit(absPath: string): void {
  if (activeSnapshots.size === 0) return;
  const rel = path.relative(PROJECT_ROOT, absPath);
  const content = existsSync(absPath) ? readFileSync(absPath, "utf-8") : null;
  for (const snap of activeSnapshots) {
    if (content === null) snap.delete(rel);
    else snap.set(rel, content);
  }
}

function scanProtected(includeSolver = false): ProtectedSnapshot {
  const snap: ProtectedSnapshot = new Map();
  for (const pattern of PROTECTED_GLOBS) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: PROJECT_ROOT, onlyFiles: true })) {
      if (includeSolver || !ALLOWED.has(rel)) snap.set(rel, readFileSync(path.join(PROJECT_ROOT, rel), "utf-8"));
    }
  }
  return snap;
}

/** 振り返りの前に呼ぶ。restoreProtectedFiles まで WebUI からの編集を追跡する */
export function snapshotProtectedFiles(opts: { includeSolver?: boolean } = {}): ProtectedSnapshot {
  const snap = scanProtected(opts.includeSolver);
  if (opts.includeSolver) includesSolver.add(snap);
  activeSnapshots.add(snap);
  return snap;
}

/** 保護対象の変更・追加・削除を元に戻し、戻したファイルの一覧を返す */
export function restoreProtectedFiles(before: ProtectedSnapshot): string[] {
  activeSnapshots.delete(before);
  const reverted: string[] = [];
  const after = scanProtected(includesSolver.has(before));
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
