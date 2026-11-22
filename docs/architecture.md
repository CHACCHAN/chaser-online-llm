# アーキテクチャ

## 全体像

手は毎フェーズ経路探索の方策（`src/solver/planner.ts`＋評価関数 `evaluator.ts`＋学習したパラメータ `var/policy/params.json`）がすぐ出す。試合中の LLM は手を待たせず裏で盤面を読み、作戦（`plan` の目標）だけを出す。試合後は LLM が振り返って評価関数を直し（確かめに落ちたら戻す）、シミュレータで方策を学習し、学習の LLM が学習環境を直す。方策・シミュレータ・学習の図と詳細は [learning.md](learning.md)。

2026-11-22 に、サブエージェント・LLM の返答を待って打つモード（`AGENT_ASYNC=false`）・古いソルバー（`active-solver.ts`、`PLAY_POLICY`）は外した。

```mermaid
flowchart LR
  subgraph Browser["ブラウザ (Web ダッシュボード)"]
    UI["index.html・lab.js<br/>試合・学習"]
  end

  subgraph App["bun src/index.ts (ハーネス本体)"]
    Loop["試合ループ<br/>index.ts"]
    Runner["runner.ts<br/>1試合・1フェーズの進行"]
    Policy["方策<br/>solver/planner.ts × evaluator.ts × params.json"]
    Main["MainAgent<br/>agent/main-agent.ts<br/>作戦係（裏で動く）"]
    World["WorldMap<br/>memory/world-map.ts"]
    Evolve["evolve.ts<br/>振り返り・評価関数の確かめ・学習"]
    Lab["sim/lab.ts・lab-coach.ts<br/>学習と学習の LLM"]
    Bus["uiBus + Bun.serve<br/>ui/"]
  end

  subgraph Claude["Claude Code (隔離 HOME)"]
    MainSess["試合中: 使い捨ての claude -p<br/>ツールなし・prompts/main.md"]
    Post["試合後: ツールありのセッション<br/>振り返り・レビュー"]
    Coach["学習の LLM<br/>prompts/lab-coach.md"]
  end

  FS[("knowledge/ ・ var/")]
  CHS["CHaserOnline003 サーバ"]
  GW["LLM ゲートウェイ<br/>LLM_API_URL"]

  UI <-- "SSE / REST" --> Bus
  Loop --> Runner
  Runner -- "毎フェーズすぐ手を決める" --> Policy
  Policy --> World
  Runner -. "startBackground（考え中でなければ）" .-> Main
  Main -- "JSON: continue / plan / memo" --> MainSess
  Main -. "plan の目標（届いた時から使う）" .-> Policy
  MainSess -- "stream-json" --> GW
  Runner -- "手を送信 / 観測を受信" --> CHS
  Runner -- "turns.jsonl" --> FS
  Evolve -- "postMatch: evaluator.ts を改修" --> Post
  Evolve -- "試合の記録で確かめ＋シミュレータで比べる。落ちたら戻す" --> Policy
  Evolve --> Lab
  Lab -- "学習ごとの統計" --> Coach
  Coach -- "evaluator.ts・sim-profiles.json・train-config.json" --> FS
```

### 役割分担

| 担当 | 何をするか | 何をしないか |
| :--- | :--- | :--- |
| 方策 (`planner.ts`＋`evaluator.ts`) | 毎フェーズ必ず手を出す（数ミリ秒）。`plan` の目標も目標の候補に入れる | 作戦の立案、試合中の改修 |
| 試合中の LLM (`main.md`) | 盤面・経過・メモを読み、数ターン先の作戦（`plan`）を出す。メモを次の問い合わせへ引き継ぐ | 手を打つ（手はいつも方策）、ツールを使う |
| 試合後の LLM（振り返り） | 診断を読み、評価関数 `evaluator.ts`・`knowledge/`・`agent/tools/` を直す。ハーネスへのレビュー | それ以外の `src/` の編集（edit-guard が戻す） |
| 学習の LLM (`lab-coach.md`) | 学習の統計を読み、評価関数・地図の作り方・学習のやり方を直す | 試合中に動く（試合が始まると止まる） |

## 試合のライフサイクル

1. **待機**: `src/index.ts` が Web ダッシュボードを起動し、「準備」が押されるまで待つ。
2. **準備（ルームに入らない）**: `runPrepPhase` が公式のバージョンを確認し、LLM がルール・このルームの過去の試合・作戦方針を読んで試合開始時のメモを作る（status=preparing → standby）。スタンバイOK になると「開始」が押せる。
2b. **開始**: 試合ごとに `MainAgent` を作り、`begin(info, 準備の結果)` でシステムプロンプト（main.md＋ルール(official-rules.md)＋コマンド(commands.md)＋作戦方針＋strategy.md）を組み立て、準備のメモから始め、最初の問い合わせ用プロセスを先に起動する。
3. **入室**: `Client` が `user/` にログインし、`RoomNumberCheck` で入室する。同一ユーザーの二重ログインは断られる（前の試合を停止・ターン上限で終えると約5分）ので、`CHASER_LOGIN_WAIT_MIN` の間 `CHASER_LOGIN_RETRY_SEC` ごとにやり直す（`src/client/login.ts`、停止ボタンで中断）。準備は入室できてから使い切る（入室できなければ残る）。
4. **試合**: `runner.ts` が `playPhase` を CMD1 → CMD2 の順に回す（後述）。
4b. **試合中の障害**: 方策・LLM の処理が例外を投げても、そのフェーズは安全な手（`pickSafeFallback`）で続ける。通信の一時的な失敗は、まだ送っていないフェーズを安全な手で1回送り直す。それでも失敗したら試合を終え、画面に「試合がエラーで終わった」を出す。
5. **試合後**: `summary.json` と `diagnosis.md` を書き、その試合の評価関数とパラメータを `evaluator-snapshot.ts`・`policy-params.json` に控える。`evolve.ts` が LLM に `postMatch` で振り返らせ（シミュレータでの成績を添える）、評価関数が変わっていたら、その試合の記録の盤面で方策を動かして確かめ（`verifyPolicyWithReplay`）、改修前と同じ地図で比べる（`gateEvaluatorChange`）。どちらかに落ちたら元に戻す。範囲外の編集は edit-guard が戻す。続けて方策を学習する（`TRAIN_AFTER_MATCH_MIN` 分。振り返りをしない時も）。学習が終わると学習の LLM が動く（`LAB_COACH`）。
6. **終了**: `MainAgent.end()` で先行起動したプロセスを止める。自動継続なら数秒待って次の試合へ。

`bun run play` は同じ流れを WebUI なしで 1 試合だけ行う（`src/play.ts`。`--no-llm` で LLM なし、`--evolve` で試合後の振り返りと学習まで）。

## 1フェーズの処理（runner.ts `playPhase`）

1. 方策がすぐ手を決める（`decideSolver`。今の作戦 `plan` を渡す）。ただし 1 ターン目の CMD1 は `gr`（初期観測）に固定する。方策が例外を投げたら安全な手。
2. `evaluateBreakpoint` が「新種タイル」「ワープ」「移動不可」「敵が近い」などの理由を集める（止めるためではなく、LLM への情報として渡す）。
3. LLM が考え中でなければ、今の盤面（全体マップ・経過・メモ・方策の今の手）で `startBackground` を呼んで裏の問い合わせを始める。前の問い合わせの返答が届いていれば `plan`・メモを反映する（考えている間にワープなどで座標系が変わっていれば、その目標は捨てる）。`AGENT_TURN_BUDGET_SEC` を超えた問い合わせは止める。
4. サーバへ送信し、返ってきた 3×3 観測を `WorldMap.applyObservation` で反映する。ワープしたら Web マップを再取得する。

フェーズが想定外の状態で終わった場合は、安全手（`pickSafeFallback`）で補完してターンを閉じる。想定外の例外（ゲームオーバー以外）は試合を終了させ、ダッシュボードにエラーを出す。

## ソースファイル構成

| ファイル | 役割 |
| :--- | :--- |
| `src/index.ts` | エントリ。Web サーバ起動、試合ループ、開始／停止の制御 |
| `src/play.ts` | `bun run play`。WebUI なしで 1 試合（`--evolve` で試合後の振り返りと学習まで） |
| `src/config.ts` | CLI 引数と `.env` から `AgentConfig` を作る（モデル・effort・返答の上限） |
| `src/settings.ts` | `.env` の項目の名前・既定値・説明・分類（`advanced` は「詳しい設定」、`OBSOLETE_SETTINGS` は使われなくなった項目） |
| `src/paths.ts` | 全パスの定義（唯一の場所） |
| `src/runner.ts` | 1試合の進行、ターン記録 (`TurnRecord`)、`summary.json` の作成 |
| `src/evolve.ts` | 試合後の振り返り。評価関数の改修を確かめ、落ちたら戻す。続けて学習 |
| `src/verify.ts` | `bun run verify-policy` の本体（方策のスモークテスト） |
| `src/cli.ts` | Claude Code の Bash から使うツール群 |
| `src/agent/claude-env.ts` | 隔離 env と起動引数（ゲートウェイ・モデル・effort） |
| `src/agent/claude-session.ts` | `--input-format stream-json` で起動する Claude Code プロセス（使い捨て・常駐の両用。`ask` は同時に 1 件） |
| `src/agent/main-agent.ts` | 試合中の LLM（`begin` / `startBackground` / `postMatch`）、応答 JSON の解析、作戦の追跡 |
| `src/agent/models.ts` | ゲートウェイの `/models` 一覧と effort の定義 |
| `src/agent/turn-events.ts` | ブレークポイント理由の評価（停止はしない） |
| `src/solver/planner.ts`・`policy.ts`・`types.ts` | 経路探索の方策（試合中の手）。`policy.ts` はパラメータ（`var/policy/params.json`）の読み書きと方策の組み立て。`types.ts` は作戦（`AgentPlan`）と手の判断（`SolverDecision`）の型 |
| `src/solver/evaluator.ts` | 方策の評価関数とパラメータの範囲（試合後の振り返り・学習の LLM が直してよい。確かめて採否） |
| `src/sim/` | シミュレータ（`engine`・`mapgen`・`episode`）、並列実行（`pool`・`worker`）、学習（`train`）、「学習」画面の仕事（`lab`）、学習の LLM（`lab-coach`）、試合後の仕事（`post-match`）、偽サーバ（`fake-server`） |
| `src/memory/world-map.ts` | 盤面の座標系、観測の反映、候補評価、`firstStepTowards`、SLAM とセグメント統合 |
| `src/memory/knowledge-store.ts` | `knowledge/tiles.json` と `var/room-profiles.json` の読み書き（一時ファイルに書いて置き換える。読めない時は前に読めた中身で続け、壊れた tiles.json には書かない。壊れた room-profiles.json は `.broken-<日時>` に控える） |
| `src/perception/web-map-scraper.ts` | `MapView.jsp` / `listWorldvsresult` の取得とパース（HTTP のみ） |
| `src/client/` | サーバ通信（Cookie 付き HTTP、ポーリングの状態機械、ReturnCode パーサ、公式成績の取得） |
| `src/evolution/analyzer.ts` | 試合後の診断レポート（推定と公式の差、穴の再踏破など） |
| `src/evolution/replay-verifier.ts` | `turns.jsonl` の盤面で方策を動かして確かめる（例外・合法手・その試合の評価関数と比べて罠へ動く手が増えていないか） |
| `src/evolution/edit-guard.ts` | エージェントが範囲外（`src/` など。評価関数は除く）を変えたら戻す |
| `src/tools/` | ロガー（pino）、公式サイト検索 (`reference`) |
| `src/ui/` | `server.ts`（HTTP/SSE）、`event-bus.ts`（状態配信）、`env-store.ts`（.env 読み書き）、`lab-routes.ts`（「学習」の API）、`public/index.html`・`public/lab.js` |
| `agent/prompts/` | `prep.md`（準備）、`main.md`（試合中の作戦係）、`lab-coach.md`（学習の LLM） |
| `agent/tools/` | エージェントが作る臨時／補助ツール（規約は `agent/tools/README.md`） |

## 盤面の表現

- `WorldMap` は自機を原点とする相対座標で盤面を持つ。Web マップ（`MapView.jsp` など）が取れたルームでは、そのグリッドに対して自機の絶対座標を特定（ロック）する。
  - **Web マップに自機が載る時は、位置合わせは自機の位置だけで決める**。候補は「取得を始めた位置〜今の位置」の間に通った位置（取得中に動くため）で、自分で観測したマスと食い違いの少ないもの（同点なら取得開始時）。前の位置合わせは候補にしない（以前は同点なら前の位置合わせを優先し、一度ずれると直らなかった）。位置合わせが変わったら、前の位置合わせで書き込んだ Web マップのマスを消してから書き直す。
  - ワープ後は 3×3 の見た目で「前に来た区画」「Web マップのこの位置」と決めず、ワープ直後に取り直す Web マップで決める（穴ばかりの所で別の場所に一致してずれていた）。その間（1〜2 フェーズ）は絶対座標なし。
  - 取得中に座標系が変わったら（ワープ・前の区画へ戻る）、その Web マップは使わない（以前は区画の数で判定していて、前の区画へ戻った時に古い座標で合わせていた）。
  - スクレイパは、スコア欄から自分のタイル番号が分かればその位置、分からなければ盤面のプレイヤーが1人の時だけその位置を自機とする（以前は最初に見つかったプレイヤーを自機にしていた）。
  - 位置合わせは毎回 `turns.jsonl` の `webAlign` に残す（`corrected` があれば、それまでずれていた）。直した時は WebUI に「位置合わせを直した」と出る。
- Web マップがないルームでは、3×3 観測を重ねる SLAM で相対座標の地図を作る。ワープで観測が矛盾したら新しいセグメントを作り、既知パターンと一意に一致した時点で統合する。
- `toSnapshot()` の内容は毎ターン `var/current/snapshot.json` に書き出される。LLM とツールはこれを読む。
- `firstStepTowards(x, y)` は目標までの最初の一歩を返す。到達済みなら `"here"`、到達不能なら `null`。作戦 (`plan`) の追従と解除に使う。

## データの置き場所

| 種類 | 場所 | 管理 |
| :--- | :--- | :--- |
| タイル得点・ルール知識 | `knowledge/tiles.json`, `knowledge/strategy.md`, `knowledge/server.json`（サーバ仕様の実測） | git |
| 臨時・補助ツール | `agent/tools/*.ts` | git |
| 試合ごとのログ | `var/runs/<runId>/` (`turns.jsonl`, `summary.json`, `diagnosis.md`, `final-map.txt`, `evaluator-snapshot.ts`・`policy-params.json`（その試合の方策）, `evolution-report.md`) | 除外 |
| ルームごとの成績 | `var/room-profiles.json`（最高得点、Web マップの有無、ワープの実測、マスのメモ） | 除外 |
| 隔離された Claude の HOME | `var/claude-home/` | 除外 |
| シミュレータの地図の作り方 | `knowledge/sim-profiles.json` | git |
| 本物の地図（試合中の最初の Webマップ） | `var/maps/room<N>/<runId>.json` | 除外 |
| 方策のパラメータ・学習の記録 | `var/policy/params.json`, `var/policy/train-log.jsonl` | 除外 |
| 直近の盤面 | `var/current/snapshot.json` | 除外 |
