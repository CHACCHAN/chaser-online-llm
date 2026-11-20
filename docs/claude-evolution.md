# Claude Code の隔離実行・常駐メイン／サブ・自己進化

## 1. 隔離実行 (`src/agent/claude-env.ts`)

- 実行バイナリは `./node_modules/.bin/claude`（`@anthropic-ai/claude-code`）。ホストの `~/.claude` は使わない。
- `HOME` と `CLAUDE_CONFIG_DIR` を `var/claude-home/` に向け、初回に onboarding 済みの `.claude.json` を作る。
- ゲートウェイは `LLM_API_URL` を `ANTHROPIC_BASE_URL` に渡し（末尾の `/v1` は除去）、`LLM_API_KEY` を `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` と `X-Gravitee-Api-Key` ヘッダに渡す。
- モデル: メインは `--model` / `LLM_MODEL_NAME`。`ANTHROPIC_MODEL` と `sonnet` / `opus` の各エイリアスを選択中のモデルに差し替え、ゲートウェイにない既定モデルが裏で呼ばれないようにする。サブは `--sub-model` / `LLM_SUB_MODEL_NAME`（空ならメインと同じ）で、`haiku` 系エイリアスと `CLAUDE_CODE_SUBAGENT_MODEL` に入る。
- effort: メインは `--effort` / `LLM_MODEL_EFFORT`、サブは `--sub-effort` / `LLM_SUB_MODEL_EFFORT`（空ならメインと同じ）。
- 起動引数の共通部分: `-p --output-format stream-json --verbose --dangerously-skip-permissions --disable-slash-commands`、さらに `--model`, `--effort`。常駐時は `--input-format stream-json` を足す。
- モデル一覧は `GET /api/models`（`src/agent/models.ts`）でゲートウェイの `/v1/models` から取る。

## 2. 常駐セッション (`src/agent/claude-session.ts`)

- `ClaudeSession` は Claude Code を 1 プロセスで起動したままにし、ユーザメッセージを stdin の stream-json で流し込む。文脈は同じプロセス内に残る。
- 試合中は 2 つのセッションが並ぶ（メイン `label=main`、サブ `label=sub`）。それぞれ独立したプロセス・文脈を持つ。
- `ask(text, timeoutMs)` は次のいずれかを返す。
  - `ok`: `result` イベントの本文
  - `timeout`: 時間切れ。ただし Claude の処理は止めない。遅れて届いた結果は「Late Result (discarded)」として記録するだけで、手には使わない。
  - `busy`: 前の問い合わせがまだ終わっていない
  - `dead`: プロセスが終了した
- 1 セッションにつき同時に 1 問い合わせだけ。
- 思考・本文・ツール呼び出し・ツール結果は `uiBus` に流れ、ダッシュボードの思考ログに出る（`[main]` / `[sub]` の接頭辞付き）。
- 実測（作戦係）: 起動の準備 約 6 秒、1 フェーズ 2〜4 秒。delegate を含むターンも 11 秒で返答。

## 3. メインエージェント (`src/agent/main-agent.ts`)

`MainAgent` は試合 1 回ごとに作られ、次を行う。

| メソッド | タイミング | 内容 |
| :--- | :--- | :--- |
| `begin(info)` | 入室前 | メインとサブを起動し、`strategy.md` と `tiles.json` を読ませて「READY」と返させる（制限 90 秒） |
| `decide(ctx)` | 毎フェーズ | 盤面を `var/current/snapshot.json` に書き出し、ASCII 盤面・現在の作戦・ソルバー候補・目標候補・合法手・サブ結果をメッセージで渡す。返答末尾の JSON を採用する |
| `postMatch(report, runDir, timeoutMs)` | 試合後 | 同じセッションで振り返りと改修をさせる（上限 15 分） |

### 応答の契約

メインは本文の後の最後の行に次の JSON を 1 行で返す（`prompts/main.md`）。

```json
{"turn": 12, "phase": "CMD2", "action": "plan", "target": [3, -2], "note": "未探索の広い区画へ", "delegate": "..."}
```

| `action` | 意味 | 必要な項目 |
| :--- | :--- | :--- |
| `continue` | 今の作戦のまま。ソルバーが「continue した場合の手」を打つ | なし |
| `plan` | 作戦を変える。ソルバーは `target` へ向かう最初の一歩を優先する | `target: [x, y]`（メッセージの pos と同じ座標系） |
| `command` | 手を直接指定する（罠回避や緊急時のみ） | `command`（合法手のいずれか） |

- `delegate`（任意・どの action にも付けられる）: サブへの依頼文。サブは裏で作業し、結果は後のターンに「サブ結果」として届く。
- 解析は本文中の `{...}` を後ろから探す。`turn` / `phase` が付いていれば現在のターンと一致しなければならない。該当がなければ「応答に有効な JSON がない」としてソルバー手を使う。

### 作戦 (plan) の追跡

- `plan` は `MainAgent` が保持し、以後のフェーズでソルバーに渡す。
- 毎フェーズ `WorldMap.firstStepTowards` で判定する。目標に到達すると「到達」、到達できなければ「到達不能」として作戦を解除し、次のメッセージでメインに知らせる。
- `begin()` で作戦は解除される（試合開始時は `null`）。

### ソルバー手にフォールバックする条件

| 条件 | 扱い |
| :--- | :--- |
| `turnBudgetSec`（既定 20 秒）を超えた | ソルバー手を送信。返答は捨てる（セッションは動き続ける） |
| 前の問い合わせが未完了（busy） | ソルバー手 |
| プロセスが死んでいる（dead） | ソルバー手 |
| 応答が不正（JSON なし、合法手でない、ターン不一致） | ソルバー手 |

ソルバー手を使ったターンは `solverFallbackNotes` に残る。

## 4. サブエージェント (`src/agent/sub-worker.ts`)

- `SubWorker` は試合ごとに 1 つ作られる常駐の Claude セッション。メインの `delegate` を受けて、キューに積んだ依頼を順に処理する。
- 1 件の上限は 10 分。タイムアウトした場合は、セッションが処理を終えるまで次の依頼を流さない。
- 依頼の状態は `queued` / `running` / `done` / `failed` で、ダッシュボードの `subTasks` に出る。
- 完了した結果は `takeFinished()` で一度だけメインに渡る（次のフェーズのメッセージ、または試合後の `postMatch` に含まれる）。メインは結果を待たない。
- 仕事の例: ログ分析、未知タイルの得点推定と `knowledge/tiles.json` への登録、公式サイトの調査、素材収集、`agent/tools/` のツール作成と動作確認。
- 制約（`prompts/sub.md`）: `src/solver/active-solver.ts` は編集しない。CHaserOnline サーバにはログインしない。`.env` の値を出力・送信しない。
- 旧方式（Claude Code 内蔵の `--agents` によるサブ定義）は廃止した。

## 5. 試合後の進化 (`src/evolve.ts`)

1. 改修前の `active-solver.ts` を退避する。
2. `postMatch` に診断レポート（`diagnosis.md`）と run ディレクトリを渡す。セッションは試合中の文脈（盤面の記憶、立てた作戦）を持っている。
3. メインは改修後、臨時ツール（`@temporary`）を「ソルバーへ組込む／正式ツールにする（`@temporary` を外す）／削除する」のいずれかに決める。判明したタイル得点・ルールは `knowledge/` に残す。
4. 改修後、`verifySolverWithReplay(runDir)` で検証する。
5. 検証に失敗したら退避したコードへ戻す（自動ロールバック）。
6. 検証に通り、そのルームの最高得点を出した試合なら `var/best-solvers/room<N>.ts` にコピーし、`room-profiles.json` を更新する。
7. `summary.json` に `evolution: { solverChanged, replayVerified, rolledBack }` を追記し、`evolution-report.md` を書く。

## 6. リプレイ検証の意味 (`src/evolution/replay-verifier.ts`)

`turns.jsonl` の観測を順に新しいソルバーへ与え、次を確かめる。

- `decideTurnAction` が例外を投げないこと
- CMD1 / CMD2 が合法手を返すこと
- 試合を最後まで再生できること

注意点:

- リプレイでは作戦（`plan`）を再現しない。ターンログに plan を記録していないため、新しいソルバーは plan なしで走る。
- 「変わったターン数」（`changedCmd1Count` など）は集計しているだけで、改善を示すものではない。得点の改善は次の試合の結果で判断する。
- `turns.jsonl` がない場合は、スモークテスト（ダミー盤面 1 手）だけを行う。

## 7. ソルバー (`src/solver/active-solver.ts`)

- `decideTurnAction(worldMap, phase, turn, plan = null)` を export する。第 4 引数は省略可能。この署名は維持する。
- CMD1: 隣接マスの得点から `gru/grd/grl/grr` を選ぶ。`plan` の最初の一歩があればそれを優先候補にする。安全なプラス得点マスがなければ `gr`。`gr` は静止しても現在地（穴）への再着地で -20 かかるため、その分も見積もる。
- CMD2: 候補方向ごとに「即時得点 − 訪問回数ペナルティ − 逆走ペナルティ + 目的地へのボーナス」を比べて `w*` を選ぶ。`plan` の最初の一歩には +400 の経路ボーナスが付く。周囲が穴や罠だけのときは桂馬飛び `kei*` を検討する。
- 未知タイルが出た場合は `triggerHarness` を立てる（メインへの情報になる）。

## 8. CLI (`bun src/cli.ts`)

| サブコマンド | 用途 |
| :--- | :--- |
| `scrape-map --room <n> [--url <u>]` | Web マップを取得し、結果を JSON で表示 |
| `reference [--query <q>] [--tile <id>] [--url <u>]` | ローカルの `tiles.json` と公式サイトを検索 |
| `upsert-tile --id <id> --score <s> [--name --label --passable --hazard --symbol --notes]` | `knowledge/tiles.json` にタイルを登録・更新（`source: inferred`） |
| `run-script --snapshot <file> --code "<JS>"` | 盤面スナップショットに対して JS を実行（2.5 秒で打ち切り） |
| `verify [--run-dir <dir>]` | リプレイ検証。失敗時は終了コード 1 |
| `status [--room <n>]` | ルームの成績とタイル数 |

ツールは `agent/tools/<name>.ts` に書き、`bun agent/tools/<name>.ts` で実行する（規約は `agent/tools/README.md`。出力は JSON 1 行、2 秒以内を目安）。`create-tool` は廃止した。

## 9. 制約と既知の課題

- 改修の良し悪しは自動では判定しない。`evolution-report.md` と次回の試合の得点で人が見る。
- メインの判断率（`turns.jsonl` の `cmd*Source === "main"`、`mainActions`）が低いときは、予算・effort・プロンプトを見直す。
- サーバの制限時間は公開されていない。実測では CMD1 を 120 秒遅らせても切断されなかった（上限は未確認。`knowledge/server.json`）。
- 同一ユーザーの二重ログインは拒否される。途中放棄後は約 5 分、ログインのみのセッションは約 12 分ロックされるため、`bun run play --login-wait-min` で待つ。
- タイル得点は公式根拠がない。`knowledge/tiles.json` は実測値として扱う（[chaser-protocol.md](chaser-protocol.md)）。
