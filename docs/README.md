# ドキュメント索引・引き継ぎガイド

次のセッションや別の開発者がこのプロジェクトを引き継ぐための入口です。仕様は実装（`src/`, `agent/prompts/`）が正であり、食い違いを見つけたら実装を優先して docs を直してください。

## 読む順番

1. [../README.md](../README.md): 起動方法と設定
2. [architecture.md](architecture.md): 構成（メイン／サブ／ソルバーの関係）と試合のライフサイクル
3. [claude-evolution.md](claude-evolution.md): メインエージェント・サブ・試合後の進化（本プロジェクトの中核）
4. [webui.md](webui.md): ダッシュボードの操作と API
5. [chaser-protocol.md](chaser-protocol.md): サーバ仕様・スコア・タイル（実測値の注記あり）

## 現状の要点

- 試合は `src/index.ts` のループが回す。1試合ごとに `MainAgent` を作り、入室前の `begin()` でメインの最初の問い合わせ用プロセスを先に起動し、サブを準備する（サブは依頼ごとにセッションを起動）。
- **準備フェーズ**（「開始」より前、ルームには入らない。WebUI のボタンが「準備」→（準備中）→「開始」と変わり、「開始」で入室。`AGENT_PREP`、`agent/prompts/prep.md`）: 公式トップの `ver` を `knowledge/server.json` と比べ（変わっていれば警告し、メモにも注意を書かせる）、メインがツール（Read/Glob/Grep のみ）でルール・`var/room-profiles.json`・このルームの過去の試合（`AGENT_PREP_PAST_RUNS` 件、summary/diagnosis/MEMO/ASK_SUB/evolution-report）・作戦方針を読み、試合開始時のメモを作る。上限 `AGENT_PREP_TIMEOUT_SEC`。失敗したら「準備」をやり直す（スタンバイOK でないと開始できない）。ルーム・モデル・effort を変えると準備は無効。1回の準備は1試合で使い切り、連続モードの次の試合は入室前に自動で準備し直す。実測（room 555, gpt-6.2-astra medium）: 49秒・約6.8万トークン・728字。
- メインは毎フェーズ**前の会話を持たない使い捨ての `claude -p`**（`--no-session-persistence --tools "" --system-prompt …`）で聞く。Claude Code 既定のシステムプロンプトとツール定義を送らないので、1回あたり約3,600トークンで一定（gpt-6.2-astra, 2026-11-20 実測、応答 約5〜8秒）。引き継ぐのは、メインが返答の `memo` で書き換えるメモ（`AGENT_MEMO_MAX_CHARS`）・ハーネスが作る直近の経過（`AGENT_RECENT_PHASES`）・現在の状況だけ。次のフェーズ用のプロセスは裏で先に起動し、予算切れの問い合わせは kill する。会話の要約（旧 `AGENT_COMPACT_AT_TOKENS`）は廃止。
- メモは `var/current/MEMO.md`、サブへの依頼と結果の全文は `var/current/ASK_SUB.md` に毎回書き出す（人とサブが読む用。編集しても試合には反映されない）。試合後は `var/runs/<runId>/` にコピー。メインへのメッセージには依頼の TODO（`AGENT_SUB_TODO_ITEMS` 件）を毎回付ける。
- メインは「作戦係＋例外係」。毎フェーズ `continue`（作戦のまま、ソルバーが手を打つ）/ `plan`（目標マスへ向かう作戦に変更）/ `command`（手を直接指定）を JSON で返す。任意の `delegate` でサブに仕事を依頼できる。
- `plan` の目標へはソルバーが `WorldMap.firstStepTowards` で追従する。到達・到達不能になると作戦は自動で解除され、次のメッセージで知らされる。
- サブ（`SubWorker`）は仕事ごとに新しい Claude Code セッション（ツールあり・保存なし）を起動し、返答したら閉じる。前の仕事の会話は持ち越さない。依頼を順に裏で処理し、結果は後のターンのメッセージでメインに届く（メインは待たない）。旧方式の `--agents` によるサブ定義は廃止した。
- 試合中に作るツールは臨時（`@temporary`、`agent/tools/`）。恒久化（ソルバー組込み・正式ツール化・削除）は試合後の [POST-MATCH] でメインが判断する。
- 時間予算超過・前の問い合わせが未完了・プロセス死亡・不正応答のいずれでもソルバー手で進む。
- 試合後はツールありの新しいセッションに、最終メモ・直近の経過・診断を渡して振り返りと `active-solver.ts` の改修をさせ、リプレイ検証（例外と合法性のみ）で通らなければロールバックする。続けて同じ会話でハーネスへのレビューを聞き、`agent/REVIEW.md` に追記する（開発者が読む）。
- エージェントに渡す説明書は `agent/AGENTS.md`（`CLAUDE.md` は開発者向けで、エージェントには読ませない）。
- 実戦 A/B（room3）: メインあり／ソルバーのみで同一の手・同点（2440）。得点の向上はソルバー改修によるもので、メインが1手ずつ打つ構成は得点に寄与していなかった。そのため作戦係へ役割を絞った。
- 実測（作戦係）: 1フェーズ 2〜4 秒。delegate を含むターンも 11 秒で返答。サブは約 2 分でツール作成を完了。
- 実測（サーバ, `knowledge/server.json`）: 1コマンド応答 約 1.6 秒で一定。CMD1 を 120 秒遅らせても切断なし（上限は未確認）。同一ユーザーの二重ログインは不可で、途中放棄後は約 5 分、ログインのみのセッションは約 12 分ロックされる。
- 実測コスト: 静止 `gr` = 動作 -20 ＋ 穴への再着地 -20。`gr*` / `w*` = 動作 -10。6 試合で推定値が公式スコアと一致（`agent/tools/score-model-check.ts`）。
- タイル得点は公式に根拠がない。`knowledge/tiles.json` の値は実測に基づく暫定値として扱う。

## 作業の前後に確認すること

```bash
bun run typecheck        # 型エラー 0
bun test                 # 単体テスト
bun run verify-solver    # ソルバーが読み込めて合法手を返す
bun src/cli.ts cells --room 719  # ルームのワープの実測とマスのメモ
```

ソルバーを改修したら、必ず `bun src/cli.ts verify --run-dir var/runs/<runId>` で過去ログを再生して確かめてください。

## 変更時のルール

- パスは `src/paths.ts` に足す。各ファイルで `import.meta.dir` から組み立てない。
- `decideTurnAction(worldMap, phase, turn, plan?)` のシグネチャは維持する（`plan` は省略可能な第4引数）。runner と replay-verifier が依存する。
- 試合中に `active-solver.ts` を書き換えない。改修は試合後のみ。試合中の臨時ツールも、恒久化は試合後に決める。
- 秘密情報（`.env` の値）をログ・UI・外部送信に出さない。サブにも CHaserOnline サーバへのログインをさせない（試合中のセッションを壊すため）。
