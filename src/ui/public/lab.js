/* =====================================================================
   「学習」画面: 地図を作る → 並べた地図で学習 → 統計。並べた地図は全部同時に再生する。
   index.html の共通の関数（$, $$, esc, fmt, jget, tileImg, fallbackStyle, save, load, MAPC, mark）を使う。
   API は /api/lab/…（シミュレータだけを使い、CHaser サーバには触れない）。状態の変化は SSE の "lab" で届く。
   ===================================================================== */
(() => {
  const L = { view: load("view") === "lab" ? "lab" : "match", lab: null, data: null, which: "before", t: 0, playing: false, timer: 0, cards: [] };
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
    $(".work").hidden = v !== "match";
    $("#lab").hidden = v !== "lab";
    $("#viewMatch").setAttribute("aria-pressed", String(v === "match"));
    $("#viewLab").setAttribute("aria-pressed", String(v === "lab"));
    if (v === "lab") { refresh(); loadSet(); loadRooms(); } else { stopPlay(); if (typeof mark === "function") mark("map"); }
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
    if ((prev?.job && !s.job) || setChanged) loadSet();
  };

  function renderDot() {
    const job = L.lab?.job;
    $("#labDot").hidden = !job;
  }

  /* ---------- 流れ（ヘッダ）・状態・統計 ---------- */
  function renderFlowLab() {
    const st = L.lab, job = st?.job, set = st?.set;
    const cur = job ? (job.kind === "maps" ? "maps" : "train") : set?.after != null ? "stats" : set ? "train" : "maps";
    const order = ["maps", "train", "stats"], ci = order.indexOf(cur);
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

    const parts = [];
    if (job) {
      const sec = (Date.now() - new Date(job.startedAt)) / 1000;
      const what = job.trigger === "idle" ? "空き時間の学習（毎回新しい地図）" : job.trigger === "post-match" ? "試合後の学習" : job.kind === "maps" ? "地図を打たせています" : "学習中";
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
    }
    if (st.idle.enabled && st.idle.reason) parts.push(`<div class="msg">${esc(st.idle.reason)}</div>`);
    $("#labStatus").innerHTML = parts.join("");
  }

  $("#lmMake").addEventListener("click", async () => {
    stopPlay();
    save("labRoom", $("#lmRoom").value);
    try { await post("/api/lab/maps", { n: Number($("#lmN").value) || 12, room: $("#lmRoom").value === "" ? null : Number($("#lmRoom").value) }); }
    catch (err) { $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });
  $("#ltStart").addEventListener("click", async () => {
    stopPlay();
    try { await post("/api/lab/train", { minutes: Number($("#ltMin").value) || 5 }); }
    catch (err) { $("#labStatus").innerHTML = `<div class="down">${esc(err.message)}</div>`; }
  });
  $("#ltStop").addEventListener("click", () => post("/api/lab/stop").catch(() => {}));
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
    $("#labPlay").hidden = !runs;
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
      ctx.fillStyle = k === me ? MAPC.self : MAPC.enemy; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    });
    // 見出し: 地図・今の得点・この地図の結果（学習後があれば前→後）
    const before = L.data.before?.[i], after = L.data.after?.[i];
    const pt = (r) => r.score / Math.max(1, r.totalTurns);
    const res = before && after ? `<span class="${pt(after) >= pt(before) ? "up" : "down"}">${num(pt(before))}→${num(pt(after))}</span>` : `${num(pt(run))}`;
    c.cap.innerHTML = `<span>${esc(label(c.m))}</span><b>${fmt(fr.scores[me])}</b>${run.hazardHits ? `<span class="down">罠${run.hazardHits}</span>` : ""}<span class="r" title="この地図の 1ターンあたりの得点">${res}</span>`;
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

  setView(L.view);
  jget("/api/lab").then((r) => { if (!L.lab) { L.lab = r.lab; renderDot(); } }).catch(() => {});
})();
