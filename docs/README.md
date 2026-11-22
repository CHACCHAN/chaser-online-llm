# ドキュメント索引・引き継ぎガイド

次のセッションや別の開発者がこのプロジェクトを引き継ぐための入口です。仕様は実装（`src/`, `agent/prompts/`）が正であり、食い違いを見つけたら実装を優先して docs を直してください。

## 読む順番

1. [setup.md](setup.md): 起動方法（Bun / Docker）・コマンド・設定・ディレクトリ
2. [architecture.md](architecture.md): 構成（方策・試合中の LLM・試合後の振り返りと学習の関係）と試合のライフサイクル
3. [learning.md](learning.md): 試合中の手を出す方策・シミュレータ・試合後の学習（LLM は裏で作戦を出す）
4. [claude-evolution.md](claude-evolution.md): 試合中の LLM・準備・試合後の振り返り（評価関数の改修）・レビュー
5. [webui.md](webui.md): ダッシュボードの操作と API
6. [chaser-protocol.md](chaser-protocol.md): サーバ仕様・スコア・タイル（実測値の注記あり）

## 現状の要点

- **手は方策、LLM は裏で作戦**（2026-11-22〜、[learning.md](learning.md)）: 毎フェーズの手は経路探索の方策（`planner.ts`＋`evaluator.ts`＋`var/policy/params.json`、数ミリ秒）が出し、LLM の返答は待たない。時間で進むルーム（room 455）で LLM の返答が間に合わなかったため。試合後はシミュレータ（地図は毎回ランダム＋本物の地図）で学習し（`TRAIN_AFTER_MATCH_MIN`）、学習が終わるたびに学習の LLM が評価関数・地図の作り方・学習のやり方を直す（`LAB_COACH`）。
- 2026-11-22 に使われなくなった仕組みを外した: サブエージェント（方策が経路探しを受け持ってから依頼が0件）、LLM の返答を待って打つモード（`AGENT_ASYNC=false`）、古いソルバー（`active-solver.ts`・`PLAY_POLICY`）。`.env` に残った項目は設定画面の「使われなくなった項目」から消せる。
- 試合は `src/index.ts` のループが回す。1試合ごとに `MainAgent`（試合中の LLM）を作り、入室前の `begin()` で最初の問い合わせ用プロセスを先に起動する。
- **準備フェーズ**（「開始」より前、ルームには入らない。WebUI のボタンが「準備」→（準備中）→「開始」と変わり、「開始」で入室。`AGENT_PREP`、`agent/prompts/prep.md`）: 公式トップの `ver` を `knowledge/server.json` と比べ（変わっていれば警告し、メモにも注意を書かせる）、LLM がツール（Read/Glob/Grep のみ）でルール・`var/room-profiles.json`・このルームの過去の試合（`AGENT_PREP_PAST_RUNS` 件、summary/diagnosis/MEMO/evolution-report）・作戦方針を読み、試合開始時のメモを作る。上限 `AGENT_PREP_TIMEOUT_SEC`。失敗したら「準備」をやり直す（スタンバイOK でないと開始できない）。ルーム・モデル・effort を変えると準備は無効。1回の準備は1試合で使い切り、連続モードの次の試合は入室前に自動で準備し直し、失敗したら（LLM の利用制限など）`AGENT_PREP_RETRY_MIN` 分（既定5）待ってやり直す。実測（room 555, gpt-6.2-astra medium）: 49秒・約6.8万トークン・728字。
- **複数のルーム**（WebUI のルーム欄）: `719` のように1つ、`555-560` のように範囲、`555,568` のように並べて指定できる（組み合わせも可。範囲は100ルームまで）。複数なら「自動で次へ」の時に1試合ごとに次のルームへ進み、最後まで行ったら最初に戻る。次の試合の準備はそのルームでやり直す。試合中に変えたら次の試合から。
- 試合中の LLM は**前の会話を持たない使い捨ての `claude -p`**（`--no-session-persistence --tools "" --system-prompt …`）。Claude Code 既定のシステムプロンプトとツール定義を送らないので、1回あたりの入力はほぼ一定。引き継ぐのは、LLM が返答の `memo` で書き換えるメモ（`AGENT_MEMO_MAX_CHARS`）・ハーネスが作る直近の経過（`AGENT_RECENT_PHASES`）・全体マップと現在の状況だけ。
- 毎フェーズ、考え中でなければ今の盤面で裏の問い合わせを始め、手は待たずに方策が打つ。返答は `continue`（今の作戦のまま）/ `plan`（目標マスへ向かう作戦に変更）を JSON で返す（`agent/prompts/main.md`）。`AGENT_TURN_BUDGET_SEC` を超えた返答は捨てて次の盤面で聞き直す。`plan` の目標は方策の目標の候補に入る。到達・到達不能になると作戦は自動で解除される。
- メモは `var/current/MEMO.md` に毎回書き出す（人が読む用。編集しても試合には反映されない）。試合後は `var/runs/<runId>/` にコピー。
- 試合後はツールありの新しいセッションに、最終メモ・直近の経過・診断を渡して振り返りと評価関数 `src/solver/evaluator.ts` の改修をさせる。直したら、その試合の記録の盤面で方策を動かして確かめ（例外・合法手・罠へ動く手が増えていないか）、シミュレータで改修前と同じ地図で比べ、どちらかに落ちたら元に戻す。続けて同じ会話でハーネスへのレビューを聞き、`agent/REVIEW.md` に追記する（開発者が読む）。
- エージェントに渡す説明書は `agent/AGENTS.md`（`CLAUDE.md` は開発者向けで、エージェントには読ませない）。
- 実戦 A/B（room3）: LLM あり／手の計算だけで同一の手・同点（2440）。LLM が1手ずつ打つ構成は得点に寄与していなかった。そのため作戦係へ役割を絞った。
- 実測（サーバ, `knowledge/server.json`）: 1コマンド応答 約 1.6 秒で一定。CMD1 を 120 秒遅らせても切断なし（上限は未確認）。同一ユーザーの二重ログインは不可で、途中放棄後は約 5 分、ログインのみのセッションは約 12 分ロックされる。
- 実測コスト: 静止 `gr` = 動作 -20 ＋ 穴への再着地 -20。`gr*` / `w*` = 動作 -10。6 試合で推定値が公式スコアと一致（`agent/tools/score-model-check.ts`）。
- タイル得点は公式に根拠がない。`knowledge/tiles.json` の値は実測に基づく暫定値として扱う。

## 作業の前後に確認すること

```bash
bun run typecheck        # 型エラー 0
bun test                 # 単体テスト
bun run verify-policy    # 方策が読み込めて合法手を返す
bun src/cli.ts cells --room 719  # ルームのワープの実測とマスのメモ
bun src/cli.ts sim --n 16        # 方策のシミュレータでの得点
```

評価関数を直したら、`bun src/cli.ts verify --run-dir var/runs/<runId>`（試合の記録の盤面で確かめる）と `bun src/cli.ts bench --evaluator <file>`（同じ地図で比べる）で確かめてください。

## 変更時のルール

- パスは `src/paths.ts` に足す。各ファイルで `import.meta.dir` から組み立てない。
- 評価関数 `evaluator.ts` の export（`stepCost`・`targetValue`・`tileGain`・`PARAM_SPACE`）は維持する。planner・シミュレータ・replay-verifier が依存する。
- 試合中に `evaluator.ts` を書き換えない。改修は試合後（振り返り）か学習の LLM だけ。
- 秘密情報（`.env` の値）をログ・UI・外部送信に出さない。エージェントに CHaserOnline サーバへのログインをさせない（試合中のセッションを壊すため）。
