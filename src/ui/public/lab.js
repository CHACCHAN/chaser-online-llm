/* =====================================================================
   「学習」画面: 方策・パラメータ・学習の進み具合・学習の記録・シミュレータの再生。
   index.html の共通の関数（$, esc, fmt, jget, tileImg, fallbackStyle, tileName, drawPlayer, save, load）を使う。
   API は /api/lab/…（シミュレータだけを使い、CHaser サーバには触れない）。状態の変化は SSE の "lab" で届く。
   ===================================================================== */
(() => {
  const L = { view: load("view") === "lab" ? "lab" : "match", ov: null, lab: null, run: null, frame: 0, playing: false, timer: 0, gridAt: -1, grid: null, roomFilled: false };

  const PARAM_JA = {
    distWeight: "距離の重み", unknownValue: "未知のマスの価値", holeCost: "穴を通る手間", revisitCost: "何度も通った穴",
    portalValue: "ワープの価値", enemyRadius: "敵を避ける距離", directiveBonus: "LLM の作戦目標の加点", clusterWeight: "まわりの点の加点",
    candidates: "目標の候補数", depth: "先読みの目標数", beam: "ビーム幅", discount: "先の価値の割引", scanValue: "見て分かるマスの価値", knightWeight: "桂馬を使う",
  };
  const TRIGGER_JA = { manual: "手動", idle: "空き時間", "post-match": "試合後", cli: "CLI" };
  const POLICY_JA = { current: "今の方策", default: "初期値の方策", solver: "前のソルバー" };
  const SOURCE_JA = { default: "初期値（学習で保存されたものはまだない）", train: "学習で保存", manual: "手で設定" };
  const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "-" : (Math.round(Number(v) * 10) / 10).toLocaleString("ja-JP"));
  const when = (iso) => { if (!iso) return "-"; const d = new Date(iso); return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
  const elapsedOf = (job) => Math.max(0, ((job.finishedAt ? new Date(job.finishedAt) : new Date()) - new Date(job.startedAt)) / 1000);
  const roomVal = (el) => { const v = el.value.trim(); return v === "" ? null : Number(v); };

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
    $(".work").hidden = v !== "match";
    $("#lab").hidden = v !== "lab";
    $("#viewMatch").setAttribute("aria-pressed", String(v === "match"));
    $("#viewLab").setAttribute("aria-pressed", String(v === "lab"));
    if (v === "lab") refresh();
    else if (typeof mark === "function") mark("map", "chart", "table");
  }
  $$(".views [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  async function refresh() {
    try {
      L.ov = await jget("/api/lab");
      L.lab = L.ov.lab;
      if (!L.roomFilled && S.st?.room) { $("#ltRoom").value = S.st.room; L.roomFilled = true; }
      renderPolicy(); renderParams(); renderJob(); renderHistory(); renderMaps(); renderDot();
    } catch (err) {
      $("#lpPolicy").innerHTML = `<span class="down">読み込めませんでした: ${esc(err.message)}</span>`;
    }
  }

  window.labOnState = (s) => {
    const had = L.lab?.job;
    L.lab = s;
    renderDot();
    if (L.view !== "lab") return;
    renderJob();
    // 仕事が終わったら、パラメータ・記録を読み直す
    if (had && !s.job) refresh();
  };

  function renderDot() {
    const job = L.lab?.job;
    $("#labDot").hidden = !job;
    $("#viewLab").title = job ? `学習の仕事が動いています（${TRIGGER_JA[job.trigger] || job.trigger}）` : "方策・シミュレータ・学習";
  }

  /* ---------- 方策 ---------- */
  function renderPolicy() {
    const p = L.ov.policy, s = L.ov.settings;
    const play = p.play === "solver" ? "前のソルバー（active-solver.ts）" : "経路探索の方策（planner.ts＋evaluator.ts）";
    const bench = p.bench ? `${num(p.bench.previousPerTurn)} → <b>${num(p.bench.perTurn)}</b> 点/ターン（${p.bench.room === "all" ? "全部の地図" : `room ${esc(p.bench.room)} に似せた地図`}・${esc(p.bench.generations)} 世代）` : "-";
    $("#lpWhen").textContent = p.updatedAt ? when(p.updatedAt) : "";
    $("#ltSummary").innerHTML = p.source === "train" && p.bench
      ? `今の方策: <b class="mono">${num(p.bench.perTurn)}</b> 点/ターン <span class="faint">（${when(p.updatedAt)} に学習で保存）</span>`
      : `今の方策: 初期値 <span class="faint">（学習で良くなるとここに成績が出ます）</span>`;
    $("#lpPolicy").innerHTML = `<dl class="kv">
      <dt>試合の手</dt><dd>${esc(play)}</dd>
      <dt>LLM</dt><dd>${p.async ? "裏で作戦を出す（手は待たない）" : "毎フェーズ返答を待つ（AGENT_ASYNC=false）"}</dd>
      <dt>パラメータ</dt><dd>${esc(SOURCE_JA[p.source] || p.source)}</dd>
      <dt>成績</dt><dd>${bench}</dd>
      <dt>試合後の学習</dt><dd>${s.trainAfterMatchMin > 0 ? `${num(s.trainAfterMatchMin)} 分` : "しない"}</dd>
      <dt>1試合の長さ</dt><dd>シミュレータでは最大 ${esc(s.simMaxTurns)} ターン</dd>
    </dl><p class="hint" style="margin:10px 0 0">変えるには 設定 › 方策・学習（PLAY_POLICY・TRAIN_AFTER_MATCH_MIN など）</p>`;
  }

  function renderParams() {
    const p = L.ov.policy;
    const rows = Object.entries(p.space).map(([k, sp]) => {
      const v = p.params[k], d = p.defaults[k], span = sp.max - sp.min || 1;
      const at = ((v - sp.min) / span) * 100, def = ((d - sp.min) / span) * 100;
      const changed = Math.abs(v - d) > span * 0.01;
      return `<tr title="${esc(sp.doc)}（${sp.min}〜${sp.max}）"><td class="n">${esc(PARAM_JA[k] || k)}</td>
        <td><div class="pbar" aria-label="${esc(k)}: ${num(v)}（初期値 ${num(d)}）"><b style="left:${def}%"></b><i style="left:${at}%"></i></div></td>
        <td class="v ${changed ? "" : "faint"}">${sp.integer ? Math.round(v) : num(v)}</td></tr>`;
    }).join("");
    $("#lpParams").innerHTML = `<table class="ptab">${rows}</table><p class="hint" style="margin:8px 0 0">各項目の上にマウスを置くと意味が出ます。学習で動いたものは濃く表示。</p>`;
  }

  /* ---------- 学習の仕事 ---------- */
  function renderJob() {
    const st = L.lab; if (!st) return;
    const job = st.job || st.last, running = !!st.job;
    $("#ltStart").hidden = running && st.job.trigger !== "idle";
    $("#ltStop").hidden = !running;
    $("#lbStart").disabled = running && st.job.trigger !== "idle";
    $("#ltIdle").checked = !!st.idle.enabled;
    $("#ltIdleNote").textContent = st.idle.enabled ? `${st.idle.chunkMin} 分ずつ学習し、その都度確かめて保存するか決めます。${st.idle.reason ? " " + st.idle.reason : ""}` : "";
    $("#ljState").innerHTML = running ? `<span class="badge b-continue">${st.job.kind === "train" ? "学習中" : "比べています"}</span>` : st.matchActive ? `<span class="badge b-wait">試合中</span>` : "";
    const el = $("#ljJob");
    if (!job) { el.innerHTML = ""; drawCurve([]); return; }
    const sec = elapsedOf(job);
    const ratio = job.minutes ? Math.min(1, sec / (job.minutes * 60)) : null;
    const head = job.kind === "train"
      ? `<b>学習</b><span class="tag">${esc(TRIGGER_JA[job.trigger] || job.trigger)}</span>${job.room ? `<span class="tag">room ${esc(job.room)} に似せる</span>` : `<span class="tag">全部の地図</span>`}${job.dryRun ? `<span class="tag">試すだけ</span>` : ""}`
      : `<b>比べる</b><span class="tag">A ${esc(POLICY_JA[job.a] || job.a)}</span><span class="tag">B ${esc(POLICY_JA[job.b] || job.b)}</span><span class="tag">${esc(job.n)} 地図</span>`;
    const gens = job.generations || [];
    const eps = gens.length ? gens[gens.length - 1].episodes : 0;
    const c = job.comparison;
    let cmp = "";
    if (c && c.n > 0) {
      const res = job.kind === "train"
        ? job.accepted ? `<span class="badge b-continue">${job.dryRun ? "良くなった（保存しない）" : "保存した"}</span>` : `<span class="badge b-wait">見送り</span>`
        : c.diff > 1.5 * c.se ? `<span class="badge b-continue">B が強い</span>` : c.diff < -1.5 * c.se ? `<span class="badge b-solver">A が強い</span>` : `<span class="badge b-wait">差ははっきりしない</span>`;
      cmp = `<div class="cmpline"><span>${job.kind === "train" ? "前" : "A"} <b class="mono">${num(c.a)}</b></span><span>→ ${job.kind === "train" ? "後" : "B"} <b class="mono">${num(c.b)}</b> 点/ターン</span><span class="mono ${c.diff >= 0 ? "up" : "down"}">差 ${c.diff >= 0 ? "+" : ""}${num(c.diff)}±${num(c.se)}</span><span class="dim">勝ち ${c.wins}/${c.n}</span>${c.hazardsB > c.hazardsA ? `<span class="down">罠 ${c.hazardsA}→${c.hazardsB}</span>` : ""}${res}</div>`;
    }
    el.innerHTML = `<div class="hd">${head}<span class="faint" style="margin-left:auto">${running ? "" : "終了 "}${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒${job.minutes ? ` / ${num(job.minutes)}分` : ""}</span></div>
      ${running && ratio !== null ? `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}"><i style="width:${ratio * 100}%"></i></div>` : ""}
      ${gens.length ? `<div class="dim">${gens.length} 世代・${fmt(eps)} 試合（シミュレータ）</div>` : ""}
      <div class="msg">${esc(job.message || "")}</div>${cmp}`;
    drawCurve(gens);
  }

  function drawCurve(gens) {
    const svg = $("#ljCurve"), W = svg.clientWidth || 600, H = 190, pl = 46, pr = 10, pt = 10, pb = 22;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    if (!gens.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">学習を始めると、世代ごとの成績がここに出ます</text>`;
      $("#ljLegend").innerHTML = ""; return;
    }
    const ys = gens.flatMap((g) => [g.best, g.mean]);
    let lo = Math.min(...ys), hi = Math.max(...ys); if (hi - lo < 1) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const n = gens.length, X = (i) => pl + (n === 1 ? (W - pl - pr) / 2 : (i / (n - 1)) * (W - pl - pr)), Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const line = (k, col) => `<polyline fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" points="${gens.map((g, i) => `${X(i).toFixed(1)},${Y(g[k]).toFixed(1)}`).join(" ")}"/>`;
    let grid = "";
    for (let t = 0; t <= 3; t++) { const v = lo + ((hi - lo) * t) / 3, y = Y(v); grid += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="var(--line2)"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end">${Math.round(v)}</text>`; }
    grid += `<text x="${pl}" y="${H - 6}">世代 1</text><text x="${W - pr}" y="${H - 6}" text-anchor="end">${n}</text>`;
    svg.innerHTML = grid + line("mean", "var(--c2)") + line("best", "var(--c1)") + gens.map((g, i) => `<circle cx="${X(i)}" cy="${Y(g.mean)}" r="2" fill="var(--c2)"/>`).join("") + gens.map((g, i) => `<circle cx="${X(i)}" cy="${Y(g.best)}" r="2.5" fill="var(--c1)"><title>世代${g.gen}: 最良 ${g.best} / 平均 ${g.mean} 点/ターン（σ=${g.sigma.toFixed(3)}）</title></circle>`).join("");
    $("#ljLegend").innerHTML = `<span><i style="border-color:var(--c1)"></i>候補の最良（点/ターン）</span><span><i style="border-color:var(--c2)"></i>候補の平均</span><span class="faint">毎世代ちがう地図なので上下する。保存するかは最後に、学習に使っていない地図で決める</span>`;
  }

  $("#ltStart").addEventListener("click", async () => {
    try { await post("/api/lab/train", { room: roomVal($("#ltRoom")), minutes: Number($("#ltMin").value) || 5, dryRun: $("#ltDry").checked }); }
    catch (err) { $("#ljJob").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });
  $("#ltStop").addEventListener("click", () => post("/api/lab/stop").catch(() => {}));
  $("#ltIdle").addEventListener("change", async (e) => {
    try { const r = await post("/api/lab/idle", { enabled: e.target.checked }); window.labOnState(r.lab); }
    catch (err) { e.target.checked = !e.target.checked; $("#ltIdleNote").textContent = err.message; }
  });
  $("#lbStart").addEventListener("click", async () => {
    try { await post("/api/lab/bench", { a: $("#lbA").value, b: $("#lbB").value, n: Number($("#lbN").value) || 24, room: roomVal($("#lbRoom")) }); }
    catch (err) { $("#ljJob").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });

  /* ---------- 学習の記録 ---------- */
  function renderHistory() {
    const h = L.ov.history || [];
    $("#lhCount").textContent = h.length ? `新しい順 ${h.length} 件（var/policy/train-log.jsonl）` : "";
    if (!h.length) { $("#lhist").innerHTML = `<p class="faint">まだ学習していません。</p>`; return; }
    const rows = h.map((r) => {
      const c = r.comparison || {};
      const res = r.dryRun ? (r.accepted ? "良くなった（試すだけ）" : "見送り（試すだけ）") : r.accepted ? `<b class="up">保存</b>` : "見送り";
      return `<tr><td>${esc(when(r.at))}</td><td>${esc(TRIGGER_JA[r.trigger] || r.trigger || "-")}</td><td>${r.room ? `room ${esc(r.room)}` : "全部"}</td>
        <td class="num">${esc(r.generations ?? "-")}</td><td class="num">${fmt(r.episodes)}</td>
        <td class="num">${c.n ? `${num(c.a)} → ${num(c.b)}` : "-"}</td><td class="num ${c.diff > 0 ? "up" : c.diff < 0 ? "down" : ""}">${c.n ? `${c.diff >= 0 ? "+" : ""}${num(c.diff)}±${num(c.se)}` : "-"}</td><td>${res}</td></tr>`;
    }).join("");
    $("#lhist").innerHTML = `<table><thead><tr><th>日時</th><th>きっかけ</th><th>地図</th><th>世代</th><th>試合</th><th>前 → 後（点/ターン）</th><th>差</th><th>結果</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /* ---------- 地図のもと ---------- */
  function renderMaps() {
    const m = L.ov.maps, pr = m.profile;
    const real = m.real.length
      ? `<div class="maps-list">${m.real.map((r) => `<div><span>room ${esc(r.room)}</span><span class="mono">${esc(r.count)} 枚</span></div>`).join("")}</div>`
      : `<p class="faint" style="margin:0">まだありません。試合で Webマップが取れると、最初の1枚が自動で保存されます。</p>`;
    const prof = pr ? `<dl class="kv" style="margin-top:12px">
      <dt>大きさ</dt><dd class="mono">${esc(pr.size.join("〜"))}</dd><dt>ターン数</dt><dd class="mono">${esc(pr.turns.join("〜"))}</dd>
      <dt>Webマップ</dt><dd>${Math.round(pr.webMap * 100)}% の地図で見える</dd><dt>本物の地図</dt><dd>${Math.round(pr.realMapShare * 100)}% の割合で混ぜる（そのルームにある時）</dd>
      <dt>ほかのタイル</dt><dd>${pr.otherTiles ? `tiles.json にある残りのタイルも重み ${esc(pr.otherTiles)} で混ぜる` : "混ぜない"}</dd></dl>` : "";
    $("#lmaps").innerHTML = `<div class="dim" style="margin-bottom:6px">保存した本物の地図（var/maps/）</div>${real}${prof}<p class="hint" style="margin:10px 0 0">地図の作り方は knowledge/sim-profiles.json。ルームの大きさ・ターン数は実測（room-profiles）に合わせる。</p>`;
  }

  /* ---------- シミュレータの再生 ---------- */
  const seedEl = $("#lsSeed");
  seedEl.value = load("simSeed") || String(Math.floor(Math.random() * 1e6));
  $("#lsDice").addEventListener("click", () => { seedEl.value = String(Math.floor(Math.random() * 1e6)); runSim(); });
  $("#lsRun").addEventListener("click", () => runSim());

  async function runSim() {
    stopPlay();
    // かんたん表示では毎回ちがう地図
    if (document.body.classList.contains("simple")) seedEl.value = String(Math.floor(Math.random() * 1e6));
    const btn = $("#lsRun"); btn.disabled = true;
    $("#simInfo").innerHTML = `<span class="faint">地図を作って打たせています…</span>`;
    save("simSeed", seedEl.value);
    try {
      const turns = $("#lsTurns").value.trim();
      const r = await post("/api/lab/episode", { seed: Number(seedEl.value) || 0, room: roomVal($("#lsRoom")), maxTurns: turns === "" ? null : Number(turns), policy: $("#lsPol").value });
      L.run = r.result; L.frame = 0; L.gridAt = -1;
      const sl = $("#lsSlider"); sl.max = String(Math.max(0, L.run.trace.frames.length - 1)); sl.value = "0";
      $("#simCtl").hidden = false;
      drawSim();
      startPlay();
    } catch (err) {
      $("#simInfo").innerHTML = `<span class="down">打たせられませんでした: ${esc(err.message)}</span>`;
    } finally { btn.disabled = false; }
  }

  /** frame 番目のターンの後の地図（前から順に変化を当てる。戻る時は初めから） */
  function gridAt(f) {
    const tr = L.run.trace;
    if (L.gridAt < 0 || f < L.gridAt) { L.grid = tr.grid.map((r) => [...r]); L.gridAt = -1; }
    for (let i = L.gridAt + 1; i <= f; i++) for (const [x, y, v] of tr.frames[i].changed) L.grid[y][x] = v;
    L.gridAt = f;
    return L.grid;
  }

  function drawSim() {
    const run = L.run; if (!run) return;
    const tr = run.trace, f = Math.min(L.frame, tr.frames.length - 1), fr = tr.frames[f];
    const grid = gridAt(f), w = tr.width, h = tr.height, cv = $("#simMap");
    const avail = ($("#simBox").clientWidth || 420) - 18, cell = Math.max(5, Math.min(22, Math.floor(Math.min(avail / w, 420 / h))));
    cv.width = w * cell; cv.height = h * cell; cv.style.width = w * cell + "px"; cv.style.height = h * cell + "px";
    const c = cv.getContext("2d"); c.imageSmoothingEnabled = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = grid[y][x], px = x * cell, py = y * cell, img = tileImg(v);
      if (img) c.drawImage(img, px, py, cell, cell);
      else { const [bg, fg, ch] = fallbackStyle(v); c.fillStyle = bg; c.fillRect(px, py, cell, cell); if (cell >= 11) { c.fillStyle = fg; c.font = `600 ${Math.floor(cell * 0.6)}px ${cssVar("--mono")}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(ch, px + cell / 2, py + cell / 2 + 1); } }
    }
    // 自分の軌跡（ワープは線を切る）
    const me = tr.players.findIndex((p) => p.self), mid = (p) => [p[0] * cell + cell / 2, p[1] * cell + cell / 2];
    const pts = tr.frames.slice(Math.max(0, f - 60), f + 1).map((q) => q.pos[me]);
    const stroke = (col, wd) => { c.strokeStyle = col; c.lineWidth = wd; c.lineJoin = "round"; c.beginPath(); pts.forEach((p, i) => { const [a, b] = mid(p); const prev = pts[i - 1]; if (i && Math.abs(prev[0] - p[0]) + Math.abs(prev[1] - p[1]) <= 2) c.lineTo(a, b); else c.moveTo(a, b); }); c.stroke(); };
    if (pts.length > 1) { stroke("rgba(255,255,255,.85)", Math.max(4, cell * 0.38)); stroke(MAPC.trail, Math.max(2, cell * 0.22)); }
    tr.players.forEach((p, i) => { if (!p.self) drawPlayer(c, { x: fr.pos[i][0], y: fr.pos[i][1], tileId: p.id, role: "enemy", lastSeenTurn: null }, cell, true); });
    drawPlayer(c, { x: fr.pos[me][0], y: fr.pos[me][1], tileId: tr.players[me].id, role: "self", lastSeenTurn: null }, cell, false);
    L.hit = { cell, w, h };
    $("#lsSlider").value = String(f);
    const score = fr.scores[me], others = fr.scores.filter((_, i) => i !== me);
    const kind = run.scenario.startsWith("real:") ? `本物の地図（${esc(run.scenario.slice(5))}）を少し変えたもの` : `作った地図 ${esc(run.scenario.replace(/^gen:/, ""))}`;
    $("#simInfo").innerHTML = `<div class="cmpline"><span>ターン <b class="mono">${fr.turn}</b>/${run.totalTurns}</span><span>得点 <b class="mono">${fmt(score)}</b></span>${others.length ? `<span class="dim">相手 ${others.map(fmt).join(" / ")}</span>` : ""}<span class="mono dim">${esc(fr.cmds.join(" "))}</span></div>
      <div class="reason adv">${esc(fr.reason)}</div>
      <dl class="kv"><dt>地図</dt><dd>${kind}・${run.webMap ? "全体マップが見える" : "全体マップなし（見えたマスだけ）"}</dd>
      <dt>結果</dt><dd><b class="mono">${fmt(run.score)}</b> 点（${num(run.score / Math.max(1, run.totalTurns))} 点/ターン）・罠 ${run.hazardHits}・${run.msPerPhase} ms/手${run.policyErrors ? `・<span class="down">不正な手 ${run.policyErrors}</span>` : ""}</dd></dl>`;
  }

  function startPlay() {
    if (!L.run) return;
    if (L.frame >= L.run.trace.frames.length - 1) L.frame = 0;
    L.playing = true; $("#lsPlay").textContent = "一時停止"; $("#lsPlay").setAttribute("aria-label", "一時停止");
    const tick = () => {
      if (!L.playing) return;
      if (L.frame >= L.run.trace.frames.length - 1) { stopPlay(); return; }
      L.frame += 1; drawSim();
      L.timer = setTimeout(tick, 1000 / Number($("#lsSpeed").value || 12));
    };
    tick();
  }
  function stopPlay() { L.playing = false; clearTimeout(L.timer); $("#lsPlay").textContent = "再生"; $("#lsPlay").setAttribute("aria-label", "再生"); }
  $("#lsPlay").addEventListener("click", () => (L.playing ? stopPlay() : startPlay()));
  $("#lsSlider").addEventListener("input", (e) => { stopPlay(); L.frame = Number(e.target.value); drawSim(); });
  window.labOnMode = () => { if (L.view === "lab") { if (L.run) drawSim(); if (L.lab) drawCurve((L.lab.job || L.lab.last)?.generations || []); } };
  window.labOnTile = () => { if (L.view === "lab" && L.run && !L.playing) drawSim(); };
  {
    const cv = $("#simMap"), tip = $("#simTip");
    cv.addEventListener("mousemove", (e) => {
      if (!L.run || !L.hit) return;
      const r = cv.getBoundingClientRect(), x = Math.floor((e.clientX - r.left) / L.hit.cell), y = Math.floor((e.clientY - r.top) / L.hit.cell);
      if (x < 0 || y < 0 || x >= L.hit.w || y >= L.hit.h) { tip.hidden = true; return; }
      tip.hidden = false; tip.textContent = `(${x}, ${y}) ${tileName(L.grid[y][x])}`;
      const box = $("#simBox").getBoundingClientRect(); tip.style.left = Math.max(0, Math.min(e.clientX - box.left + 10, box.width - tip.offsetWidth - 4)) + "px"; tip.style.top = (e.clientY - box.top - 28) + "px";
    });
    cv.addEventListener("mouseleave", () => { tip.hidden = true; });
  }
  addEventListener("resize", () => { if (L.view === "lab") { if (L.run) drawSim(); if (L.lab) drawCurve((L.lab.job || L.lab.last)?.generations || []); } });
  // 学習中は経過時間を進める
  setInterval(() => { if (L.view === "lab" && L.lab?.job) renderJob(); }, 1000);

  setView(L.view);
  // 「学習」の印（ヘッダの点）は試合の画面でも出す
  jget("/api/lab").then((ov) => { if (!L.lab) { L.lab = ov.lab; renderDot(); } }).catch(() => {});
})();
