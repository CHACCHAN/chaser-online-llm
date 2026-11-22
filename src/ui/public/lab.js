/* =====================================================================
   「学習」画面: 地図を作る → 並べた地図で学習 → 統計。並べた地図は全部同時に再生する。
   index.html の共通の関数（$, $$, esc, fmt, jget, tileImg, fallbackStyle, save, load, MAPC, mark）を使う。
   API は /api/lab/…（シミュレータだけを使い、CHaser サーバには触れない）。状態の変化は SSE の "lab" で届く。
   ===================================================================== */
(() => {
  const L = { view: ["lab", "stats"].includes(load("view")) ? load("view") : "match", lab: null, data: null, which: "before", t: 0, playing: false, timer: 0, cards: [], tab: load("labTab") === "models" ? "models" : "maps", models: null };
  const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "-" : (Math.round(Number(v) * 10) / 10).toLocaleString("ja-JP"));
  const sign = (v) => (v > 0 ? "+" : "") + num(v);

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  /* ---------- 画面の切り替え ---------- */
  function setView(v) {
    L.view = v; save("view", v);
    document.body.classList.toggle("view-lab", v === "lab");
    document.body.classList.toggle("view-stats", v === "stats");
    $(".work").hidden = v !== "match";
    $("#lab").hidden = v !== "lab";
    $("#stats").hidden = v !== "stats";
    $("#viewMatch").setAttribute("aria-pressed", String(v === "match"));
    $("#viewLab").setAttribute("aria-pressed", String(v === "lab"));
    $("#viewStats").setAttribute("aria-pressed", String(v === "stats"));
    if (v === "lab") { refresh(); loadSet(); loadRooms(); loadModels(); setTab(L.tab); } else { stopPlay(); if (typeof mark === "function") mark("map"); }
    if (v === "stats" && typeof window.statsShow === "function") window.statsShow();
  }
  $$(".views [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  async function refresh() {
    try { const r = await jget("/api/lab"); L.lab = r.lab; renderState(); } catch {}
  }
  /** 「地図の種類」: いろいろ（ランダム）か、遊んだルームに似せるか */
  async function loadRooms() {
    try {
      const r = await jget("/api/lab/rooms"), sel = $("#lmRoom"), keep = load("labRoom") ?? sel.value;
      const rng = (a) => (a[0] === a[1] ? `${a[0]}` : `${a[0]}〜${a[1]}`), sz = (a) => (a[0] === a[1] ? `${a[0]}×${a[0]}` : `${a[0]}〜${a[1]}四方`);
      sel.innerHTML = `<option value="">いろいろ（大きさ 15〜39・ランダム）</option>` + r.rooms.map((x) =>
        `<option value="${x.room}">ルーム ${x.room} に似せる（${sz(x.size)}・${rng(x.turns)}ターン${x.realMaps ? `・本物の地図 ${x.realMaps} 枚` : ""}）</option>`).join("");
      sel.value = [...sel.options].some((o) => o.value === String(keep)) ? String(keep) : "";
    } catch {}
  }

  async function loadSet() {
    try {
      const r = await jget("/api/lab/set");
      if (!r.after && L.which === "after") L.which = "before";
      if (r.after && L.lab?.set?.after != null && !L.data?.after) L.which = "after";
      L.data = r;
      buildCards();
      renderState();
    } catch {}
  }

  window.labOnState = (s) => {
    const prev = L.lab;
    L.lab = s;
    renderDot();
    if (L.view !== "lab") return;
    renderState();
    // 仕事が終わった・地図の組が変わったら、地図と記録を読み直す
    const setChanged = (prev?.set?.id ?? null) !== (s.set?.id ?? null);
    if ((prev?.job && !s.job) || setChanged) { loadSet(); loadModels(); }
  };

  /* ---------- モデル（特性ごと）とパラメータ ---------- */
  function setTab(t) {
    L.tab = t; save("labTab", t);
    $$(".lab-tabs [data-lt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lt === t)));
    $("#labModels").hidden = t !== "models";
    $("#labGrid").hidden = t !== "maps";
    $("#labPlay").hidden = t !== "maps" || !runsNow();
    if (t === "models") { stopPlay(); renderModels(); }
  }
  $$(".lab-tabs [data-lt]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.lt)));

  async function loadModels() {
    try {
      L.models = await jget("/api/lab/models");
      const sel = $("#lmModel"), keep = load("labModel") ?? L.models.play;
      sel.innerHTML = L.models.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}（${esc(m.trait || m.id)}）${m.id === L.models.play ? "・試合で使う" : ""}</option>`).join("");
      sel.value = L.models.models.some((m) => m.id === keep) ? keep : L.models.play;
      renderModels();
    } catch {}
  }
  const modelName = (id) => L.models?.models.find((m) => m.id === id)?.name ?? id;

  function renderModels() {
    const box = $("#labModels"), d = L.models;
    if (!d || L.tab !== "models") return;
    const busy = !!L.lab?.job && L.lab.job.trigger !== "idle";
    const when = (iso) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
    const stat = (label, v, title) => `<div title="${esc(title)}"><span>${esc(label)}</span><b>${v}</b></div>`;
    const cards = d.models.map((m) => {
      const p = m.profile, lt = m.lastTrain, isPlay = m.id === d.play;
      const goal = Object.entries(m.objective || {}).filter(([, w]) => w).map(([k, w]) => `${({ item: "アイテム", put: "当てた", putDamage: "当てられた", hazard: "罠1回" })[k] || k}${k === "hazard" ? ` ${w}` : ` ×${1 + w}`}`).join("・");
      return `<div class="model${isPlay ? " play" : ""}">
        <div class="mt"><b>${esc(m.name)}</b><span class="chip trait">${esc(m.trait || m.id)}</span>${isPlay ? `<span class="badge b-continue">試合で使う</span>` : ""}</div>
        <div class="desc">${esc(m.description)}</div>
        <div class="dim" title="学習で何を目的にするか（knowledge/styles.json の objective・fixed）">目的: 自分の得点${goal ? `＋${esc(goal)}` : ""}${m.fixed ? `／固定: ${esc(Object.entries(m.fixed).map(([k, v]) => `${k}=${v}`).join(", "))}` : ""}</div>
        ${m.tags?.length ? `<div class="chips">${m.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
        ${p ? `<div class="mstats">${stat("点/ターン", num(p.perTurn), "1ターンあたりの得点")}${stat("回収/ターン", num(p.itemPerTurn), "1ターンあたりのアイテム得点")}${stat("勝ち", `${Math.round(p.winRate * 100)}%`, "相手に勝った地図の割合")}${stat("当てた/100T", num(p.hitsPer100), "100ターンあたりに相手に当てた回数（攻撃性）")}${stat("当てられた/100T", num(p.hitByPer100), "100ターンあたりに当てられた回数")}${stat("罠/100T", num(p.hazardsPer100), "100ターンあたりに罠を踏んだ回数")}</div>` : `<div class="dim">特性はまだ測っていません</div>`}
        <div class="foot"><span>${m.trained ? `学習 ${esc(when(m.updatedAt))}` : "まだ学習していない（バランスから始まる）"}${lt ? `・最後の学習 ${num(lt.a)}→${num(lt.b)} ${lt.accepted ? "採用" : "見送り"}` : ""}</span>${isPlay ? "" : `<button class="btn quiet" type="button" data-play="${esc(m.id)}">試合で使う</button>`}</div>
      </div>`;
    }).join("");
    // パラメータの表: 行 = パラメータ、列 = モデル（値と範囲の中の位置。最後の学習での変化）
    const pos = (v, q) => (q.max > q.min ? Math.min(100, Math.max(0, ((v - q.min) / (q.max - q.min)) * 100)) : 0);
    const fmtv = (v, q) => (q.integer ? String(Math.round(v)) : Math.abs(v) >= 100 ? num(v) : (Math.round(v * 1000) / 1000).toString());
    const head = `<tr><th>パラメータ</th><th>範囲（初め）</th>${d.models.map((m) => `<th>${esc(m.name)}</th>`).join("")}</tr>`;
    const rows = d.params.map((q) => `<tr><td class="pn"><code>${esc(q.name)}</code><div class="doc">${esc(q.doc)}</div></td><td class="rg">${fmtv(q.min, q)}〜${fmtv(q.max, q)}<br />（${fmtv(q.init, q)}）</td>${d.models.map((m) => {
      const v = m.params[q.name], fixed = m.fixed && q.name in m.fixed, lt = m.lastTrain, prev = lt?.accepted && lt.before ? lt.before[q.name] : undefined;
      const diff = prev !== undefined && Math.abs(v - prev) > (q.max - q.min) * 0.005 ? `<span class="d ${v > prev ? "up" : "down"}" title="最後に採用した学習での変化">${v > prev ? "↑" : "↓"} ${fmtv(prev, q)}→</span>` : "";
      return `<td><div class="pv${fixed ? " fixed" : ""}"><b>${fmtv(v, q)}</b><div class="bar" title="範囲の中の位置（薄い印は初めの値）"><i class="init" style="left:calc(${pos(q.init, q)}% - 1px)"></i><i style="left:calc(${pos(v, q)}% - 1px)"></i></div>${diff}</div></td>`;
    }).join("")}</tr>`).join("");
    box.innerHTML = `<div class="mhead"><span>試合で使うモデル: <b>${esc(modelName(d.play))}</b>（次の試合から。試合後の学習もこのモデルを育てる）</span><button class="btn" type="button" id="lmMeasure" ${busy ? "disabled" : ""} title="全部のモデルを同じ地図・同じ相手（拾う・狙う・バランスの自分）で打たせて、特性を比べる">特性を測る</button><span class="dim">特性の札はモデルどうしを比べて付けます。学習で採用されると自動で測り直します</span></div>
      <div class="mgrid">${cards}</div>
      <div><div class="mhead" style="margin-bottom:8px"><b>学習するパラメータ</b><span class="dim">評価関数 src/solver/evaluator.ts の PARAM_SPACE。値は学習で決まり、各モデルの var/policy/…json に保存される。↑↓ は最後に採用した学習での変化</span></div>
      <div class="ptable-wrap"><table class="ptable"><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>`;
    $("#lmMeasure").addEventListener("click", async () => {
      try { await post("/api/lab/measure"); } catch (err) { $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
    });
    $$("[data-play]", box).forEach((b) => b.addEventListener("click", async () => {
      try { L.models = await post("/api/lab/play-model", { model: b.dataset.play }); loadModels(); } catch (err) { $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
    }));
  }

  function renderDot() {
    const job = L.lab?.job;
    $("#labDot").hidden = !job;
  }

  /* ---------- 流れ（ヘッダ）・状態・統計 ---------- */
  function renderFlowLab() {
    const st = L.lab, job = st?.job, set = st?.set;
    const cur = job ? (job.kind === "maps" ? "maps" : job.kind === "measure" ? "stats" : job.coach?.state === "running" ? "coach" : "train") : set?.after != null ? "stats" : set ? "train" : "maps";
    $("#labFlowCoach").hidden = !st?.coachEnabled;
    const order = ["maps", "train", "coach", "stats"], ci = order.indexOf(cur);
    $$("#labFlow li").forEach((li) => {
      const i = order.indexOf(li.dataset.step), isCur = i === ci;
      li.classList.toggle("done", i < ci);
      if (isCur) { li.setAttribute("aria-current", "step"); li.dataset.tone = job ? "active" : cur === "stats" ? "ok" : "todo"; } else { li.removeAttribute("aria-current"); delete li.dataset.tone; }
    });
  }

  function renderState() {
    const st = L.lab; if (!st) return;
    renderFlowLab(); renderDot();
    const job = st.job, set = st.set, busy = !!job && job.trigger !== "idle";
    $("#lmMake").disabled = busy;
    $("#ltStart").disabled = busy || !set || !L.data?.before;
    $("#ltStop").hidden = !job;
    $("#ltIdle").checked = !!st.idle.enabled;
    syncCoach(st);

    const parts = [];
    if (job) {
      const sec = (Date.now() - new Date(job.startedAt)) / 1000;
      const what = (job.kind === "measure" ? "モデルの特性を測っています" : job.trigger === "idle" ? "空き時間の学習（毎回新しい地図）" : job.trigger === "post-match" ? "試合後の学習" : job.kind === "maps" ? "地図を打たせています" : "学習中") + (job.kind !== "measure" && job.modelName ? `・${job.modelName}` : "");
      const gens = job.generations || [];
      const g = gens[gens.length - 1];
      parts.push(`<div class="stats"><span><b style="font-size:var(--t-m)">${esc(what)}</b></span><span class="dim">${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒${job.minutes ? ` / ${num(job.minutes)}分` : ""}</span>${g ? `<span class="dim">${gens.length} 世代・${fmt(g.episodes)} 試合・候補の最良 ${num(g.best)} 点/ターン</span>` : ""}</div>`);
      if (job.minutes) parts.push(`<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(1, sec / (job.minutes * 60)) * 100)}"><i style="width:${Math.min(1, sec / (job.minutes * 60)) * 100}%"></i></div>`);
      parts.push(`<div class="msg">${esc(job.message || "")}</div>`);
    } else if (st.last?.error || st.last?.stopped) {
      parts.push(`<div class="msg">${esc(st.last.message)}</div>`);
    }
    if (set && set.before != null) {
      const v = set.validation;
      const s = [`<span>並べた地図 ${set.maps.length} 枚</span>`];
      if (set.after != null) {
        s.push(`<span>学習前 <b>${num(set.before)}</b> → 学習後 <b>${num(set.after)}</b> 点/ターン <span class="${set.after >= set.before ? "up" : "down"}">${sign(set.after - set.before)}</span></span>`);
        if (v && v.n) s.push(`<span title="学習に使っていない地図で確かめた結果。保存するかはこれで決める">確かめ用の地図 ${v.n} 枚: ${num(v.a)} → ${num(v.b)}（差 ${sign(v.diff)}±${num(v.se)}・勝ち ${v.wins}/${v.n}）</span>`);
        s.push(set.accepted ? `<span class="badge b-continue">保存した（次の試合から使う）</span>` : `<span class="badge b-wait">保存しない（はっきり良くなっていない）</span>`);
      } else s.push(`<span>今の方策 <b>${num(set.before)}</b> 点/ターン</span>`);
      parts.push(`<div class="stats">${s.join("")}</div>`);
      const vb = versus(L.data.before), va = versus(L.data.after);
      if (vb) {
        const t = [`<span title="相手がいる地図で、自分の得点が他の全員より高かった数">相手に勝った ${vb.won}/${vb.n}${va ? ` → <b>${va.won}/${va.n}</b>` : ""} 地図</span>`];
        t.push(`<span title="置いて当てた得点の合計（シミュレータでの仮の値 putHit）">当てた ${fmt(vb.put)}${va ? ` → ${fmt(va.put)}` : ""}</span>`);
        t.push(`<span title="当てられた得点の合計">当てられた ${fmt(vb.pd)}${va ? ` → <span class="${va.pd >= vb.pd ? "up" : "down"}">${fmt(va.pd)}</span>` : ""}</span>`);
        parts.push(`<div class="stats">${t.join("")}</div>`);
      }
    }
    const o = st.opponents;
    if (o) parts.push(`<div class="msg dim" title="knowledge/train-config.json の oppGreedy・oppHunter・oppSelf と var/policy/league.json">相手の種類の重み: 拾う ${num(o.greedy)}・狙う ${num(o.hunter)}・自分 ${num(o.self)}（自己対戦の相手に残っている前の自分 ${o.league} 人。学習で採用されるたびに増える）</div>`);
    const coach = renderCoach(st);
    if (coach) parts.push(coach);
    if (st.idle.enabled && st.idle.reason) parts.push(`<div class="msg">${esc(st.idle.reason)}</div>`);
    $("#labStatus").innerHTML = parts.join("");
  }

  /** 学習の LLM（学習が終わるたびに学習環境を直す）の動き・結果 */
  const COACH_WHAT = { evaluator: "評価関数", profiles: "地図の作り方", trainConfig: "学習のやり方", styles: "モデル", review: "ハーネスへの要望" };
  const COACH_TRIGGER = { manual: "並べた地図の学習", idle: "空き時間の学習", "post-match": "試合後の学習" };
  // 相手がいた地図での勝ち数・当てた／当てられた得点
  function versus(runs) {
    const rs = (runs || []).filter((r) => r && r.won !== null && r.won !== undefined);
    if (!rs.length) return null;
    return { won: rs.filter((r) => r.won).length, n: rs.length, put: rs.reduce((a, r) => a + (r.put || 0), 0), pd: rs.reduce((a, r) => a + (r.putDamage || 0), 0) };
  }
  function renderCoach(st) {
    const running = st.job?.coach?.state === "running";
    if (running) {
      const sec = (Date.now() - new Date(st.job.coach.startedAt)) / 1000;
      return `<div class="coach"><div class="head"><b>学習の LLM が学習環境を直しています</b><span class="dim">${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒</span></div><div class="msg">結果と理論値の目安との差を読んで評価関数・地図の作り方・学習のやり方・モデルを直し、直したものは確かめて、弱くなっていれば戻します</div></div>`;
    }
    const c = st.lastCoach;
    if (!c) return st.coachEnabled ? "" : `<div class="msg">学習の LLM は切っています（上の「学習の LLM」で入れられます）</div>`;
    const when = new Date(c.finishedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const status = { ok: "", timeout: "（時間切れ）", dead: "（止まった）", stopped: "（試合が始まったので止めて、改修は戻した）" }[c.status] ?? "";
    const items = c.changes.map((x) => `<li class="${x.accepted ? "ok" : "ng"}">${esc(COACH_WHAT[x.what] || x.what)}: ${x.accepted ? "採用" : "戻した"} — ${esc(x.detail.replace(/^(採用|戻した)[:：]\s*/, ""))}</li>`);
    if (c.reverted?.length) items.push(`<li class="ng">範囲の外の変更を戻した: ${esc(c.reverted.join("、"))}</li>`);
    const g = c.gap;
    const gap = g ? `<div class="msg" title="同じ地図・同じ相手で、全部のワープの行き先を知っている・深く考える方策と比べた（src/sim/oracle.ts）">理論値の目安に届いている割合 <b>${Math.round(g.ratio * 100)}%</b>（今 ${fmt(g.policy)} / 目安 ${fmt(g.reference)} 点/ターン。差の内訳: 知らないこと +${fmt(g.knowledgeGap)}・考えが浅いこと +${fmt(g.searchGap)}）</div>` : "";
    return `<div class="coach"><div class="head"><b>学習の LLM${esc(status)}</b><span class="dim">${esc(when)}・${esc(COACH_TRIGGER[c.trigger] || c.trigger)}の後・記録 ${esc(c.dir)}</span></div>${gap}${c.summary ? `<div class="say">${esc(c.summary)}</div>` : ""}${items.length ? `<ul>${items.join("")}</ul>` : `<div class="dim">直したものは無し</div>`}</div>`;
  }

  $("#lmMake").addEventListener("click", async () => {
    stopPlay();
    save("labRoom", $("#lmRoom").value);
    save("labModel", $("#lmModel").value);
    setTab("maps");
    try { await post("/api/lab/maps", { n: Number($("#lmN").value) || 12, room: $("#lmRoom").value === "" ? null : Number($("#lmRoom").value), model: $("#lmModel").value }); }
    catch (err) { $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });
  $("#ltStart").addEventListener("click", async () => {
    stopPlay();
    save("labModel", $("#lmModel").value);
    try { await post("/api/lab/train", { minutes: Number($("#ltMin").value) || 5, model: $("#lmModel").value }); }
    catch (err) { $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });
  $("#ltStop").addEventListener("click", () => post("/api/lab/stop").catch(() => {}));
  /* ---------- 学習の LLM（入れるか・モデル・思考の深さ） ---------- */
  function syncCoach(st) {
    const c = st.coach || {}, on = !!st.coachEnabled;
    $("#lcOn").checked = on;
    const mi = $("#lcModel"), es = $("#lcEffort");
    if (document.activeElement !== mi) mi.value = c.model || "";
    mi.placeholder = c.fallbackModel ? `試合と同じ（${c.fallbackModel}）` : "試合の LLM と同じ";
    if (document.activeElement !== es) {
      const eff = (typeof S !== "undefined" && S.efforts) || ["low", "medium", "high", "xhigh", "max"];
      es.innerHTML = `<option value="">思考: 試合と同じ${c.fallbackEffort ? `（${esc(c.fallbackEffort)}）` : ""}</option>` + eff.map((e) => `<option>${esc(e)}</option>`).join("");
      es.value = c.effort || "";
    }
    mi.disabled = es.disabled = !on;
  }
  async function saveCoach(patch, revert) {
    try { const r = await post("/api/lab/coach", patch); window.labOnState(r.lab); }
    catch (err) { revert?.(); $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  }
  $("#lcOn").addEventListener("change", (e) => saveCoach({ enabled: e.target.checked }, () => { e.target.checked = !e.target.checked; }));
  $("#lcModel").addEventListener("change", (e) => saveCoach({ model: e.target.value.trim() }));
  $("#lcEffort").addEventListener("change", (e) => saveCoach({ effort: e.target.value }));

  $("#ltIdle").addEventListener("change", async (e) => {
    try { const r = await post("/api/lab/idle", { enabled: e.target.checked }); window.labOnState(r.lab); }
    catch (err) { e.target.checked = !e.target.checked; $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });

  /* ---------- 並べた地図（全部同時に再生） ---------- */
  const runsNow = () => (L.data ? (L.which === "after" ? L.data.after : L.data.before) : null);
  const maxFrames = () => Math.max(0, ...(runsNow() || []).map((r) => r.trace.frames.length));

  function buildCards() {
    const grid = $("#labGrid"), d = L.data;
    stopPlay();
    if (!d?.set) { L.cards = []; $("#labPlay").hidden = true; return; }
    $("#lpWhich").hidden = !d.after;
    $$("#lpWhich button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.which === L.which)));
    grid.innerHTML = d.set.maps.map((m, i) => `<div class="mcard"><div class="cap" id="cap${i}"></div><canvas data-i="${i}" aria-label="地図 ${i + 1}"></canvas></div>`).join("");
    L.cards = d.set.maps.map((m, i) => ({ m, cv: $(`canvas[data-i="${i}"]`, grid), cap: $(`#cap${i}`, grid), off: null, g: null, at: -1, cell: 0 }));
    const runs = runsNow();
    $("#labPlay").hidden = !runs || L.tab !== "maps";
    L.t = 0;
    $("#lpSlider").max = String(Math.max(0, maxFrames() - 1));
    drawAll(true);
    if (runs) startPlay();
  }

  function sizeCard(c) {
    const w = c.m.width, h = c.m.height, avail = Math.max(120, c.cv.parentElement.clientWidth - 16);
    const cell = Math.max(3, Math.floor(avail / w));
    if (cell !== c.cell || !c.off) {
      c.cell = cell;
      c.cv.width = w * cell; c.cv.height = h * cell;
      c.off = document.createElement("canvas"); c.off.width = w * cell; c.off.height = h * cell;
      c.at = -2;   // 作り直し
    }
  }
  function tileAt(ctx, v, x, y, cell) {
    const img = tileImg(v);
    if (img) ctx.drawImage(img, x * cell, y * cell, cell, cell);
    else { const [bg] = fallbackStyle(v); ctx.fillStyle = bg; ctx.fillRect(x * cell, y * cell, cell, cell); }
  }
  /** タイルの層を frame f の状態にする（前へ進む時は変わったマスだけ描き直す） */
  function syncTiles(c, run, f) {
    const ctx = c.off.getContext("2d"); ctx.imageSmoothingEnabled = false;
    const base = run ? run.trace.grid : L.data.grids[c.i ?? L.cards.indexOf(c)];
    if (!base) return;
    if (c.at < -1 || f < c.at || !run) {
      c.g = base.map((r) => [...r]);
      for (let y = 0; y < c.g.length; y++) for (let x = 0; x < c.g[y].length; x++) tileAt(ctx, c.g[y][x], x, y, c.cell);
      c.at = -1;
    }
    if (!run) return;
    for (let i = c.at + 1; i <= f; i++) for (const [x, y, v] of run.trace.frames[i].changed) { c.g[y][x] = v; tileAt(ctx, v, x, y, c.cell); }
    c.at = f;
  }
  function drawCard(c, i, full) {
    const runs = runsNow(), run = runs ? runs[i] : null;
    if (full) c.at = -2;
    sizeCard(c);
    const f = run ? Math.min(L.t, run.trace.frames.length - 1) : -1;
    syncTiles(c, run, f);
    const ctx = c.cv.getContext("2d"); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c.off, 0, 0);
    if (!run) { c.cap.innerHTML = `<span>${esc(label(c.m))}</span><span class="r faint">打たせています…</span>`; return; }
    const tr = run.trace, fr = tr.frames[f], me = tr.players.findIndex((p) => p.self), cell = c.cell;
    // 自分の軌跡（直近 40 ターン。桂馬の動きはつなぎ、ワープ（3マス以上の跳び）は線を切る）
    const pts = tr.frames.slice(Math.max(0, f - 40), f + 1).map((q) => q.pos[me]);
    if (pts.length > 1) {
      ctx.strokeStyle = MAPC.trail; ctx.lineWidth = Math.max(1.5, cell * 0.3); ctx.lineJoin = "round"; ctx.globalAlpha = 0.8; ctx.beginPath();
      pts.forEach((p, k) => { const a = p[0] * cell + cell / 2, b = p[1] * cell + cell / 2, q = pts[k - 1]; if (k && Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) <= 2) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    tr.players.forEach((p, k) => {
      const [x, y] = fr.pos[k], r = Math.max(2.5, cell * 0.45);
      ctx.beginPath(); ctx.arc(x * cell + cell / 2, y * cell + cell / 2, r, 0, Math.PI * 2);
      // 自分＝青、相手の「自分」（同じ方策）＝紫、拾う・狙う＝赤
      ctx.fillStyle = k === me ? MAPC.self : p.kind?.startsWith("自分") ? MAPC.mirror : MAPC.enemy; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    });
    // 見出し: 地図・今の得点・この地図の結果（学習後があれば前→後）
    const before = L.data.before?.[i], after = L.data.after?.[i];
    const pt = (r) => r.score / Math.max(1, r.totalTurns);
    const res = before && after ? `<span class="${pt(after) >= pt(before) ? "up" : "down"}">${num(pt(before))}→${num(pt(after))}</span>` : `${num(pt(run))}`;
    const kinds = run.opponentKinds || [];
    const opp = kinds.length ? `<span class="dim" title="相手: ${esc(kinds.join("・"))}${run.won ? "（勝った）" : ""}">相手${kinds.length}${run.won ? "・勝" : ""}</span>` : "";
    const hit = run.putDamage ? `<span class="down" title="当てられた得点">被${fmt(run.putDamage)}</span>` : "";
    c.cap.innerHTML = `<span>${esc(label(c.m))}</span><b>${fmt(fr.scores[me])}</b>${opp}${hit}${run.hazardHits ? `<span class="down">罠${run.hazardHits}</span>` : ""}<span class="r" title="この地図の 1ターンあたりの得点">${res}</span>`;
  }
  const label = (m) => `${m.name.startsWith("real:") ? "本物" : "作った地図"} ${m.width}×${m.height}${m.webMap ? "" : "・全体なし"}`;
  function drawAll(full) {
    L.cards.forEach((c, i) => { c.i = i; drawCard(c, i, full); });
    const n = maxFrames();
    $("#lpSlider").value = String(Math.min(L.t, Math.max(0, n - 1)));
    $("#lpTurn").textContent = n ? `T${Math.min(L.t + 1, n)}/${n}` : "";
  }

  function startPlay() {
    if (!runsNow()) return;
    if (L.t >= maxFrames() - 1) { L.t = 0; drawAll(false); }
    L.playing = true; $("#lpPlay").textContent = "一時停止";
    const tick = () => {
      if (!L.playing) return;
      if (L.t >= maxFrames() - 1) { stopPlay(); return; }
      L.t += 1; drawAll(false);
      L.timer = setTimeout(tick, 1000 / Number($("#lpSpeed").value || 12));
    };
    L.timer = setTimeout(tick, 200);
  }
  function stopPlay() { L.playing = false; clearTimeout(L.timer); $("#lpPlay").textContent = "再生"; }
  $("#lpPlay").addEventListener("click", () => (L.playing ? stopPlay() : startPlay()));
  $("#lpSlider").addEventListener("input", (e) => { stopPlay(); L.t = Number(e.target.value); drawAll(false); });
  $$("#lpWhich button").forEach((b) => b.addEventListener("click", () => {
    L.which = b.dataset.which; L.t = 0; buildCards();
  }));
  // タイル画像が読み込まれたら描き直す（読み込み前は色で描いている）
  let tileRedraw = 0;
  window.labOnTile = () => { if (L.view !== "lab" || !L.cards.length) return; clearTimeout(tileRedraw); tileRedraw = setTimeout(() => drawAll(true), 150); };
  addEventListener("resize", () => { if (L.view === "lab" && L.cards.length) drawAll(true); });
  // 仕事の経過時間を進める
  setInterval(() => { if (L.view === "lab" && L.lab?.job) renderState(); }, 1000);

  window.setView = setView;
  setView(L.view); // 統計の画面で開いた時は、stats.js が読み込まれた所で中身を出す
  jget("/api/lab").then((r) => { if (!L.lab) { L.lab = r.lab; renderDot(); } }).catch(() => {});
})();
