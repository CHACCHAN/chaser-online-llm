# CHaserOnline LLM ハーネスの実行用イメージ（devcontainer を使わない人向け）。
# プロジェクトはイメージに入れず、compose.yaml で /app にマウントする（エージェントがソルバー・knowledge/・var/ を書き換え、
# 編集ガードが git を使うため）。依存（node_modules）は名前付きボリュームに入れ、起動時に bun install する。
#
#   docker compose up -d --build      # http://localhost:3456（.env の PORT）
#   docker compose logs -f
#   docker compose exec chaser bun run claude-login   # サブスクリプションでつなぐ時
ARG BUN_VERSION=1.4.5
FROM oven/bun:${BUN_VERSION}-debian

# git: 編集ガード（src/evolution/edit-guard.ts）。curl: ヘルスチェック。ripgrep・procps・less: エージェントのツール用
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps less \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

# マウントしたファイルを書けるよう、実行ユーザーの UID/GID をホストに合わせる（Claude Code は root では動かさない）
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupmod -o -g "${USER_GID}" bun \
  && usermod -o -u "${USER_UID}" -g "${USER_GID}" bun \
  && mkdir -p /app/node_modules \
  && chown -R bun:bun /app /home/bun

COPY --chmod=755 .devcontainer/chaser-entrypoint.sh /usr/local/bin/chaser-entrypoint.sh

USER bun
WORKDIR /app
ENV HOME=/home/bun
ENTRYPOINT ["/usr/local/bin/chaser-entrypoint.sh"]
CMD ["bun", "run", "start"]
