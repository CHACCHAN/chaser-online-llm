# Claude Code の隔離実行・メイン／サブ・自己進化

## 1. 隔離実行 (`src/agent/claude-env.ts`)

- 実行バイナリは `./node_modules/.bin/claude`（`@anthropic-ai/claude-code`）。ホストの `~/.claude` は使わない。
- `HOME` と `CLAUDE_CONFIG_DIR` を `var/claude-home/` に向け、初回に onboarding 済みの `.claude.json` を作る。
- ゲートウェイは `LLM_API_URL` を `ANTHROPIC_BASE_URL` に渡す（末尾の `/v1` は除去。空なら Anthropic API に直接）。Anthropic 互換の `/v1/messages` を持つものなら何でもよい。
- 鍵の送り方は `LLM_API_AUTH`（`src/agent/llm-auth.ts`）。モデル一覧（`GET /v1/models`）も同じ送り方:

  | `LLM_API_AUTH` | 送るもの | 向いている接続先 |
  |---|---|---|
  | `gravitee`（既定） | `x-api-key`・`Authorization: Bearer`・`X-Gravitee-Api-Key` の全部（`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_CUSTOM_HEADERS`） | Gravitee |
  | `x-api-key` | `x-api-key` だけ（`ANTHROPIC_API_KEY`） | Anthropic API に直接（`LLM_API_URL` は空でよい） |
  | `bearer` | `Authorization: Bearer` だけ（`ANTHROPIC_AUTH_TOKEN`） | LiteLLM・OpenRouter など |
  | `header` | `LLM_API_KEY_HEADER` の名前のヘッダだけ（`ANTHROPIC_CUSTOM_HEADERS`。Claude Code にはダミーの鍵を渡す） | Azure API Management（`Ocp-Apim-Subscription-Key`）・Kong（`apikey`）など |
  | `none` | 鍵を送らない | 認証の無いローカルのプロキシ |

  どの方式でも `LLM_API_EXTRA_HEADERS`（`"名前: 値; 名前: 値"`）を足して送る。開発者のシェルの `ANTHROPIC_*` は引き継がない。
- モデル: メインは `--model` / `LLM_MODEL_NAME`。`ANTHROPIC_MODEL` と `sonnet` / `opus` の各エイリアスを選択中のモデルに差し替え、ゲートウェイにない既定モデルが裏で呼ばれないようにする。サブは `--sub-model` / `LLM_SUB_MODEL_NAME`（空ならメインと同じ）で、`haiku` 系エイリアスと `CLAUDE_CODE_SUBAGENT_MODEL` に入る。
- effort: メインは `--effort` / `LLM_MODEL_EFFORT`、サブは `--sub-effort` / `LLM_SUB_MODEL_EFFORT`（空ならメインと同じ）。
- 起動引数の共通部分: `-p --output-format stream-json --verbose --dangerously-skip-permissions --disable-slash-commands`、さらに `--model`, `--effort`。全て `--input-format stream-json` で起動する。試合中のメインは `--system-prompt <main.md＋ルール(official-rules.md)＋コマンド(commands.md)＋方針＋strategy.md> --tools "" --no-session-persistence`（Claude Code 既定のシステムプロンプトとツール定義を送らない）、サブは `--append-system-prompt <sub.md> --no-session-persistence`。
- **説明書**: `CLAUDE.md` は開発者向けなので読ませない（`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`）。エージェント向けの説明書 `agent/AGENTS.md`（役割・触ってよい範囲・CLI・スコア規則）を、全セッションのシステムプロンプトの末尾に入れる（`ClaudeSession.buildArgs`）。
- モデル一覧は `GET /api/models`（`src/agent/models.ts`）でゲートウェイの `/v1/models` から取る。

## 2. セッション (`src/agent/claude-session.ts`)

- `ClaudeSession` は Claude Code を 1 プロセス起動し、ユーザメッセージを stdin の stream-json で流し込む。
- **試合中のメインは毎フェーズ使い捨て**（1回聞いたら閉じる。前の会話を持たない）。次のフェーズ用のプロセスは裏で先に起動しておく。**サブは依頼ごとに使い捨て**。試合後の振り返りはツールありの新しいセッション。
- `ask(text, timeoutMs)` は次のいずれかを返す。
  - `ok`: `result` イベントの本文
  - `timeout`: 時間切れ。メイン・サブは呼び出し側がプロセスを kill して消費を止める（入力分は直近の入力量で見積もってトークン上限の判定に含める）。
  - `busy`: 前の問い合わせがまだ終わっていない
  - `dead`: プロセスが終了した・送信できなかった・API エラー（思考ログに `API Error` として出る）
- 1 セッションにつき同時に 1 問い合わせだけ。
- 思考・本文・ツール呼び出し・ツール結果は `uiBus` に流れ、ダッシュボードの思考ログに出る（`[main]` / `[sub]` の接頭辞付き）。
- 実測（使い捨てメイン, gpt-6.2-astra/sol medium）: 1 フェーズ 5〜8 秒、入力 約5,800（13×13）〜7,000（39×39 全体マップ）トークンで一定。

## 3. メインエージェント (`src/agent/main-agent.ts`)

`MainAgent` は試合 1 回ごとに作られ、次を行う。

| メソッド | タイミング | 内容 |
| :--- | :--- | :--- |
| `begin(info)` | 入室前 | システムプロンプト（main.md＋ルール(official-rules.md)＋コマンド(commands.md)＋作戦方針＋strategy.md）を組み立て、サブを準備する。準備フェーズの結果（「開始」より前に `runPrepPhase` でツール Read/Glob/Grep ありのセッションに資料と過去の試合を読ませて作ったメモ。`prompts/prep.md`）から始める。最後に最初の問い合わせ用プロセスを先に起動する |
| `decide(ctx)` | 毎フェーズ | 盤面を `var/current/snapshot.json` に書き出し、メモ・直近の経過・サブへの依頼（TODO）・全体マップ（座標目盛り・敵・作戦目標つき）・現在の作戦・ソルバー候補・目標候補・合法手・サブ結果を1通のメッセージで渡す。返答の JSON を採用し、`memo` があればメモを置き換える |
| `postMatch(report, runDir, timeoutMs)` | 試合後 | サブを止めて（保護ファイルを戻して）から、ツールありの新しいセッションに最終メモ・経過・TODO・診断を渡して振り返りと改修をさせる（上限 15 分） |

### 応答の契約

メインは本文の後の最後の行に次の JSON を 1 行で返す（`prompts/main.md`）。

```json
{"turn": 12, "phase": "CMD2", "action": "plan", "target": [3, -2], "note": "未探索の広い区画へ", "delegate": "...", "memo": "次のフェーズの自分への引き継ぎ（全文）"}
```

| `action` | 意味 | 必要な項目 |
| :--- | :--- | :--- |
| `continue` | 今の作戦のまま。ソルバーが「continue した場合の手」を打つ | なし |
| `plan` | 作戦を変える。ソルバーは `target` へ向かう最初の一歩を優先する | `target: [x, y]`（メッセージの pos と同じ座標系） |
| `command` | 手を直接指定する（罠回避や緊急時のみ） | `command`（合法手のいずれか） |

- `delegate`（任意・どの action にも付けられる）: サブへの依頼文。サブは裏で作業し、結果は後のターンに「サブ結果」として届く。
- `memo`（任意）: メモ全体を置き換える（`AGENT_MEMO_MAX_CHARS` 字まで。超えたら切って次のフェーズに知らせる）。`var/current/MEMO.md` にも書き出す。
- `memo_set`（任意）: メモの行を番号で書き換える `{"3": "新しい内容", "5": ""}`（`""` は削除）。依頼文のメモには `3| ` の形で行番号を付ける（メモには入れない。書き写されても取り除く）。
- `memo_add`（任意）: メモの末尾に1行足す。上限を超える時は入れず、次のフェーズに知らせる。メモ全文を毎フェーズ書き直すと出力が長くなり返答が遅くなる（実測 room719 gpt-6.2-sol: メモ約1000字の返答で15〜20秒、約100字で2〜4秒）ため、追記だけで済むようにした。依頼文のメモ見出しに今の字数／上限を出す。
- 解析は後ろの行から、行全体を JSON として読む（memo に `{}` があってもよい。```` ```json ```` 囲みも可）。`turn` / `phase` が付いていれば現在のターンと一致しなければならない。該当がなければ「応答に有効な JSON がない」としてソルバー手を使う。

### 作戦 (plan) の追跡

- `plan` は `MainAgent` が保持し、以後のフェーズでソルバーに渡す。
- 毎フェーズ `WorldMap.firstStepTowards` で判定する。目標に到達すると「到達」、到達できなければ「到達不能」として作戦を解除し、次のメッセージでメインに知らせる。
- `begin()` で作戦は解除される（試合開始時は `null`）。
- ワープ等でローカル座標系が変わったら（`WorldMap.frameVersion`）作戦を解除し、メモ・経過の座標が古いことをメッセージで知らせる。敵の目撃位置も捨てる。
- 作戦目標があるフェーズは、送る手が目標へ向かうか（`followed`）・目標へ経路が無いか（`no_route`）・ソルバーが別の手を選んだか（`other`）を判定し、`mainActions`（例 `CMD1:plan(no_route)`）・直近の経過・WebUI のメモ欄に出す（以前は経路が無くても「作戦変更」とだけ記録していた）。

### メッセージの補足
- **手の行き先**: 動く合法手ごとに行き先のマスの値と観測元（自=自分の観測と何ターン前か・W=Webマップ・?=未観測）、罠・通行不可の印を出す。
- **通知・サブ結果は正常な返答の後で届けたことにする**。時間切れ・不正な返答のフェーズに載ったものは次のフェーズにもう一度出す（以前は見せた時点で消え、時間切れで失われていた）。通知は20件まで。
- サブ結果には依頼時のターン・区画・座標世代を添え、その後ワープしていれば「結果の座標は今の座標系と違う」と書く。

### ソルバー手にフォールバックする条件

| 条件 | 扱い |
| :--- | :--- |
| `turnBudgetSec`（既定 20 秒）を超えた | ソルバー手を送信。プロセスは kill して返答は捨てる。`AGENT_HEDGE_SEC`（既定15秒）たっても返らなければ、先に起動しておいたもう1つのプロセスにも同じ問い合わせを送り、先に正常に返った方を使う（ゲートウェイの詰まりで 3,158 フェーズ中 113 回が時間切れになっていた）。回数は使用量の `hedges` |
| 1試合のトークン上限（`AGENT_MATCH_TOKEN_LIMIT`）に到達 | 以降ソルバー手のみ |
| プロセスが死んでいる（dead） | ソルバー手 |
| 応答が不正（JSON なし、合法手でない、ターン不一致） | ソルバー手 |

ソルバー手を使ったターンは `solverFallbackNotes` に残る。

## 4. サブエージェント (`src/agent/sub-worker.ts`)

- `SubWorker` は試合ごとに 1 つ作られ、メインの `delegate` を受けてキューに積んだ依頼を順に処理する。**依頼ごとに新しいセッション**（ツールあり・保存なし）で、前の依頼の会話は持たない（`var/current/MEMO.md`・`ASK_SUB.md` を読める）。
- 1 件の上限は `AGENT_SUB_TASK_TIMEOUT_MIN`（既定 10 分）。超えたらプロセスを kill する。試合終了時は作業中・待機中の依頼を中止する。
- 依頼の一覧（TODO）は毎フェーズのメインへのメッセージに付き、全文と結果は `var/current/ASK_SUB.md` に書き出す。
- 依頼の状態は `queued` / `running` / `done` / `failed` で、ダッシュボードの `subTasks` に出る。
- 完了した結果は `takeFinished()` で一度だけメインに渡る（次のフェーズのメッセージ、または試合後の `postMatch` に含まれる）。メインは結果を待たない。
- 仕事の例: ログ分析、未知タイルの得点推定と `knowledge/tiles.json` への登録、公式サイトの調査、素材収集、`agent/tools/` のツール作成と動作確認。
- 制約（`prompts/sub.md`）: `src/`（ソルバー含む）・`agent/prompts/`・`agent/policies/`・`agent/AGENTS.md`・`agent/REVIEW.md`・`.env`・`CLAUDE.md` は編集しない。試合開始時にスナップショットを取り、試合終了時に変更を元に戻す（`edit-guard.ts`）。CHaserOnline サーバにはログインしない。`.env` の値を出力・送信しない。
- 旧方式（Claude Code 内蔵の `--agents` によるサブ定義）は廃止した。

## 5. 試合後の進化 (`src/evolve.ts`)

1. 改修前の `active-solver.ts` を退避する。
2. `postMatch` に診断レポート（`diagnosis.md`）と run ディレクトリを渡す。試合中の会話は残っていないので、最終メモ・直近の経過・サブへの依頼と結果（`MEMO.md`・`ASK_SUB.md`）を一緒に渡す。編集してよいのは active-solver.ts（とテスト）・knowledge/・agent/tools/ だけで、それ以外（ハーネス・プロンプト・作戦方針・`.env`・手順書）の変更は元に戻す。WebUI からのユーザー編集は戻さない。
3. メインは改修後、臨時ツール（`@temporary`）を「ソルバーへ組込む／正式ツールにする（`@temporary` を外す）／削除する」のいずれかに決める。判明したタイル得点・ルールは `knowledge/` に残す。
4. 改修後、`verifySolverWithReplay(runDir)` で検証する。
5. 検証に失敗したら退避したコードへ戻す（自動ロールバック）。
   - 振り返りの前に `var/evolution-pending.json` と改修前のソルバー（`var/evolution-backup.ts`）を残し、終わったら消す。ハーネスの再起動・例外で途切れたら、次の起動（`bun run start` / `bun run play`）でリプレイ検証し直し、不合格なら改修前に戻す（`src/evolution/pending.ts`、`summary.json` の `evolution.interrupted`）。レビュー中に途切れた時は検証済みのソルバーへ戻す。
   - 試合中のサブは、試合が終わった直後（`runner.ts`、solver-snapshot を残す前）に止め、プロセスが終わるのを待ってから範囲外の編集を戻す（`MainAgent.stopSub`）。退避する「改修前のコード」にサブの編集は混ざらない。
6. 最高得点を出した試合のソルバー（改修前の、実際に試合で使ったもの）は、試合直後に runner が `var/best-solvers/room<N>.ts` にコピーし、`room-profiles.json` を更新する（振り返りの有無・検証結果に関係なく）。
7. `summary.json` に `evolution: { solverChanged, replayVerified, rolledBack }` を追記し、`evolution-report.md` を書く。
8. **ハーネスへのレビュー**（`AGENT_REVIEW`）: 振り返りと同じ会話（経験を持ったまま）で、ハーネスの使いにくかった点・不具合らしきもの・欲しい機能・対応済みの確認を聞く（`reviewHarness`、上限 `AGENT_REVIEW_TIMEOUT_SEC`）。レビュー中の編集はソルバーも含めて元に戻す。返答は `agent/REVIEW.md`（新しい順、`AGENT_REVIEW_KEEP` 件まで）と `runs/<runId>/harness-review.md` に入る。開発者は開発前に読み、対応したら `[対応済み]` を付ける。

## 6. リプレイ検証の意味 (`src/evolution/replay-verifier.ts`)

`turns.jsonl` の観測を順に新しいソルバーへ与え、次を確かめる。

- `decideTurnAction` が例外を投げないこと
- CMD1 / CMD2 が合法手を返すこと
- 試合を最後まで再生できること
- **罠へ動く手が増えていないこと**: 改修前のソルバー（試合後の改修では改修前のコード、CLI の `verify` ではその試合の `solver-snapshot.ts`）にも同じ地図で手を選ばせ、その時点の地図で罠と分かっているマスへ動く手の回数（`hazardLandings` / `baselineHazardLandings`）を比べる。新しい方が多ければ不合格で、試合後の改修は自動で元に戻る。改修前のコードは相対 import が効くよう `src/solver/` に一時ファイルとして置いて読み込み、すぐ消す。

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
| `reference [--query <q>] [--tile <id>] [--url <u>]` | ローカルの `tiles.json` と公式サイトを検索 |
| `upsert-tile --id <id> --score <s> [--name --label --passable --hazard --symbol --notes]` | `knowledge/tiles.json` にタイルを登録・更新（`source: inferred`。`measured` のタイルの得点は変えない） |
| `tile-scores --run-dir <dir>` | その試合の `turns.jsonl` から、Webマップの公式のアイテム得点で測ったタイルの得点を出す（読むだけ） |
| `verify [--run-dir <dir>]` | リプレイ検証。失敗時は終了コード 1 |
| `cells --room <n> [--near x,y --radius r]` | ワープの実測（絶対座標）とマスのメモ |
| `cell-note --room <n> --x <x> --y <y> --note <text>` | マスにメモを足す（空で消す） |

ツールは `agent/tools/<name>.ts` に書き、`bun agent/tools/<name>.ts` で実行する（規約は `agent/tools/README.md`。出力は JSON 1 行、2 秒以内を目安）。`create-tool` は廃止した。

## 9. 制約と既知の課題

- 改修の良し悪しは自動では判定しない。`evolution-report.md` と次回の試合の得点で人が見る。
- メインの判断率（`turns.jsonl` の `cmd*Source === "main"`、`mainActions`）が低いときは、予算・effort・プロンプトを見直す。
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
- **マスのメモ**: サブ・振り返りが `bun src/cli.ts cell-note --room N --x X --y Y --note "…"` で書く。座標は snapshot の `position` と同じ座標で受け、`globalPosition` との差で絶対座標に直して保存する（`--abs` で絶対座標をそのまま）。1件160字まで、メインには80字で切って見せる。最初の版は絶対座標を求めていたが、サブが今の区画の座標で書いてしまい、試合をまたいで使えないメモが10件できた。
- **ワープの記録はワープのタイル（20〜23・30〜33・40〜43・50〜53・60〜63）から入ったものだけ**。最初の版では誤検知・位置合わせ前のずれで、77・79・71・1 から入った「ワープ」も記録されていた（room719 の T2 の誤検知が (0,38)→(11,10) として残った）。引くのは `bun src/cli.ts cells --room N [--near x,y --radius r]`（タイル番号ごとの飛び方 `tileJumps` も出る。公式の「番号ごとに決まった方向・距離」と照合する用）。
- **試合中のメイン**: 今の位置から `AGENT_KNOWN_CELLS_RADIUS` マス以内の記録を、今の pos と同じ座標（`[ ]` に絶対座標）で毎フェーズ見せる。Webマップで位置合わせできていない時は、この試合で入ったワープ（今の区画）だけ。

### エージェントのツール
- サブ・試合後の振り返りに渡すツールは `Bash,Read,Edit,Write,Glob,Grep`（`claude-session.ts` の `AGENT_WORK_TOOLS`）。指定しないと ListAgents・SendMessage まで使え、同じマシンの別の Claude Code セッションへメッセージを送れてしまう（11/20 に試合中のメインがサブと話そうとして使った記録がある）。
- エージェント（準備・サブ・振り返り）のツール呼び出しは `var/agent-tool-log.jsonl` に1行ずつ残す（場面・ラベル・ツール・コマンドの先頭）。使われている機能・使われていない機能を調べる用。

### 依頼時の盤面（`var/current/sub-snapshots/task-N.json`）
- 依頼した時の盤面（snapshot）を依頼ごとにファイルに残し、依頼文に「依頼時の盤面: そのファイル（T・区画・座標世代）」を添える。`var/current/snapshot.json` は毎フェーズ変わり、サブが読む頃には別の盤面（ワープ後は別の座標系）になっていることがあった。

### サブの同時実行（`AGENT_SUB_CONCURRENCY`、既定 5）
- 依頼ごとに別のセッションを起動し、5件まで同時に動かす。超えた依頼は待機し、空いたら古い順に始める（待機の上限は無い）。
- 以前は1件ずつ処理していたので、メインが毎フェーズ依頼すると待ちが溜まった（deepseek-v4.1-flash で 163 ターン中 140 件依頼し、待機 106 件）。メインは前の会話を持たず、サブが動いていることを知らないまま依頼し直していた。
- メインへの TODO の見出しに、作業中の仕事と経過秒・待機の件数・1件あたりの平均時間・同時に動かせる数を出す。
