/** src/settings.ts から .env.example を生成する: bun scripts/gen-env-example.ts */
import { SETTINGS } from "../src/settings";

const titles = { chaser: "CHaserOnline サーバ・試合", llm: "Claude Code ハーネス / エージェント", other: "その他" } as const;
const lines = ["# 自動生成: bun scripts/gen-env-example.ts（項目の追加・既定値の変更は src/settings.ts で行う）", ""];
for (const group of Object.keys(titles) as (keyof typeof titles)[]) {
  lines.push(`# ===== ${titles[group]} =====`);
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.group !== group) continue;
    lines.push(`# ${def.description}`, `${key}=${"secret" in def && def.secret ? "" : def.defaultValue}`);
  }
  lines.push("");
}
await Bun.write(new URL("../.env.example", import.meta.url), lines.join("\n"));
console.log(JSON.stringify({ keys: Object.keys(SETTINGS).length }));
