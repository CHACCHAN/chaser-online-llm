import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../paths";
import { noteUserEdit, restoreProtectedFiles, snapshotProtectedFiles } from "./edit-guard";

test("振り返り中のエージェントの変更は戻し、WebUI からのユーザー編集は残す", () => {
  const policy = path.join(PROJECT_ROOT, "agent/policies/default.md");
  const env = path.join(PROJECT_ROOT, ".env");
  const origPolicy = readFileSync(policy, "utf-8");
  const origEnv = existsSync(env) ? readFileSync(env, "utf-8") : null;
  try {
    const snap = snapshotProtectedFiles();
    expect(snap.has("agent/policies/default.md")).toBe(true);
    if (origEnv !== null) expect(snap.has(".env")).toBe(true);
    // エージェントが方針を書き換えた → 戻される
    writeFileSync(policy, `${origPolicy}\n- エージェントが勝手に追加\n`);
    // ユーザーが WebUI で .env を編集した → 残る
    if (origEnv !== null) {
      writeFileSync(env, `${origEnv}\n# user edit\n`);
      noteUserEdit(env);
    }
    const reverted = restoreProtectedFiles(snap);
    expect(reverted).toContain("agent/policies/default.md");
    expect(readFileSync(policy, "utf-8")).toBe(origPolicy);
    if (origEnv !== null) expect(readFileSync(env, "utf-8")).toContain("# user edit");
  } finally {
    writeFileSync(policy, origPolicy);
    if (origEnv !== null) writeFileSync(env, origEnv);
  }
});
