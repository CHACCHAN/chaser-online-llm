/**
 * ハーネスが起動する Claude Code（HOME=var/claude-home に隔離）を Claude のサブスクリプションにログインさせる。
 *   bun run claude-login          # ブラウザでログイン（表示される URL を開き、コードを貼る）
 *   bun run claude-login status   # ログインの状態
 *   bun run claude-login logout
 * ログインの代わりに、`claude setup-token` で作ったトークンを .env の LLM_OAUTH_TOKEN に入れてもよい。
 * 使うには .env の LLM_AUTH_MODE=subscription。開発に使っている Claude Code（~/.claude）のログインとは別。
 */
import { buildClaudeEnv, CLAUDE_BINARY } from "../src/agent/claude-env";

const sub = Bun.argv[2] ?? "login";
const args = sub === "status" ? ["auth", "status", "--text"] : sub === "logout" ? ["auth", "logout"] : ["auth", "login", "--claudeai"];
// API の鍵・トークンは渡さない（サブスクリプションのログインだけを扱う）
const env = buildClaudeEnv({});
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[k];
const p = Bun.spawn([CLAUDE_BINARY, ...args], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await p.exited);
