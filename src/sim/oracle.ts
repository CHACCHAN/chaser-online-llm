import type { EpisodeResult } from "./episode";
import type { EpisodeJob, SimPool } from "./pool";

/**
 * 理論値の目安との差。同じ地図・同じ相手で、今の方策と「もっと知っている／もっと考える」方策を打たせて比べる。
 *   - know: 全体マップを毎ターン見て、地図にある全部のワープの行き先を初めから知っている（知らないことで失っている点）
 *   - deep: know に加えて、目標の数・先読み・ビーム幅を一番大きくする（考えが浅いことで失っている点）
 * 本当の最適ではなく、今の方策の仕組みのままで届くはずの点の目安。地図ごとに know・deep・今の方策のうち一番高いものを目安とする。
 * 学習の LLM はこの差を見て、何を直すか（評価関数の特徴・学習のやり方・ハーネスの報告）を決める。
 */

export interface GapMap {
  scenario: string;
  /** 点/ターン */
  policy: number;
  know: number;
  deep: number;
}

export interface OracleGap {
  maps: GapMap[];
  /** 地図の平均（点/ターン） */
  policy: number;
  know: number;
  deep: number;
  /** 目安（地図ごとに一番高いもの）の平均 */
  reference: number;
  /** 今の方策 ÷ 目安（1 = 目安に届いている） */
  ratio: number;
  /** 差のうち、知らないことによる分（know − 今）と考えが浅いことによる分（deep − know）。目安との差 = その和（負は 0） */
  knowledgeGap: number;
  searchGap: number;
  measuredAt: string;
}

const perTurn = (r: EpisodeResult) => r.score / Math.max(1, r.totalTurns);
const round = (v: number) => Math.round(v * 10) / 10;

/** jobs（今の方策の仕事）と同じ地図・相手で know・deep を打たせる。policyRuns があれば今の方策は打たせ直さない */
export async function measureGap(pool: SimPool, jobs: EpisodeJob[], policyRuns?: EpisodeResult[] | null): Promise<OracleGap> {
  const plain = jobs.map((j) => ({ ...j, trace: false }));
  const [policy, know, deep] = await Promise.all([
    policyRuns && policyRuns.length === jobs.length ? Promise.resolve(policyRuns) : pool.runAll(plain),
    pool.runAll(plain.map((j) => ({ ...j, oracle: "know" as const }))),
    pool.runAll(plain.map((j) => ({ ...j, oracle: "deep" as const }))),
  ]);
  return summarizeGap(policy, know, deep);
}

export function summarizeGap(policy: EpisodeResult[], know: EpisodeResult[], deep: EpisodeResult[]): OracleGap {
  const maps = policy.map((r, i) => ({ scenario: r.scenario, policy: round(perTurn(r)), know: round(perTurn(know[i]!)), deep: round(perTurn(deep[i]!)) }));
  const mean = (f: (m: GapMap) => number) => round(maps.reduce((s, m) => s + f(m), 0) / Math.max(1, maps.length));
  const reference = mean((m) => Math.max(m.policy, m.know, m.deep));
  const p = mean((m) => m.policy);
  return {
    maps,
    policy: p,
    know: mean((m) => m.know),
    deep: mean((m) => m.deep),
    reference,
    ratio: reference > 0 ? Math.round((p / reference) * 1000) / 1000 : 1,
    knowledgeGap: mean((m) => Math.max(0, Math.max(m.know, m.policy) - m.policy)),
    searchGap: mean((m) => Math.max(0, Math.max(m.policy, m.know, m.deep) - Math.max(m.know, m.policy))),
    measuredAt: new Date().toISOString(),
  };
}

/** 学習の LLM の統計に載せる */
export function renderGap(g: OracleGap): string[] {
  const worst = [...g.maps].sort((a, b) => a.policy - Math.max(a.know, a.deep) - (b.policy - Math.max(b.know, b.deep))).slice(0, 5);
  return [
    `- 今の方策 ${g.policy} / 目安 ${g.reference} 点/ターン → 届いている割合 ${(g.ratio * 100).toFixed(0)}%`,
    `- 差の内訳: 知らないこと（全体マップ・ワープの行き先を知っていれば）+${g.knowledgeGap}、考えが浅いこと（目標の数・先読み・ビーム幅を最大にすれば）+${g.searchGap}`,
    `- 差の大きい地図: ${worst.map((m) => `${m.scenario} 今 ${m.policy} / 知っていれば ${m.know} / 深く考えれば ${m.deep}`).join("、") || "-"}`,
  ];
}
