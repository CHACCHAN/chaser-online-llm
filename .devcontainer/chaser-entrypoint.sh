#!/bin/sh
# 起動のたびに依存を lockfile どおりに入れる（入っていればすぐ終わる）。.env は bun が /app から読む
set -e
cd /app
if [ ! -f package.json ]; then
  echo "プロジェクトが /app にマウントされていない（compose.yaml の volumes を確認）" >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "注意: .env が無い。cp .env.example .env して CHASER_USER などを書くか、WebUI の「設定」から保存する" >&2
fi
bun install --frozen-lockfile
exec "$@"
