import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EDIT_GUARD_BACKUP_DIR, PROJECT_ROOT } from "../paths";

/**
 * 試合後の振り返りでメインエージェントが触ってよいのは
 * src/solver/active-solver.ts（とそのテスト）・knowledge/・agent/tools/ だけ。
 * それ以外の保護対象（ハーネス本体・プロンプト・ユーザーの作戦方針・設定・手順書）が変わっていたら元に戻す。
 */
const PROTECTED_GLOBS = [
  "src/**/*",
  "agent/prompts/**/*",
  "agent/policies/**/*",
  "agent/AGENTS.md",
  "agent/REVIEW.md",
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

/** 保護の基準ディレクトリ（テストでは一時ディレクトリに差し替え、本物のファイルに触れない） */
let guardRoot = PROJECT_ROOT;
let backupRoot = EDIT_GUARD_BACKUP_DIR;
export function setGuardRootForTest(dir: string): void {
  guardRoot = dir;
  backupRoot = path.join(dir, "var", "edit-guard-backup");
}

/** スナップショットを取った時の git の HEAD（その後に開発者がコミットした変更は戻さない） */
const snapshotHeads = new WeakMap<ProtectedSnapshot, string | null>();

function git(args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd: guardRoot, stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

/**
 * スナップショットの後に開発者がコミットで変えたファイルと、HEAD での中身（null = HEAD では消えている）。
 * エージェントはコミットしないので、コミットされた変更は開発者のものとして残す。HEAD が同じなら空。
 */
function committedSince(snap: ProtectedSnapshot): Map<string, string | null> {
  const changed = new Map<string, string | null>();
  const head0 = snapshotHeads.get(snap);
  const head = git(["rev-parse", "HEAD"])?.trim();
  if (!head0 || !head || head === head0) return changed;
  // -z の出力は「状態\0パス\0」の繰り返し（D = 削除）。中身を読めなかったファイルは扱わない（誤って消さない）
  const parts = (git(["diff", "--name-status", "--no-renames", "--relative", "-z", head0, head]) ?? "").split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [status, rel] = [parts[i]!, parts[i + 1]!];
    if (!rel) continue;
    if (status === "D") changed.set(rel, null);
    else {
      const content = git(["show", `${head}:${rel}`]);
      if (content !== null) changed.set(rel, content);
    }
  }
  return changed;
}

function isProtected(rel: string, includeSolver: boolean): boolean {
  return (includeSolver || !ALLOWED.has(rel)) && PROTECTED_GLOBS.some((p) => new Bun.Glob(p).match(rel));
}

/** 戻す前の中身を var/edit-guard-backup/<日時>/ に残す（間違って戻しても失わない） */
function backup(stamp: string, rel: string): void {
  const abs = path.join(guardRoot, rel);
  if (!existsSync(abs)) return;
  const dest = path.join(backupRoot, stamp, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(abs));
}

/** 振り返り中に取っているスナップショット（ユーザーの WebUI 編集を「正」として反映するため） */
const activeSnapshots = new Set<ProtectedSnapshot>();
/** ソルバーも保護するスナップショット（試合中のサブ用。試合中はソルバーも編集禁止） */
const includesSolver = new WeakSet<ProtectedSnapshot>();
/** WebUI でユーザーが保存したファイル（コミットより優先して残す） */
const userEdited = new WeakMap<ProtectedSnapshot, Set<string>>();

/**
 * ユーザーが WebUI から保護対象（.env・作戦方針）を書き換えた時に呼ぶ。
 * 振り返り中なら、その内容を「元に戻す先」にして、ユーザーの編集が巻き戻されないようにする。
 */
export function noteUserEdit(absPath: string): void {
  if (activeSnapshots.size === 0) return;
  const rel = path.relative(guardRoot, absPath);
  const content = existsSync(absPath) ? readFileSync(absPath, "utf-8") : null;
  for (const snap of activeSnapshots) {
    if (content === null) snap.delete(rel);
    else snap.set(rel, content);
    userEdited.get(snap)?.add(rel);
  }
}

function scanProtected(includeSolver = false): ProtectedSnapshot {
  const snap: ProtectedSnapshot = new Map();
  for (const pattern of PROTECTED_GLOBS) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: guardRoot, onlyFiles: true, dot: true })) {
      if (includeSolver || !ALLOWED.has(rel)) snap.set(rel, readFileSync(path.join(guardRoot, rel), "utf-8"));
    }
  }
  return snap;
}

/** 振り返りの前に呼ぶ。restoreProtectedFiles まで WebUI からの編集を追跡する */
export function snapshotProtectedFiles(opts: { includeSolver?: boolean } = {}): ProtectedSnapshot {
  const snap = scanProtected(opts.includeSolver);
  if (opts.includeSolver) includesSolver.add(snap);
  snapshotHeads.set(snap, git(["rev-parse", "HEAD"])?.trim() ?? null);
  userEdited.set(snap, new Set());
  activeSnapshots.add(snap);
  return snap;
}

/**
 * 保護対象の変更・追加・削除を元に戻し、戻したファイルの一覧を返す。
 * 戻す先はスナップショットの中身。ただしスナップショットの後に開発者がコミットしたファイルは、そのコミットの中身にする
 * （試合中に開発したコミットが、試合の終わりに巻き戻されていた）。戻す前の中身は var/edit-guard-backup/ に残す。
 */
export function restoreProtectedFiles(before: ProtectedSnapshot): string[] {
  activeSnapshots.delete(before);
  const withSolver = includesSolver.has(before);
  const after = scanProtected(withSolver);
  const committed = committedSince(before);
  const edited = userEdited.get(before) ?? new Set<string>();
  const rels = new Set([...before.keys(), ...after.keys(), ...[...committed.keys()].filter((r) => isProtected(r, withSolver))]);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reverted: string[] = [];
  for (const rel of rels) {
    const target = committed.has(rel) && !edited.has(rel) ? (committed.get(rel) ?? null) : (before.get(rel) ?? null);
    const now = after.get(rel) ?? null;
    if (now === target) continue;
    const abs = path.join(guardRoot, rel);
    backup(stamp, rel);
    if (target === null) {
      if (existsSync(abs)) rmSync(abs);
      reverted.push(`${rel} (新規作成を削除)`);
    } else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, target, "utf-8");
      reverted.push(rel);
    }
  }
  return reverted;
}
