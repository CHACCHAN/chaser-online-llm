/* =====================================================================
   「統計」画面: ルームと試合／試合の記録／学習の推移／モデルの特性。
   index.html の共通の関数（$, $$, esc, fmt, jget, save, load, S, mark, setFocus）を使う。
   API は GET /api/stats（読むだけ）。試合の記録は index.html の部品（試合の一覧・スコア推移・ターン履歴・診断）をそのまま使う。
   ===================================================================== */
(() => {
  const T = { tab: ["rooms", "rec", "train", "models"].includes(load("statsTab")) ? load("statsTab") : "rooms", data: null, room: null, loading: false };
  const n1 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "-" : (Math.round(Number(v) * 10) / 10).toLocaleString("ja-JP"));
  const usd = (v) => (v ? `$${Number(v).toFixed(2)}` : "-");
  const when = (iso) => {
    if (!iso) return "-";
    const d = new Date(String(iso).replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? String(iso).slice(5, 16) : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  const trig = { manual: "画面から", idle: "空き時間", "post-match": "試合後", cli: "CLI" };
  const trigName = (id) => T.data?.triggerDefs?.find((d) => d.id === id)?.label ?? id;

  function setTab(t) {
    T.tab = t; save("statsTab", t);
    $$(".st-tabs [data-st]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.st === t)));
    $("#stRooms").hidden = t !== "rooms";
    $("#stRec").hidden = t !== "rec";
    $("#stTrain").hidden = t !== "train";
    $("#stModels").hidden = t !== "models";
    // 試合の記録は index.html の描画（隠れている間は幅が 0 なので、出した時に描き直す）
    if (t === "rec" && typeof mark === "function") mark("rail", "chart", "runhead", "table");
    render();
  }
  $$(".st-tabs [data-st]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.st)));

  async function statsShow() {
    setTab(T.tab);
    if (T.loading) return;
    T.loading = true;
    try { T.data = await jget("/api/stats"); render(); } catch { $("#stRooms").innerHTML = `<div class="empty">統計を読めませんでした。サーバが動いているか確かめてください。</div>`; } finally { T.loading = false; }
  }
  window.statsShow = statsShow;

  function render() {
    if (!T.data) return;
    if (T.tab === "rooms") renderRooms();
    else if (T.tab === "train") renderTrain();
    else if (T.tab === "models") renderModels();
  }

  /* ---------- ルームと試合 ---------- */
  function renderRooms() {
    const d = T.data, runs = d.runs, real = runs.filter((r) => r.turns >= 5);
    const cost = runs.reduce((s, r) => s + r.llm.costUsd, 0);
    const llmRuns = runs.filter((r) => r.llm.calls > 0);
    const dir = llmRuns.reduce((s, r) => s + r.llm.directedPhases, 0), ph = llmRuns.reduce((s, r) => s + r.llm.phases, 0);
    const acc = d.training.filter((t) => t.accepted).length;
    const best = d.rooms.filter((r) => r.highScore !== null).sort((a, b) => b.highScore - a.highScore)[0];
    const tile = (label, v, sub) => `<div class="tile"><span>${esc(label)}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const tiles = [
      tile("試合", fmt(runs.length), `${d.rooms.length} ルーム・5ターン以上 ${real.length} 試合`),
      tile("一番の得点", best ? fmt(best.highScore) : "-", best ? `ルーム ${best.room}` : ""),
      tile("LLM の費用（試合中）", usd(cost), llmRuns.length ? `${llmRuns.length} 試合・1試合 ${usd(cost / llmRuns.length)}・${fmt(llmRuns.reduce((s, r) => s + r.llm.calls, 0))} 回` : "LLM を使った試合なし"),
      tile("LLM が動かした手", pct(dir, ph), ph ? `${fmt(dir)} / ${fmt(ph)} 手（LLM を使った試合。LLM が手を決めた・LLM の目標で方策が動いた）` : ""),
      tile("学習", `${acc} / ${d.training.length}`, "採用 / 回数（確かめ用の地図ではっきり良くなった時だけ採用）"),
      (() => {
        const tr = runs.filter((r) => r.triggers), tt = tr.reduce((s, r) => s + r.turns, 0);
        if (!tr.length) return tile("きっかけ", "-", "記録を始めてからの試合がまだありません");
        const sum = {};
        for (const r of tr) for (const [k, v] of Object.entries(r.triggers.counts)) sum[k] = (sum[k] || 0) + v;
        const total = Object.values(sum).reduce((a, b) => a + b, 0);
        const top = Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(trigName(k))} ${v}`).join("・");
        return tile("きっかけ（100ターンあたり）", n1(tt ? (total / tt) * 100 : 0), `${tr.length} 試合・${top}`);
      })(),
    ].join("");

    const ends = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join("・");
    const roomRows = d.rooms.map((r) => `<tr data-room="${r.room}" aria-selected="${T.room === r.room}">
      <td><b>${r.room}</b></td><td class="n">${fmt(r.matches)}</td><td class="n">${fmt(r.highScore)}</td>
      <td class="n">${fmt(r.bestPerTurn)}</td><td class="n">${fmt(r.avgPerTurn)}</td><td class="n">${fmt(r.totalTurns)}</td>
      <td>${r.mapDimensions ? `${r.mapDimensions[0]}×${r.mapDimensions[1]}` : "-"}</td><td>${r.webMap === null ? "-" : r.webMap ? "あり" : "なし"}</td>
      <td class="n ${r.putDamage < 0 ? "neg" : ""}">${r.putDamage ? fmt(r.putDamage) : "-"}</td><td class="n">${usd(r.llmCostUsd)}</td><td class="wrap dim">${ends(r.endReasons)}</td></tr>`).join("");

    const shown = T.room === null ? runs : runs.filter((r) => r.room === T.room);
    const known = new Set((typeof S !== "undefined" ? S.runs : []).map((r) => r.id));
    const runRows = shown.map((r) => `<tr data-run="${esc(r.runId)}" title="${known.has(r.runId) ? "押すと「試合の記録」で開く" : ""}">
      <td>${esc(when(r.startedAt))}</td><td>${r.room ?? "-"}</td><td class="n">${fmt(r.turns)}</td>
      <td class="n">${r.official !== null ? fmt(r.official) : `<span class="dim" title="推定">${fmt(r.estimated)}</span>`}</td><td class="n">${fmt(r.perTurn)}</td>
      <td class="n ${r.putDamage < 0 ? "neg" : ""}">${r.putDamage ? fmt(r.putDamage) : "-"}</td>
      <td class="n ${r.gap !== null && Math.abs(r.gap) > 1000 ? "neg" : ""}" title="公式 − 推定。大きいと推定が見落としたもの（当てられた得点など）がある">${r.gap === null ? "-" : fmt(r.gap)}</td>
      <td class="wrap dim">${esc(r.endReason || "-")}</td><td>${esc(r.policyModel || "-")}</td>
      <td>${r.llm.calls ? `${esc(r.llm.model || "-")}${r.llm.effort ? ` <span class="dim">${esc(r.llm.effort)}</span>` : ""}` : `<span class="dim">なし</span>`}</td>
      <td class="n">${r.llm.calls ? fmt(r.llm.calls) : "-"}</td><td class="n">${usd(r.llm.costUsd)}</td>
      <td class="n">${r.llm.calls ? pct(r.llm.directedPhases, r.llm.phases) : "-"}</td>
      <td class="n" title="${r.triggers ? esc(Object.entries(r.triggers.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${trigName(k)} ${v}`).join("\n") || "鳴らなかった") : "記録を始める前の試合"}">${r.triggers ? fmt(Object.values(r.triggers.counts).reduce((a, b) => a + b, 0)) : "-"}</td></tr>`).join("");

    $("#stRooms").innerHTML = `<div class="tiles">${tiles}</div>
      <section><div class="st-h"><h2>ルーム</h2><span class="dim">行を押すと、そのルームの試合だけを下に出す。1ターンの得点は5ターン以上の試合から（公式があれば公式、なければ推定）</span></div>
        <div class="stbl-wrap"><table class="stbl"><thead><tr><th>ルーム</th><th class="n">試合</th><th class="n">最高</th><th class="n">1ターン 最高</th><th class="n">1ターン 平均</th><th class="n">全ターン</th><th>大きさ</th><th>Webマップ</th><th class="n">当てられた</th><th class="n">LLM 費用</th><th>終わり方</th></tr></thead><tbody>${roomRows || `<tr><td colspan="11" class="dim">まだ試合がありません</td></tr>`}</tbody></table></div></section>
      <section><div class="st-h"><h2>試合${T.room !== null ? `（ルーム ${T.room}）` : ""}</h2><span class="dim">得点は公式（薄い字は推定）。「ずれ」は公式 − 推定。「LLM が動かした」は、LLM が手を決めた（前の構成）か、LLM の目標で方策が動いた（今の構成）手の割合</span>${T.room !== null ? `<button class="btn quiet" type="button" id="stAllRooms">全部のルーム</button>` : ""}</div>
        <div class="stbl-wrap"><table class="stbl"><thead><tr><th>開始</th><th>ルーム</th><th class="n">ターン</th><th class="n">得点</th><th class="n">1ターン</th><th class="n">当てられた</th><th class="n">ずれ</th><th>終わり方</th><th>方策</th><th>LLM</th><th class="n">呼んだ回数</th><th class="n">費用</th><th class="n">LLM が動かした</th><th class="n" title="試合中の LLM を呼ぶきっかけが鳴った回数（いまは記録するだけ）。マウスを載せると内訳">きっかけ</th></tr></thead><tbody>${runRows || `<tr><td colspan="14" class="dim">試合がありません</td></tr>`}</tbody></table></div></section>`;
    $$("#stRooms tr[data-room]").forEach((tr) => tr.addEventListener("click", () => { const r = Number(tr.dataset.room); T.room = T.room === r ? null : r; renderRooms(); }));
    $("#stAllRooms")?.addEventListener("click", () => { T.room = null; renderRooms(); });
    $$("#stRooms tr[data-run]").forEach((tr) => tr.addEventListener("click", () => {
      const id = tr.dataset.run;
      if (!known.has(id) || typeof setFocus !== "function") return;
      setFocus(id);
      setTab("rec");
    }));
  }

  /* ---------- 学習の推移（モデルごとの小さなグラフ: 学習1回ごとの差±標準誤差。塗り＝採用、白抜き＝見送り） ---------- */
  function renderTrain() {
    const d = T.data, list = d.training, models = d.models.list;
    const by = {};
    for (const t of [...list].reverse()) (by[t.model] ||= []).push(t);
    const name = (id) => models.find((m) => m.id === id)?.name ?? id;
    const ids = [...models.map((m) => m.id).filter((id) => by[id]), ...Object.keys(by).filter((id) => !models.some((m) => m.id === id))];
    const boxes = ids.map((id) => {
      const ts = by[id], acc = ts.filter((t) => t.accepted).length;
      return `<div class="box"><h3>${esc(name(id))}<span>${ts.length} 回・採用 ${acc}</span></h3><svg data-model="${esc(id)}" role="img" aria-label="${esc(name(id))}の学習ごとの差"></svg></div>`;
    }).join("");
    const rows = list.map((t) => `<tr><td>${esc(when(t.at))}</td><td>${esc(name(t.model))}</td><td>${esc(trig[t.trigger] || t.trigger || "-")}</td><td>${t.room ?? "いろいろ"}</td>
      <td class="n">${fmt(t.generations)}</td><td class="n">${fmt(t.episodes)}</td><td class="n">${n1(t.a)} → ${n1(t.b)}</td><td class="n">${t.diff > 0 ? "+" : ""}${n1(t.diff)} ± ${n1(t.se)}</td>
      <td>${t.accepted ? "<b>採用</b>" : '<span class="dim">見送り</span>'}</td><td class="n">${Math.round(t.ms / 60000) || "<1"} 分</td></tr>`).join("");
    $("#stTrain").innerHTML = `<section><div class="st-h"><h2>学習ごとの差</h2><span class="dim">学習に使っていない地図での、学習前 → 後の差（± 標準誤差）。標準以外のモデルはそのモデルの目的の値なので、モデルどうしでは比べられない</span></div>
        <div class="st-key"><span><i style="background:var(--ink)"></i>採用</span><span><i style="border:1.5px solid var(--ink3);width:7px;height:7px"></i>見送り</span></div>
        <div class="mini">${boxes || '<div class="dim">まだ学習の記録がありません</div>'}</div></section>
      <section><div class="st-h"><h2>学習の記録</h2><span class="dim">新しい順（var/policy/train-log.jsonl）</span></div>
        <div class="stbl-wrap"><table class="stbl"><thead><tr><th>日時</th><th>モデル</th><th>きっかけ</th><th>地図</th><th class="n">世代</th><th class="n">試合</th><th class="n">前 → 後</th><th class="n">差</th><th>結果</th><th class="n">時間</th></tr></thead><tbody>${rows || `<tr><td colspan="10" class="dim">まだありません</td></tr>`}</tbody></table></div></section>`;
    $$("#stTrain svg[data-model]").forEach((svg) => drawTrain(svg, by[svg.dataset.model]));
  }

  const tip = document.createElement("div");
  tip.className = "st-tip"; tip.hidden = true; document.body.appendChild(tip);
  function drawTrain(svg, ts) {
    const W = Math.max(200, svg.clientWidth || 300), H = 130, padL = 40, padR = 8, padT = 8, padB = 18;
    const lo = Math.min(0, ...ts.map((t) => t.diff - t.se)), hi = Math.max(0, ...ts.map((t) => t.diff + t.se));
    const span = hi - lo || 1;
    const y = (v) => padT + (1 - (v - lo) / span) * (H - padT - padB);
    const x = (i) => padL + (ts.length === 1 ? (W - padL - padR) / 2 : (i / (ts.length - 1)) * (W - padL - padR));
    const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
    let g = ticks.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line${v === 0 ? "" : "2"})" stroke-width="1"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${n1(v)}</text>`).join("");
    g += ts.map((t, i) => {
      const cx = x(i), cy = y(t.diff);
      return `<g data-i="${i}"><line x1="${cx}" x2="${cx}" y1="${y(t.diff - t.se)}" y2="${y(t.diff + t.se)}" stroke="var(--ink3)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="4.5" fill="${t.accepted ? "var(--ink)" : "var(--panel)"}" stroke="${t.accepted ? "var(--panel)" : "var(--ink3)"}" stroke-width="${t.accepted ? 2 : 1.5}"/>
        <circle cx="${cx}" cy="${cy}" r="12" fill="transparent"/></g>`;
    }).join("");
    g += `<text x="${padL}" y="${H - 2}">${esc(when(ts[0].at))}</text>` + (ts.length > 1 ? `<text x="${W - padR}" y="${H - 2}" text-anchor="end">${esc(when(ts[ts.length - 1].at))}</text>` : "");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = g;
    svg.onmousemove = (e) => {
      const gEl = e.target.closest("g[data-i]");
      if (!gEl) { tip.hidden = true; return; }
      const t = ts[Number(gEl.dataset.i)];
      tip.innerHTML = `<b>${esc(when(t.at))}</b>・${esc(trig[t.trigger] || t.trigger || "-")}<br>前 ${n1(t.a)} → 後 ${n1(t.b)}（差 ${t.diff > 0 ? "+" : ""}${n1(t.diff)} ± ${n1(t.se)}）<br>${t.accepted ? "採用" : "見送り"}・${fmt(t.generations)} 世代`;
      tip.hidden = false;
      tip.style.left = `${Math.min(innerWidth - 270, e.clientX + 12)}px`; tip.style.top = `${e.clientY + 12}px`;
    };
    svg.onmouseleave = () => { tip.hidden = true; };
  }

  /* ---------- モデルの特性 ---------- */
  function renderModels() {
    const m = T.data.models;
    const rows = m.list.map((x) => {
      const p = x.profile;
      return `<tr><td><b>${esc(x.name)}</b> <span class="dim">${esc(x.trait || x.id)}</span>${x.id === m.play ? ' <span class="badge b-continue">試合で使う</span>' : ""}</td>
        <td>${x.trained ? esc(when(x.updatedAt)) : '<span class="dim">まだ（バランスと同じ）</span>'}</td>
        <td class="n">${p ? n1(p.perTurn) : "-"}</td><td class="n">${p ? n1(p.itemPerTurn) : "-"}</td><td class="n">${p ? `${Math.round(p.winRate * 100)}%` : "-"}</td>
        <td class="n">${p ? n1(p.hitsPer100) : "-"}</td><td class="n">${p ? n1(p.hitByPer100) : "-"}</td><td class="n">${p ? n1(p.hazardsPer100) : "-"}</td>
        <td class="wrap">${(x.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join(" ") || '<span class="dim">-</span>'}</td><td class="dim">${p ? esc(when(p.measuredAt)) : "-"}</td></tr>`;
    }).join("");
    $("#stModels").innerHTML = `<section><div class="st-h"><h2>モデルの特性</h2><span class="dim">全部のモデルを同じ 24 枚の地図・同じ相手で打たせた結果（シミュレータ）。当てた／当てられた／罠は 100 ターンあたり。パラメータと測り直しは「学習」›「モデルとパラメータ」</span></div>
      <div class="stbl-wrap"><table class="stbl"><thead><tr><th>モデル</th><th>学習</th><th class="n">点/ターン</th><th class="n">回収/ターン</th><th class="n">勝ち</th><th class="n">当てた</th><th class="n">当てられた</th><th class="n">罠</th><th>特性</th><th>測った日時</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  addEventListener("resize", () => { if (document.body.classList.contains("view-stats") && T.tab === "train") renderTrain(); });
  if (document.body.classList.contains("view-stats")) statsShow();
})();
