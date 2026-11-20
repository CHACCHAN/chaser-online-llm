# Claude Code の隔離実行・常駐メインエージェント・自己進化

## 1. 隔離実行 (`src/agent/claude-env.ts`)

- 実行バイナリは `./node_modules/.bin/claude`（`@anthropic-ai/claude-code`）。ホストの `~/.claude` は使わない。
- `HOME` と `CLAUDE_CONFIG_DIR` を `var/claude-home/` に向け、初回に onboarding 済みの `.claude.json` を作る。
- ゲートウェイは `LLM_API_URL` を `ANTHROPIC_BASE_URL` に渡し（末尾の `/v1` は除去）、`LLM_API_KEY` を `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` と `X-Gravitee-Api-Key` ヘッダに渡す。
- モデル指定: `ANTHROPIC_MODEL` と、`sonnet` / `opus` / `haiku` の各エイリアスを選択中のモデルに差し替える。ゲートウェイにない既定モデルが裏で呼ばれないようにするため。サブエージェントのモデルは `LLM_SUB_MODEL_NAME`（空ならメインと同じ）。
- 起動引数の共通部分: `-p --output-format stream-json --verbose --dangerously-skip-permissions --disable-slash-commands`、さらに `--model`, `--effort`。常駐時は `--input-format stream-json` を足す。
- モデル一覧は `GET /api/models`（`src/agent/models.ts`）でゲートウェイの `/v1/models` から取る。

## 2. 常駐セッション (`src/agent/claude-session.ts`)

- `ClaudeSession` は Claude Code を 1 プロセスで起動したままにし、ユーザメッセージを stdin の stream-json で流し込む。文脈は同じプロセス内に残る。
- `ask(text, timeoutMs)` は次のいずれかを返す。
  - `ok`: `result` イベントの本文
  - `timeout`: 時間切れ。ただし Claude の処理は止めない。遅れて届いた結果は「Late Result (discarded)」として記録するだけで、手には使わない。
  - `busy`: 前の問い合わせがまだ終わっていない
  - `dead`: プロセスが終了した
- 同時に 1 問い合わせだけ。前の処理が続いている間、新しいフェーズは「busy」となり、ソルバー手で進む。
- 思考・本文・ツール呼び出し・ツール結果は `uiBus` に流れ、ダッシュボードの思考ログに出る。
- 実測: 起動の準備（ウォームアップ）約 6 秒、1 手約 2〜5 秒（計測条件は `agent/SETUP.md` の「既知の事実」を参照）。

## 3. メインエージェント (`src/agent/main-agent.ts`)

`MainAgent` は試合 1 回ごとに作られ、次の 3 つを行う。

| メソッド | タイミング | 内容 |
| :--- | :--- | :--- |
| `begin(info)` | 入室前 | セッションを起動し、`knowledge/strategy.md` と `knowledge/tiles.json` を読んで「READY」と返させる（制限 90 秒） |
| `decide(ctx)` | 毎フェーズ | 盤面を `var/current/snapshot.json` に書き出し、ASCII 盤面・候補手・高得点目標・最寄りの未探索点・合法手をメッセージで渡す。返答末尾の JSON を採用する |
| `postMatch(report, runDir, timeoutMs)` | 試合後 | 同じセッションで振り返りと改修をさせる（上限 15 分） |

### 応答の契約

メインは最後の行に次の JSON を 1 行で返す。

```json
{"turn": 12, "phase": "CMD2", "command": "wr", "reason": "高得点マスへ"}
```

- `command` は合法手（CMD1 は 5 種、CMD2 は 24 種）のいずれかでなければならない。
- `turn` と `phase` が付いていれば、現在のターンと一致しなければならない。
- 解析は本文中の `{...}` を後ろから探す。該当がなければ「応答に有効な JSON がない」としてソルバー手を使う。

### ソルバー手にフォールバックする条件

| 条件 | 扱い |
| :--- | :--- |
| `turnBudgetSec`（既定 20 秒）を超えた | ソルバー手を送信。返答は捨てる（セッションは動き続ける） |
| 前の問い合わせが未完了（busy） | ソルバー手 |
| プロセスが死んでいる（dead） | ソルバー手 |
| 応答が不正（JSON なし、合法手でない、ターン不一致） | ソルバー手 |

ソルバー手を使ったターンは `solverFallbackNotes` と `skipped` に残り、次の「TURN」メッセージで「前回以降にソルバーが打った手」として再通知される。

### サブエージェント `sub`

`--agents` で定義した汎用サブエージェント。ログ分析、タイル調査、公式サイトの調査、素材集め、`agent/tools/` のツール作成を任せる。`src/solver/active-solver.ts` は編集しない（メインの担当）。

## 4. 試合後の進化 (`src/evolve.ts`)

1. 改修前の `active-solver.ts` を退避する。
2. `postMatch` に診断レポート（`diagnosis.md`）と run ディレクトリを渡す。セッションは試合中の文脈を持っている。
3. 改修後、`verifySolverWithReplay(runDir)` で検証する。
4. 検証に失敗したら退避したコードへ戻す（自動ロールバック）。
5. 検証に通り、そのルームの最高得点を出した試合なら `var/best-solvers/room<N>.ts` にコピーし、`room-profiles.json` を更新する。
6. `summary.json` に `evolution: { solverChanged, replayVerified, rolledBack }` を追記し、`evolution-report.md` を書く。

### リプレイ検証の意味

`replay-verifier.ts` は `turns.jsonl` の観測を順に新しいソルバーへ与え、次を確かめる。

- `decideTurnAction` が例外を投げないこと
- CMD1 / CMD2 が合法手を返すこと
- 試合を最後まで再生できること

「変わったターン数」（`changedCmd1Count` など）は集計しているだけで、改善を示すものではない。得点の改善は次の試合の結果で判断する。`turns.jsonl` がない場合は、スモークテスト（ダミー盤面 1 手）だけを行う。

## 5. ソルバー (`src/solver/active-solver.ts`)

- `decideTurnAction(worldMap, phase, turn)` を export する。この署名は維持する。
- CMD1: 隣接マスの得点から `gru/grd/grl/grr` を選ぶ。安全なプラス得点マス（または目的地方向の安全マス）がなければ `gr`。`gr` は静止しても現在地（穴）への再着地で -20 かかるため、その分も見積もる。
- CMD2: 候補方向ごとに「即時得点 − 訪問回数ペナルティ − 逆走ペナルティ + 目的地へのボーナス」を比べて `w*` を選ぶ。周囲が穴や罠だけのときは桂馬飛び `kei*` を検討する。
- 未知タイルが出た場合は `triggerHarness` を立てる（メインの相談理由になる）。

## 6. CLI (`bun src/cli.ts`)

| サブコマンド | 用途 |
| :--- | :--- |
| `scrape-map --room <n> [--url <u>]` | Web マップを取得し、結果を JSON で表示 |
| `reference [--query <q>] [--tile <id>] [--url <u>]` | ローカルの `tiles.json` と公式サイトを検索 |
| `upsert-tile --id <id> --score <s> [--name --label --passable --hazard --symbol --notes]` | `knowledge/tiles.json` にタイルを登録・更新（`source: inferred`） |
| `run-script --snapshot <file> --code "<JS>"` | 盤面スナップショットに対して JS を実行（2.5 秒で打ち切り） |
| `verify [--run-dir <dir>]` | リプレイ検証。失敗時は終了コード 1 |
| `status [--room <n>]` | ルームの成績とタイル数 |

`create-tool` は廃止した。ツールは `agent/tools/<name>.ts` に書き、`bun agent/tools/<name>.ts` で実行する（規約は `agent/tools/README.md`）。

## 7. 制約と既知の課題

- 改修の良し悪しは自動では判定しない。`evolution-report.md` と次回の試合の得点で人が見る。
- メインの判断率（`turns.jsonl` の `cmd*Source === "main"`）が低いときは、予算・effort・プロンプトを見直す。
- サーバの制限時間は公開されていない。過去ログでは約 25 秒の遅延でも切断されなかったが、計測は未完了（`agent/SETUP.md` 1-4）。
- タイル得点は公式根拠がない。`knowledge/tiles.json` は実測値として扱う（[chaser-protocol.md](chaser-protocol.md)）。
