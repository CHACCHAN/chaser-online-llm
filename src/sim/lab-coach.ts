import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_WORK_TOOLS, type AskResult, ClaudeSession } from "../agent/claude-session";
import { restoreProtectedFiles, snapshotProtectedFiles } from "../evolution/edit-guard";
import { AGENT_DIR, EVALUATOR_PATH, LAB_COACH_DIR, LAB_COACH_LOG_PATH, POLICY_TRAIN_LOG_PATH, PROJECT_ROOT, SIM_MAPS_DIR, SIM_PROFILES_PATH, TRAIN_CONFIG_PATH } from "../paths";
import { getSetting, numSetting } from "../settings";
import { logger } from "../tools/logger";
import type { EpisodeResult } from "./episode";
import { loadRealMaps, makeScenario } from "./mapgen";
import { gateEvaluatorChange, type GateResult } from "./post-match";
import { makeRng } from "./rng";
import { loadTrainConfig, type TrainResult } from "./train";

/**
 * 学習の LLM（試合中の LLM とは別のセッション）。学習が終わるたびに lab.ts から呼ぶ。
 *
 * 1. 学習の結果・地図ごとの成績（足踏み・罠・方策の誤り）・本物の地図との違いを var/lab-coach/<日時>/ に書き出す。
 * 2. ツールありの Claude Code（agent/prompts/lab-coach.md）に読ませ、学習環境を直させる:
 *    評価関数 src/solver/evaluator.ts・地図の作り方 knowledge/sim-profiles.json・学習のやり方 knowledge/train-config.json。
 * 3. 直したものを確かめ、だめなら元に戻す:
 *    - 評価関数: 改修前と同じ地図で比べ、弱くなっていれば戻す（試合後の振り返りと同じ gateEvaluatorChange）。
 *    - 地図の作り方: 読めて地図が作れること。本物の地図があるルームでは、作った地図のタイルの割合が本物から遠ざかったら戻す
 *      （方策の得点では比べない。地図を易しくすれば得点は上がってしまうので）。
 *    - 学習のやり方: 読めて範囲の中であること（外なら戻す）。
 *    それ以外（ハーネス）を変えていたら元に戻す。
 */

export interface CoachChange {
  what: "evaluator" | "profiles" | "trainConfig";
  accepted: boolean;
  detail: string;
}

export interface CoachResult {
  status: "ok" | "timeout" | "dead" | "stopped";
  /** LLM の報告（何を見て何を直したか） */
  summary: string;
  changes: CoachChange[];
  /** 範囲外で元に戻したファイル */
  reverted: string[];
  startedAt: string;
  finishedAt: string;
  trigger: string;
  dir: string;
}

export interface CoachInput {
  trigger: string;
  room: number | null;
  train: TrainResult;
  /** 今の方策（学習の後）で打たせた地図の記録（再生用の trace つき） */
  runs: EpisodeResult[];
  /** 同じ地図を学習の前の方策で打たせた記録（あれば） */
  runsBefore?: EpisodeResult[] | null;
}

export interface CoachDeps {
  /** LLM に聞く（テストで差し替える）。既定はツールありの Claude Code セッション */
  ask?: (prompt: string, timeoutMs: number) => Promise<AskResult>;
  /** 止める（試合が始まった等）。true になったら LLM を止め、改修は全部戻す */
  shouldStop?: () => boolean;
  gateEvaluator?: (baselineCode: string, room: number | null) => Promise<GateResult>;
  paths?: { evaluator?: string; profiles?: string; trainConfig?: string; dir?: string; log?: string };
  /** 守る範囲（src/ など）の変更を戻すか（テストでは戻さない） */
  guard?: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const perTurnOf = (r: EpisodeResult) => r.score / Math.max(1, r.totalTurns);

/** 最後に同じ2マス以内を行き来していたターン数（足踏み）。trace が無ければ 0 */
export function stuckTurns(run: EpisodeResult): number {
  const tr = run.trace;
  if (!tr) return 0;
  const me = tr.players.findIndex((p) => p.self);
  const seen = new Set<string>();
  let n = 0;
  for (let i = tr.frames.length - 1; i >= 0; i--) {
    seen.add(tr.frames[i]!.pos[me]!.join(","));
    if (seen.size > 2) break;
    n += 1;
  }
  return n >= 6 ? n : 0;
}

/** タイルの割合（地図の中の全マスに対する、番号ごとの割合） */
export function tileHistogram(grids: number[][][]): Map<number, number> {
  const h = new Map<number, number>();
  let total = 0;
  for (const g of grids) for (const row of g) for (const v of row) {
    h.set(v, (h.get(v) ?? 0) + 1);
    total += 1;
  }
  for (const [k, v] of h) h.set(k, v / Math.max(1, total));
  return h;
}

/** 2つのタイルの割合の違い（L1 距離。0 = 同じ、2 = 全く違う） */
export function histogramDistance(a: Map<number, number>, b: Map<number, number>): number {
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return d;
}

/** 本物の地図が保存してあるルーム */
function roomsWithRealMaps(): number[] {
  if (!existsSync(SIM_MAPS_DIR)) return [];
  return readdirSync(SIM_MAPS_DIR)
    .filter((d) => /^room\d+$/.test(d))
    .map((d) => Number(d.slice(4)))
    .filter((r) => loadRealMaps(r).length > 0);
}

/** 作った地図（本物の地図は混ぜない）と本物の地図の違い。本物の地図が無ければ null */
export function generatedVsReal(room: number, n = 24): { distance: number; realMaps: number; gen: Map<number, number>; real: Map<number, number> } | null {
  const real = loadRealMaps(room);
  if (real.length === 0) return null;
  const gen = Array.from({ length: n }, (_, i) => makeScenario(makeRng(5_000_000 + i), { room, realMaps: [] }).grid);
  const hg = tileHistogram(gen);
  const hr = tileHistogram(real.map((m) => m.grid));
  return { distance: histogramDistance(hg, hr), realMaps: real.length, gen: hg, real: hr };
}

/** 地図の作り方が読めて、地図が作れるか（作れなければ理由） */
function profilesProblem(rooms: (number | null)[]): string | null {
  try {
    for (const room of rooms) {
      for (let i = 0; i < 6; i++) {
        const s = makeScenario(makeRng(4_000_000 + i), { room, realMaps: [] });
        if (s.grid.length < 5 || (s.grid[0]?.length ?? 0) < 5) return `ルーム ${room ?? "いろいろ"} の地図が小さすぎる（${s.grid[0]?.length}×${s.grid.length}）`;
        if (s.starts.length === 0) return `ルーム ${room ?? "いろいろ"} の地図に立てる場所が無い`;
      }
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf-8") : null);

function fmtHist(h: Map<number, number>, top = 10): string {
  return [...h.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, v]) => `${k}:${(v * 100).toFixed(1)}%`)
    .join(" ");
}

/** LLM に渡す統計（report.md）と再生の記録（traces.json）を書き出し、report の本文を返す */
export function writeCoachReport(input: CoachInput, dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "traces.json"), JSON.stringify(input.runs.map((r, i) => ({ index: i, scenario: r.scenario, score: r.score, totalTurns: r.totalTurns, trace: r.trace ?? null }))));
  const t = input.train;
  const c = t.comparison;
  const lines: string[] = [
    `# 学習の結果（${input.trigger}${input.room !== null ? `・ルーム ${input.room} に似せた地図` : "・いろいろな地図"}）`,
    "",
    `- ${t.generations} 世代・${t.episodes} 試合・${Math.round(t.ms / 1000)} 秒`,
    `- 学習に使っていない地図 ${c.n} 枚で: 学習前 ${c.a} → 学習後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}、罠 ${c.hazardsA}→${c.hazardsB}）→ ${t.accepted ? "保存した" : "保存しない（はっきり良くなっていない）"}`,
    `- 学習のやり方（knowledge/train-config.json）: ${JSON.stringify(loadTrainConfig().config)}`,
    "",
    `## 地図ごとの成績（今の方策${input.runsBefore ? "。前→後は同じ地図を学習前の方策で打たせたもの" : ""}）`,
    "",
    "| # | 地図 | 大きさ | ターン | 点/ターン | 罠 | 足踏み（最後に同じ所を行き来したターン） | 方策の誤り | 相手 | 当てた／当てられた | 勝ち |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  input.runs.forEach((r, i) => {
    const b = input.runsBefore?.[i];
    const size = r.trace ? `${r.trace.width}×${r.trace.height}` : "-";
    const vs = r.opponentKinds?.length ? `${r.opponentKinds.join("・")}` : "-";
    lines.push(`| ${i} | ${r.scenario} | ${size} | ${r.totalTurns} | ${b ? `${r1(perTurnOf(b))}→` : ""}${r1(perTurnOf(r))} | ${r.hazardHits} | ${stuckTurns(r) || "-"} | ${r.policyErrors || "-"} | ${vs} | ${r.put ?? 0}／${r.putDamage ?? 0} | ${r.won === null || r.won === undefined ? "-" : r.won ? "○" : "×"} |`);
  });
  const withOpp = input.runs.filter((r) => r.won !== null && r.won !== undefined);
  if (withOpp.length) {
    const won = withOpp.filter((r) => r.won).length;
    const pd = withOpp.reduce((a, r) => a + (r.putDamage ?? 0), 0);
    lines.push("", `相手のいる地図 ${withOpp.length} 枚: 勝ち ${won}、当てられた合計 ${pd}（相手の種類の重み oppGreedy/oppHunter/oppSelf と自己対戦の相手 var/policy/league.json。当てた時の得点は sim-profiles.json の putHit・仮の値）`);
  }
  const weak = input.runs.map((r, i) => [perTurnOf(r), i] as const).sort((a, b) => a[0] - b[0]).slice(0, 3);
  lines.push("", `弱い地図: ${weak.map(([, i]) => `#${i}`).join(", ")}（traces.json の index。各ターンの位置・得点・手・方策の理由・変わったマス）`);

  // 地図の作り方と本物の地図の違い
  const rooms = [...new Set([...(input.room !== null ? [input.room] : []), ...roomsWithRealMaps()])];
  lines.push("", "## 作った地図と本物の地図の違い（タイルの割合。knowledge/sim-profiles.json を直す手がかり）", "");
  let any = false;
  for (const room of rooms) {
    const g = generatedVsReal(room);
    if (!g) continue;
    any = true;
    lines.push(`- ルーム ${room}（本物 ${g.realMaps} 枚）: 違い ${g.distance.toFixed(3)}（0 = 同じ）`, `  - 本物: ${fmtHist(g.real)}`, `  - 作った: ${fmtHist(g.gen)}`);
  }
  if (!any) lines.push("- 本物の地図はまだ保存されていない（試合で全体マップが取れると var/maps/ に保存される）。地図の作り方は var/room-profiles.json の実測（大きさ・ターン数）と knowledge/tiles.json に合わせる");

  // 最近の学習の記録
  const log = read(POLICY_TRAIN_LOG_PATH);
  if (log) {
    const recent = log.trim().split("\n").slice(-8).map((l) => {
      try {
        const o = JSON.parse(l) as { at: string; trigger: string | null; generations: number; accepted: boolean; comparison: { a: number; b: number; diff: number; se: number } };
        return `- ${o.at.slice(5, 16)} ${o.trigger ?? "-"}: ${o.generations} 世代、${o.comparison.a}→${o.comparison.b}（差 ${o.comparison.diff}±${o.comparison.se}）${o.accepted ? " 保存" : ""}`;
      } catch {
        return null;
      }
    }).filter(Boolean);
    lines.push("", "## 最近の学習（var/policy/train-log.jsonl）", "", ...(recent as string[]));
  }
  const text = lines.join("\n");
  writeFileSync(path.join(dir, "report.md"), text);
  return text;
}

function defaultAsk(prompt: string, timeoutMs: number, stop: () => boolean): Promise<AskResult> {
  const promptFile = path.join(AGENT_DIR, "prompts", "lab-coach.md");
  const session = new ClaudeSession({
    model: getSetting("LAB_COACH_MODEL") || getSetting("LLM_MODEL_NAME") || undefined,
    effort: getSetting("LAB_COACH_EFFORT") || getSetting("LLM_MODEL_EFFORT") || undefined,
    context: "evolution",
    label: "lab",
    tools: AGENT_WORK_TOOLS,
    appendSystemPrompt: existsSync(promptFile) ? readFileSync(promptFile, "utf-8") : "あなたは学習の LLM。学習環境を直す。",
  });
  session.start();
  const watch = setInterval(() => {
    if (stop()) session.kill();
  }, 1000);
  return session.ask(prompt, timeoutMs).finally(async () => {
    clearInterval(watch);
    await session.stop().catch(() => {});
  });
}

/** 学習の LLM を1回動かす（lab.ts から。学習の仕事の続きとして同じ枠で動く） */
export async function runLabCoach(input: CoachInput, deps: CoachDeps = {}): Promise<CoachResult> {
  const startedAt = new Date().toISOString();
  const files = {
    evaluator: deps.paths?.evaluator ?? EVALUATOR_PATH,
    profiles: deps.paths?.profiles ?? SIM_PROFILES_PATH,
    trainConfig: deps.paths?.trainConfig ?? TRAIN_CONFIG_PATH,
  };
  const dir = deps.paths?.dir ?? path.join(LAB_COACH_DIR, startedAt.replace(/[:.]/g, "-"));
  const report = writeCoachReport(input, dir);
  const before = { evaluator: read(files.evaluator), profiles: read(files.profiles), trainConfig: read(files.trainConfig) };
  const stop = deps.shouldStop ?? (() => false);
  const guard = deps.guard === false ? null : snapshotProtectedFiles();
  const rel = (f: string) => path.relative(PROJECT_ROOT, f);

  const prompt = [
    "[LAB] 方策の学習が終わった。あなたは学習の LLM（試合中の LLM とは別）。学習の結果を読み、学習環境を直せ。",
    `統計: ${rel(path.join(dir, "report.md"))}（下に同じ内容）/ 再生の記録: ${rel(path.join(dir, "traces.json"))}`,
    "",
    report,
    "",
    "## 直してよいもの",
    `- 評価関数 \`${rel(files.evaluator)}\`（方策が何を狙い、どれだけ遠回りするか。新しい特徴は PARAM_SPACE に重みを足す）。比べ方: \`bun src/cli.ts bench --room <n> --evaluator <改修前の写し>\``,
    `- 地図の作り方 \`${rel(files.profiles)}\`（本物の地図・実測に似せる。易しくするための変更はしない）`,
    `- 学習のやり方 \`${rel(files.trainConfig)}\`（候補・地図・確かめの数、探す幅）`,
    "ほか（src/ のハーネス）を変えても元に戻される。ハーネスの不具合に気づいたら、直さずに報告に書く。",
    "",
    "## 最後に",
    "何を見て、何を直したか（直さなかったならその理由）を5行以内で報告する。",
  ].join("\n");

  const timeoutMs = numSetting("LAB_COACH_TIMEOUT_MIN", { min: 1 }) * 60_000;
  let res: AskResult;
  try {
    res = await (deps.ask ? deps.ask(prompt, timeoutMs) : defaultAsk(prompt, timeoutMs, stop));
  } catch (err) {
    res = { status: "dead", error: err instanceof Error ? err.message : String(err) };
  }
  const reverted = guard ? restoreProtectedFiles(guard) : [];
  const restore = (file: string, content: string | null) => {
    if (content !== null) writeFileSync(file, content);
  };
  const changes: CoachChange[] = [];
  const stopped = stop();

  if (stopped) {
    // 試合が始まった等: 確かめていない改修は全部戻す
    for (const k of ["evaluator", "profiles", "trainConfig"] as const) if (read(files[k]) !== before[k]) restore(files[k], before[k]);
  } else {
    // 学習のやり方
    if (read(files.trainConfig) !== before.trainConfig) {
      const { config, problems } = loadTrainConfig(files.trainConfig);
      if (problems.length > 0) {
        restore(files.trainConfig, before.trainConfig);
        changes.push({ what: "trainConfig", accepted: false, detail: `戻した（${problems.join("、")}）` });
      } else {
        const prev = before.trainConfig ? loadTrainConfigFromText(before.trainConfig) : null;
        const diff = prev ? (Object.keys(config) as (keyof typeof config)[]).filter((k) => prev[k] !== config[k]).map((k) => `${k} ${prev[k]}→${config[k]}`).join("、") : JSON.stringify(config);
        changes.push({ what: "trainConfig", accepted: true, detail: diff || "値は同じ" });
      }
    }
    // 地図の作り方
    if (read(files.profiles) !== before.profiles) {
      const rooms = [...new Set([null, input.room, ...roomsWithRealMaps()])];
      const problem = profilesProblem(rooms);
      if (problem) {
        restore(files.profiles, before.profiles);
        changes.push({ what: "profiles", accepted: false, detail: `戻した（地図が作れない: ${problem}）` });
      } else {
        // 本物の地図があるルームで、作った地図が本物から遠ざかっていないか
        const afterDist = new Map(roomsWithRealMaps().map((r) => [r, generatedVsReal(r)?.distance ?? 0]));
        const now = read(files.profiles);
        restore(files.profiles, before.profiles);
        const beforeDist = new Map(roomsWithRealMaps().map((r) => [r, generatedVsReal(r)?.distance ?? 0]));
        if (now !== null) writeFileSync(files.profiles, now);
        const worse = [...afterDist].filter(([r, d]) => d > (beforeDist.get(r) ?? 0) + 0.02);
        const detail = [...afterDist].map(([r, d]) => `ルーム ${r}: ${(beforeDist.get(r) ?? 0).toFixed(3)}→${d.toFixed(3)}`).join("、");
        if (worse.length > 0) {
          restore(files.profiles, before.profiles);
          changes.push({ what: "profiles", accepted: false, detail: `戻した（本物の地図から遠ざかった: ${detail}）` });
        } else {
          changes.push({ what: "profiles", accepted: true, detail: detail ? `本物との違い ${detail}` : "地図が作れることを確かめた（比べる本物の地図はまだ無い）" });
        }
      }
    }
    // 評価関数
    if (before.evaluator !== null && read(files.evaluator) !== before.evaluator) {
      const gate = await (deps.gateEvaluator ?? gateEvaluatorChange)(before.evaluator, input.room);
      const c = gate.comparison;
      const detail = c ? `改修前 ${c.a} → 改修後 ${c.b} 点/ターン（差 ${c.diff}±${c.se}、勝ち ${c.wins}/${c.n}、罠 ${c.hazardsA}→${c.hazardsB}）` : `比べられなかった: ${gate.error}`;
      if (!gate.ok) restore(files.evaluator, before.evaluator);
      changes.push({ what: "evaluator", accepted: gate.ok, detail: gate.ok ? `採用: ${detail}` : `戻した: ${detail}` });
    }
  }

  const result: CoachResult = {
    status: stopped ? "stopped" : res.status === "ok" ? "ok" : res.status === "timeout" ? "timeout" : "dead",
    summary: res.status === "ok" ? res.text.trim().slice(0, 2000) : res.status === "dead" ? `止まった: ${res.error}` : res.status === "timeout" ? "時間切れ（それまでの改修を確かめた）" : "",
    changes,
    reverted,
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: input.trigger,
    dir: rel(dir),
  };
  try {
    const logFile = deps.paths?.log ?? LAB_COACH_LOG_PATH;
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(result)}\n`);
    writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "学習の LLM の記録に失敗");
  }
  return result;
}

function loadTrainConfigFromText(text: string): Record<string, number> | null {
  try {
    return JSON.parse(text) as Record<string, number>;
  } catch {
    return null;
  }
}

/** 最近の学習の LLM の結果（新しい順） */
export function readCoachLog(limit = 10, file = LAB_COACH_LOG_PATH): CoachResult[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as CoachResult;
      } catch {
        return null;
      }
    })
    .filter((x): x is CoachResult => x !== null)
    .reverse();
}
