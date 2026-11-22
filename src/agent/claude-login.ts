import { buildClaudeEnv, CLAUDE_BINARY } from "./claude-env";
import { resolveLlmAuth } from "./llm-auth";

/**
 * ハーネスの Claude Code（HOME=var/claude-home）を Claude のサブスクリプションにログインさせる（WebUI から）。
 * `claude auth login --claudeai` を起こし、表示されたログイン用 URL を画面に出す。ユーザーがブラウザでログインして
 * 表示されたコードを画面に貼ると、それをプロセスの標準入力に送る。開発に使う Claude Code（~/.claude）のログインとは別。
 */
export type LoginState = "idle" | "starting" | "waiting_code" | "verifying" | "done" | "failed";

export interface ClaudeAuthStatus {
  mode: "api" | "subscription";
  /** var/claude-home にログイン済みか（LLM_OAUTH_TOKEN を使う時は確かめない） */
  loggedIn: boolean | null;
  authMethod: string | null;
  /** LLM_OAUTH_TOKEN が入っている（ログインの代わりにこれを使う） */
  tokenSet: boolean;
  login: { state: LoginState; url: string | null; error: string | null; startedAt: number | null };
}

/** ログインの待ち時間の上限（URL を開いてコードを貼るまで） */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_RE = /https:\/\/\S+\/oauth\/authorize\?\S+/;

/** API の鍵・トークンを渡さない環境（サブスクリプションのログインだけを扱う）。ブラウザは開かせない */
function loginEnv(): Record<string, string> {
  const env = buildClaudeEnv({});
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[k];
  return { ...env, BROWSER: "true" };
}

/** 出力の最後の意味のある行（失敗の理由として出す）。URL は出さない */
function lastLine(out: string): string {
  const lines = out
    .replace(URL_RE, "")
    .split(/\r?\n|>\s/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Paste code|^Opening browser|^If the browser/.test(l));
  return (lines.at(-1) ?? "").slice(0, 300);
}

export class ClaudeLoginManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private state: LoginState = "idle";
  private url: string | null = null;
  private error: string | null = null;
  private startedAt: number | null = null;
  private out = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly binary = CLAUDE_BINARY, private readonly envFn = loginEnv) {}

  get login(): ClaudeAuthStatus["login"] {
    return { state: this.state, url: this.url, error: this.error, startedAt: this.startedAt };
  }

  /** ログインを始め、URL が出るまで待つ（最大 20 秒） */
  async start(): Promise<ClaudeAuthStatus["login"]> {
    this.cancel();
    this.state = "starting";
    this.url = null;
    this.error = null;
    this.out = "";
    this.startedAt = Date.now();
    const p = Bun.spawn([this.binary, "auth", "login", "--claudeai"], { env: this.envFn(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = p;
    const dec = new TextDecoder();
    const read = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) {
        this.out += dec.decode(c);
        const m = URL_RE.exec(this.out);
        if (m && this.state === "starting") {
          this.url = m[0];
          this.state = "waiting_code";
        }
      }
    };
    void read(p.stdout as ReadableStream<Uint8Array>);
    void read(p.stderr as ReadableStream<Uint8Array>);
    void p.exited.then((code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.timer) clearTimeout(this.timer);
      if (code === 0) {
        this.state = "done";
        this.error = null;
      } else if (this.state !== "idle") {
        this.state = "failed";
        this.error ??= lastLine(this.out) || `ログインが終わった（コード ${code}）`;
      }
      this.url = null;
    });
    this.timer = setTimeout(() => {
      if (this.proc === p) {
        this.error = "時間切れ（10分以内にコードを貼る）。もう一度「ログイン」から";
        p.kill();
      }
    }, LOGIN_TIMEOUT_MS);
    const t0 = Date.now();
    while (this.state === "starting" && Date.now() - t0 < 20_000) await Bun.sleep(100);
    if (this.state === "starting") {
      this.error = lastLine(this.out) || "ログイン用の URL が出なかった";
      this.cancel();
      this.state = "failed";
    }
    return this.login;
  }

  /** ブラウザでログインした後に表示されたコードを送り、結果を待つ（最大 60 秒） */
  async submitCode(code: string): Promise<ClaudeAuthStatus["login"]> {
    const c = code.trim();
    if (!this.proc || this.state !== "waiting_code") {
      this.error = "ログインを始めていない（先に「ログイン」）";
      return this.login;
    }
    if (!c || /\s/.test(c)) {
      this.error = "コードが空、または空白を含む";
      return this.login;
    }
    this.state = "verifying";
    this.error = null;
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(`${c}\n`);
    stdin.flush();
    const t0 = Date.now();
    while (this.state === "verifying" && Date.now() - t0 < 60_000) await Bun.sleep(200);
    if (this.state === "verifying") {
      this.error = "確認が返ってこない";
      this.cancel();
      this.state = "failed";
    }
    return this.login;
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.proc;
    this.proc = null;
    p?.kill();
    if (this.state === "starting" || this.state === "waiting_code" || this.state === "verifying") this.state = "idle";
    this.url = null;
  }

  /** ログアウト（var/claude-home のログイン情報を消す） */
  async logout(): Promise<void> {
    this.cancel();
    const p = Bun.spawn([this.binary, "auth", "logout"], { env: this.envFn(), stdout: "ignore", stderr: "ignore" });
    await Promise.race([p.exited, Bun.sleep(20_000)]);
    this.state = "idle";
    this.error = null;
  }

  async status(): Promise<ClaudeAuthStatus> {
    const auth = resolveLlmAuth();
    const tokenSet = auth.mode === "subscription" && "CLAUDE_CODE_OAUTH_TOKEN" in auth.claudeEnv;
    let loggedIn: boolean | null = null;
    let authMethod: string | null = null;
    try {
      const p = Bun.spawn([this.binary, "auth", "status", "--json"], { env: this.envFn(), stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 20_000);
      const st = JSON.parse(await new Response(p.stdout as ReadableStream<Uint8Array>).text()) as { loggedIn?: boolean; authMethod?: string };
      clearTimeout(timer);
      loggedIn = st.loggedIn === true;
      authMethod = typeof st.authMethod === "string" ? st.authMethod : null;
    } catch {
      // 確かめられない時は null
    }
    return { mode: auth.mode, loggedIn, authMethod, tokenSet, login: this.login };
  }
}

export const claudeLogin = new ClaudeLoginManager();
