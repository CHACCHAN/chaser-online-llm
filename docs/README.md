# ドキュメント索引・引き継ぎガイド

次のセッションや別の開発者がこのプロジェクトを引き継ぐための入口です。仕様は実装（`src/`）が正であり、食い違いを見つけたらコードを優先して docs を直してください。

## 読む順番

1. [../README.md](../README.md): 起動方法と設定
2. [architecture.md](architecture.md): 構成と試合のライフサイクル
3. [claude-evolution.md](claude-evolution.md): メインエージェントと試合後の進化（本プロジェクトの中核）
4. [webui.md](webui.md): ダッシュボードの操作と API
5. [chaser-protocol.md](chaser-protocol.md): サーバ仕様・スコア・タイル（実測値の注記あり）

## 現状の要点

- 試合は `src/index.ts` のループが回す。1試合ごとに `MainAgent` が Claude Code を常駐起動し、ターンごとに手を決めさせる。
- 試合後は同じ常駐セッションに振り返りと `active-solver.ts` の改修をさせ、リプレイ検証（合法性と例外のみ）で通らなければロールバックする。
- タイル得点は公式に根拠がない。`knowledge/tiles.json` の値は実測に基づくもので、暫定値として扱う。
- 常駐セッションの実測: 起動の準備（ウォームアップ）約 6 秒、1 手約 2〜5 秒。旧方式（毎回 `claude -p` を起動し 180 秒で打ち切り）は改修途中で kill されていたため廃止した。

## 作業の前後に確認すること

```bash
bun run typecheck        # 型エラー 0
bun test                 # 単体テスト
bun run verify-solver    # ソルバーが読み込めて合法手を返す
bun src/cli.ts status --room 3   # ルームの最高得点とタイル数
```

ソルバーを改修したら、必ず `bun src/cli.ts verify --run-dir var/runs/<runId>` で過去ログを再生して確かめてください。

## 変更時のルール

- パスは `src/paths.ts` に足す。各ファイルで `import.meta.dir` から組み立てない。
- `decideTurnAction(worldMap, phase, turn)` のシグネチャは維持する（runner と replay-verifier が依存）。
- 試合中に `active-solver.ts` を書き換えない。改修は試合後のみ。
- 秘密情報（`.env` の値）をログ・UI・外部送信に出さない。
