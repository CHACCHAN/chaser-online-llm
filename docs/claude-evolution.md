# Claude Code の隔離実行・試合中の LLM・試合後の振り返り

## 1. 隔離実行 (`src/agent/claude-env.ts`)

- 実行バイナリは `./node_modules/.bin/claude`（`@anthropic-ai/claude-code`）。ホストの `~/.claude` は使わない。
- `HOME` と `CLAUDE_CONFIG_DIR` を `var/claude-home/` に向け、初回に onboarding 済みの `.claude.json` を作る。
- つなぎ方は `LLM_AUTH_MODE`（`src/agent/llm-auth.ts`）。開発者のシェルの `ANTHROPIC_*`・`CLAUDE_CODE_OAUTH_TOKEN` は引き継がない。
  - **`api`（既定）**: Anthropic 互換の API（`/v1/messages` を持つもの）。`LLM_API_URL` を `ANTHROPIC_BASE_URL` に渡す（末尾の `/v1` は除去。空なら Anthropic API に直接）。送るヘッダは `LLM_API_HEADERS` に `"名前: 値; 名前: 値"` で書き、`{KEY}` は `LLM_API_KEY` に置き換わる（既定 `x-api-key: {KEY}`）。`LLM_API_KEY` が空なら `{KEY}` を使うヘッダは送らない（鍵の無いローカル LLM。Anthropic 互換の `/v1/messages` を持つものなら使える）。`x-api-key` は `ANTHROPIC_API_KEY`、`Authorization: Bearer …` は `ANTHROPIC_AUTH_TOKEN`、それ以外は `ANTHROPIC_CUSTOM_HEADERS` として Claude Code に渡す（どちらも無ければ Claude Code にはダミーの鍵）。モデル一覧（`GET /v1/models`）も同じヘッダで取る。例: Anthropic 直接 `x-api-key: {KEY}` / LiteLLM・OpenRouter `Authorization: Bearer {KEY}` / Gravitee `x-api-key: {KEY}; X-Gravitee-Api-Key: {KEY}`。
  - **`subscription`**: Claude のサブスクリプション。`LLM_OAUTH_TOKEN`（`claude setup-token` で作る）を `CLAUDE_CODE_OAUTH_TOKEN` に渡す。空なら `var/claude-home` にログインした情報を使う（WebUI の 設定 › モデル・ゲートウェイ で `subscription` を選ぶと「Claude にログイン」が出る。ログインページの URL を開いて表示されたコードを貼ると、裏の `claude auth login` に渡る（`src/agent/claude-login.ts`）。端末からは `bun run claude-login`、状態は `bun run claude-login status`。開発に使う Claude Code の `~/.claude` のログインとは別）。モデルは `opus` / `sonnet` / `haiku` などの別名で選び、別名の差し替え（下記）はしない。ログインしていなければモデル一覧の取得がエラーで知らせる。
- モデル: `--model` / `LLM_MODEL_NAME`（学習の LLM は `LAB_COACH_MODEL`、空なら同じ）。`ANTHROPIC_MODEL` と `sonnet` / `opus` / `haiku` の各エイリアス・`CLAUDE_CODE_SUBAGENT_MODEL` を選択中のモデルに差し替え、ゲートウェイにない既定モデルが裏で呼ばれないようにする。
- コンテキスト: `LLM_CONTEXT_WINDOW`（例 `32768`・`128k`）→ `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`LLM_AUTO_COMPACT`（既定 true、false で `DISABLE_AUTO_COMPACT=1`）、`LLM_AUTO_COMPACT_PCT` → `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、`LLM_MAX_OUTPUT_TOKENS` → `CLAUDE_CODE_MAX_OUTPUT_TOKENS`。空なら Claude Code の既定。自動コンパクトが効くのは会話が伸びる準備・振り返り・学習の LLM。試合中の LLM は毎回新しい会話なので、1回の入力（UI のトークンの詳細「直近1回の入力」）がコンテキストに収まらない時は `AGENT_MEMO_MAX_CHARS`・`AGENT_RECENT_PHASES`・`AGENT_KNOWN_CELLS_RADIUS` を小さくする。書き方の誤りはモデル一覧のエラーに出る。
- effort: `--effort` / `LLM_MODEL_EFFORT`（学習の LLM は `LAB_COACH_EFFORT`、空なら同じ）。
- 起動引数の共通部分: `-p --output-format stream-json --verbose --dangerously-skip-permissions --disable-slash-commands`、さらに `--model`, `--effort`。全て `--input-format stream-json` で起動する。試合中の LLM は `--system-prompt <main.md＋ルール(official-rules.md)＋コマンド(commands.md)＋方針＋strategy.md> --tools "" --no-session-persistence`（Claude Code 既定のシステムプロンプトとツール定義を送らない）。
- **説明書**: `CLAUDE.md` は開発者向けなので読ませない（`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`）。エージェント向けの説明書 `agent/AGENTS.md`（役割・触ってよい範囲・CLI・スコア規則）を、全セッションのシステムプロンプトの末尾に入れる（`ClaudeSession.buildArgs`）。
- モデル一覧は `GET /api/models`（`src/agent/models.ts`）でゲートウェイの `/v1/models` から取る。

## 2. セッション (`src/agent/claude-session.ts`)

- `ClaudeSession` は Claude Code を 1 プロセス起動し、ユーザメッセージを stdin の stream-json で流し込む。
- **試合中の LLM は毎回使い捨て**（1回聞いたら閉じる。前の会話を持たない）。次の問い合わせ用のプロセスは裏で先に起動しておく。試合後の振り返り・学習の LLM はツールありの新しいセッション。
- `ask(text, timeoutMs)` は次のいずれかを返す。
  - `ok`: `result` イベントの本文
  - `timeout`: 時間切れ。試合中の LLM は呼び出し側がプロセスを kill して消費を止める（入力分は直近の入力量で見積もってトークン上限の判定に含める）。
  - `busy`: 前の問い合わせがまだ終わっていない
  - `dead`: プロセスが終了した・送信できなかった・API エラー（思考ログに `API Error` として出る）
- 1 セッションにつき同時に 1 問い合わせだけ。
- 思考・本文・ツール呼び出し・ツール結果は `uiBus` に流れ、ダッシュボードの思考ログに出る（`[main]` などの接頭辞付き）。
- 実測（使い捨ての試合中の LLM, gpt-6.2-astra/sol medium）: 1 フェーズ 5〜8 秒、入力 約5,800（13×13）〜7,000（39×39 全体マップ）トークンで一定。

## 3. 試合中の LLM (`src/agent/main-agent.ts`)

`MainAgent` は試合 1 回ごとに作られ、次を行う。手は待たない（手はいつも方策。[learning.md](learning.md)）。

| メソッド | タイミング | 内容 |
| :--- | :--- | :--- |
| `begin(info)` | 入室前 | システムプロンプト（main.md＋ルール(official-rules.md)＋コマンド(commands.md)＋作戦方針＋strategy.md）を組み立てる。準備フェーズの結果（「開始」より前に `runPrepPhase` でツール Read/Glob/Grep ありのセッションに資料と過去の試合を読ませて作ったメモ。`prompts/prep.md`）から始める。最後に最初の問い合わせ用プロセスを先に起動する |
| `syncFrame(worldMap)` | 毎フェーズ | 座標系の変化・作戦目標への到達を反映する（考え中でも） |
| `startBackground(ctx, onDone)` | 毎フェーズ（考え中でなければ） | 盤面を `var/current/snapshot.json` に書き出し、メモ・直近の経過・全体マップ（座標目盛り・敵・作戦目標つき）・現在の作戦・方策の今の手と理由・目標候補・知らせを1通のメッセージで裏で聞く。返答の `plan`・メモは届いた時に反映する（考えている間にワープで座標系が変わっていたら、その目標は使わない） |
| `settleBackground(ms)` | 試合の終わり | 裏の問い合わせが終わるのを上限まで待つ |
| `postMatch(report, runDir, timeoutMs)` | 試合後 | ツールありの新しいセッションに最終メモ・経過・診断を渡して振り返りと評価関数の改修をさせる（上限 15 分） |

### 応答の契約

LLM は本文の後の最後の行に次の JSON を 1 行で返す（`prompts/main.md`）。

```json
{"turn": 12, "phase": "CMD2", "action": "plan", "target": [3, -2], "note": "未探索の広い区画へ", "memo_add": "次の問い合わせへの引き継ぎ1行"}
```

| `action` | 意味 | 必要な項目 |
| :--- | :--- | :--- |
| `continue` | 今の作戦のまま（方策に任せる） | なし |
| `plan` | 作戦を変える。`target` が方策の目標の候補に入る | `target: [x, y]`（メッセージの pos と同じ座標系） |

- `memo`（任意）: メモ全体を置き換える（`AGENT_MEMO_MAX_CHARS` 字まで。超えたら切って次の問い合わせに知らせる）。`var/current/MEMO.md` にも書き出す。
- `memo_set`（任意）: メモの行を番号で書き換える `{"3": "新しい内容", "5": ""}`（`""` は削除）。依頼文のメモには `3| ` の形で行番号を付ける（メモには入れない。書き写されても取り除く）。
- `memo_add`（任意）: メモの末尾に1行足す。上限を超える時は入れず、次の問い合わせに知らせる。メモ全文を毎回書き直すと出力が長くなり返答が遅くなる（実測 room719 gpt-6.2-sol: メモ約1000字の返答で15〜20秒、約100字で2〜4秒）ため、追記だけで済むようにした。依頼文のメモ見出しに今の字数／上限を出す。
- 解析は後ろの行から、行全体を JSON として読む（memo に `{}` があってもよい。```` ```json ```` 囲みも可）。有効な JSON がなければ作戦は変えない。
- 以前あった `command`（手の直接指定）と `delegate`（サブへの依頼）は 2026-11-22 に外した。

### 作戦 (plan) の追跡

- `plan` は `MainAgent` が保持し、以後のフェーズで方策に渡す。
- 毎フェーズ `WorldMap.firstStepTowards` で判定する。目標に到達すると「到達」、到達できなければ「到達不能」として作戦を解除し、次のメッセージで知らせる。
- `begin()` で作戦は解除される（試合開始時は `null`）。
- ワープ等でローカル座標系が変わったら（`WorldMap.frameVersion`）作戦を解除し、メモ・経過の座標が古いことをメッセージで知らせる。敵の目撃位置も捨てる。
- 作戦目標があるフェーズは、送る手が目標へ向かうか（`followed`）・目標へ経路が無いか（`no_route`）・方策が別の手を選んだか（`other`）を判定し、`mainActions`（例 `CMD1:plan(no_route)`）・直近の経過・WebUI のメモ欄に出す。

### メッセージの補足
- **通知は正常な返答の後で届けたことにする**。時間切れ・不正な返答の問い合わせに載ったものは次の問い合わせにもう一度出す。通知は20件まで。

### 返答が使われない時

| 条件 | 扱い |
| :--- | :--- |
| `AGENT_TURN_BUDGET_SEC`（既定 20 秒）を超えた | プロセスは kill して返答は捨て、次のフェーズの盤面で聞き直す。`AGENT_HEDGE_SEC`（既定15秒）たっても返らなければ、先に起動しておいたもう1つのプロセスにも同じ問い合わせを送り、先に正常に返った方を使う（ゲートウェイの詰まりで 3,158 フェーズ中 113 回が時間切れになっていた）。回数は使用量の `hedges` |
| 1試合のトークン上限（`AGENT_MATCH_TOKEN_LIMIT`）に到達 | 以降は聞かない（方策だけ） |
| プロセスが死んでいる（dead）・応答が不正（JSON なし） | 作戦は変えない |

どの場合も手は方策が打ち続ける。

## 4. 試合後の振り返り (`src/evolve.ts`)

1. 改修前の評価関数 `src/solver/evaluator.ts` を `var/policy/evaluator-backup.ts` に控える。
2. `postMatch` に診断レポート（`diagnosis.md`）と run ディレクトリ、今の方策のこのルームに似せた地図での成績（`benchRoom`）を渡す。試合中の会話は残っていないので、最終メモ・直近の経過（`MEMO.md`）を一緒に渡す。編集してよいのは `evaluator.ts`・`knowledge/`・`agent/tools/` だけで、それ以外（ハーネス・プロンプト・作戦方針・`.env`・手順書）の変更は元に戻す（`edit-guard.ts`）。WebUI からのユーザー編集は戻さない。
3. 臨時ツール（`@temporary`）は「正式ツールにする（`@temporary` を外す）／削除する」のいずれかに決める。判明したタイル得点・ルールは `knowledge/` に残す。
4. 評価関数が変わっていたら、まず `verifyPolicyWithReplay(runDir)` でその試合の盤面で確かめる（下の 5）。通れば改修前と同じパラメータ・同じ地図（シミュレータ、`SIM_MAX_TURNS`）で比べる（`gateEvaluatorChange`）。どちらかに落ちた・読み込めない・例外なら控えから元に戻す。
5. ハーネスの再起動・例外で途切れたら、次の起動（`bun run start` / `bun run play`）で控え（`var/policy/evaluator-backup.ts`）があれば改修前に戻す（`recoverInterruptedEvolution`）。
6. `summary.json` に `evolution: { replayVerified, rolledBack, evaluatorChanged, evaluatorAccepted }` を追記し、`evolution-report.md` を書く（古い試合の記録には `solverChanged` が残っている）。
7. **方策の学習**（`runPostMatchTraining`、`TRAIN_AFTER_MATCH_MIN` 分、既定5。0 で無し）: 振り返りをしない時（`AGENT_EVOLVE=false`）も行う。はっきり良くなった時だけ `var/policy/params.json` に保存し、次の試合から使う。学習が終わると学習の LLM が動く（[learning.md](learning.md)、`LAB_COACH`）。
8. **ハーネスへのレビュー**（`AGENT_REVIEW`）: 振り返りと同じ会話（経験を持ったまま）で、ハーネスの使いにくかった点・不具合らしきもの・欲しい機能・対応済みの確認を聞く（`reviewHarness`、上限 `AGENT_REVIEW_TIMEOUT_SEC`）。レビュー中の編集は評価関数も含めて元に戻す。返答は `agent/REVIEW.md`（新しい順、`AGENT_REVIEW_KEEP` 件まで）と `runs/<runId>/harness-review.md` に入る。開発者は開発前に読み、対応したら `[対応済み]` を付ける。

## 5. 試合の記録の盤面での確かめ (`src/evolution/replay-verifier.ts`)

`turns.jsonl` の観測を順に今の方策（経路探索＋評価関数＋学習したパラメータ）へ与え、次を確かめる。

- 方策が例外を投げないこと
- CMD1 / CMD2 が合法手を返すこと
- 試合を最後まで再生できること
- **罠へ動く手が増えていないこと**: 改修前の評価関数（試合後の改修では控え、CLI の `verify` ではその試合の `evaluator-snapshot.ts`）でも同じ地図で手を選ばせ、その時点の地図で罠と分かっているマスへ動く手の回数（`hazardLandings` / `baselineHazardLandings`）を比べる。新しい方が多ければ不合格で、試合後の改修は自動で元に戻る。改修前のコードは相対 import が効くよう `src/solver/` に一時ファイルとして置いて読み込み、すぐ消す。

注意点:

- 作戦（`plan`）は再現しない（ターンログに plan を記録していないため）。
- 「変わったターン数」（`changedCmd1Count` など）は集計しているだけで、改善を示すものではない。得点の改善はシミュレータの比較と次の試合の結果で判断する。
- `turns.jsonl` がない場合は、スモークテスト（ダミー盤面 1 手）だけを行う（`bun run verify-policy`）。

## 6. CLI (`bun src/cli.ts`)

| サブコマンド | 用途 |
| :--- | :--- |
| `reference [--query <q>] [--tile <id>] [--url <u>]` | ローカルの `tiles.json` と公式サイトを検索 |
| `upsert-tile --id <id> --score <s> [--name --label --passable --hazard --symbol --notes]` | `knowledge/tiles.json` にタイルを登録・更新（`source: inferred`。`measured` のタイルの得点は変えない） |
| `tile-scores --run-dir <dir>` | その試合の `turns.jsonl` から、Webマップの公式のアイテム得点で測ったタイルの得点を出す（読むだけ） |
| `verify [--run-dir <dir>]` | 試合の記録の盤面での確かめ。失敗時は終了コード 1 |
| `sim` / `bench` / `train` | シミュレータで打たせる / 同じ地図で比べる / 学習する（[learning.md](learning.md)） |
| `cells --room <n> [--near x,y --radius r]` | ワープの実測（絶対座標）とマスのメモ |
| `cell-note --room <n> --x <x> --y <y> --note <text>` | マスにメモを足す（空で消す） |

ツールは `agent/tools/<name>.ts` に書き、`bun agent/tools/<name>.ts` で実行する（規約は `agent/tools/README.md`。出力は JSON 1 行、2 秒以内を目安）。

## 7. 制約と既知の課題

- 改修の良し悪しは、試合の記録での確かめとシミュレータの比較で自動で判定する。得点の改善は `evolution-report.md` と次回の試合の得点で人が見る。
- サーバの制限時間は公開されていない。実測では CMD1 を 120 秒遅らせても切断されなかった（上限は未確認。`knowledge/server.json`）。
- 同一ユーザーの二重ログインは拒否される。途中放棄後は約 5 分、ログインのみのセッションは約 12 分ロックされるため、`bun run play --login-wait-min` で待つ。
- タイル得点は公式根拠がない。`knowledge/tiles.json` は実測値として扱う（[chaser-protocol.md](chaser-protocol.md)）。

### タイルの得点の実測（`src/memory/tile-measure.ts`）
- Webマップには自分の公式の得点（`A: I: P: PD: T:`）が出る。取れるたびに、残りターン数（`turn=`）とアイテム得点（I:）を `turns.jsonl` の `webScore` に、そのターンに踏んだタイル（番号→回数）を `landed` に残す。
- 画面の残りターン数から「サーバの何ターン目の手の前か」を出し、隣り合う画面の I: の差を「踏んだ数×得点」の式にして、未知が1種類の式から順に解く。境目のずれ（−1・0・+1 ターン）は式が一番よく揃うものを採る。1つのタイルは推定3件以上・7割以上が一致した値だけ出す。
- 試合の終わり（振り返りの前）に `knowledge/tiles.json` へ `source: "measured"`・`measuredSamples` で残す。前の実測と同じ値なら推定の数を足し、違えば推定の多い方を残す。
- `getTileInfo` は推定が3件以上の measured の得点を最優先する（ワープ・ブラックスター・ジオーメタルの種類は番号で固定のまま）。`upsert-tile` では measured の得点を書き換えない。
- きっかけ: `tiles.json` がエージェントの推測で 61（ブラックスター）を「400点のジオメタル」としていて、deepseek の試合でブラックスターを狙い続けていた。過去の試合は公式結果が中断などで合わず、得点を確かめられなかった。

### ワープの記録とマスのメモ（`var/room-profiles.json` の `warps`・`cellNotes`）
- **自動記録**: ワープするたびに、入口と着地の両方の区画を Webマップで位置合わせできたら、絶対座標（Webマップの列・行）で `warps` に足す（同じ入口・着地は `count` を増やす）。Webマップのないルームは座標が区画ごとに変わるので試合をまたいでは残さない。
- **マスのメモ**: 振り返り・準備などが `bun src/cli.ts cell-note --room N --x X --y Y --note "…"` で書く。座標は snapshot の `position` と同じ座標で受け、`globalPosition` との差で絶対座標に直して保存する（`--abs` で絶対座標をそのまま）。1件160字まで、試合中の LLM には80字で切って見せる。最初の版は絶対座標を求めていたが、エージェントが今の区画の座標で書いてしまい、試合をまたいで使えないメモが10件できた。
- **ワープの記録はワープのタイル（20〜23・30〜33・40〜43・50〜53・60〜63）から入ったものだけ**。最初の版では誤検知・位置合わせ前のずれで、77・79・71・1 から入った「ワープ」も記録されていた（room719 の T2 の誤検知が (0,38)→(11,10) として残った）。引くのは `bun src/cli.ts cells --room N [--near x,y --radius r]`（タイル番号ごとの飛び方 `tileJumps` も出る。公式の「番号ごとに決まった方向・距離」と照合する用）。
- **試合中の LLM**: 今の位置から `AGENT_KNOWN_CELLS_RADIUS` マス以内の記録を、今の pos と同じ座標（`[ ]` に絶対座標）で毎フェーズ見せる。Webマップで位置合わせできていない時は、この試合で入ったワープ（今の区画）だけ。

### エージェントのツール
- 試合後の振り返り・学習の LLM に渡すツールは `Bash,Read,Edit,Write,Glob,Grep`（`claude-session.ts` の `AGENT_WORK_TOOLS`）。指定しないと ListAgents・SendMessage まで使え、同じマシンの別の Claude Code セッションへメッセージを送れてしまう（11/20 に試合中の LLM が別のセッションと話そうとして使った記録がある）。
- エージェント（準備・振り返り・学習の LLM）のツール呼び出しは `var/agent-tool-log.jsonl` に1行ずつ残す（場面・ラベル・ツール・コマンドの先頭）。使われている機能・使われていない機能を調べる用。
