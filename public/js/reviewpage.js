// Review Report page (#/review/<client>): the client review workbook shown as Excel shows it
// (public/js/sheetview.js), with the same sheets, colours and charts. Cells can be typed into:
//   - DETAILED PORTFOLIO: a scheme's sub type, invested, units, value, XIRR, SIP, new SIP,
//     remarks and suggestions (saved per scheme, so totals and the other sheets follow); right-click
//     a scheme to change its fund type or leave it out.
//   - Every other sheet: any cell that is not a formula (saved per cell).
// Changes are saved per client on the server (/api/review/edits), apart from the uploaded data,
// which is never changed. Export builds the Excel file with them (public/js/review.js).
const ReviewPage = (() => {
  const view = $("dashView");
  const enc = encodeURIComponent;
  const SAVE_DELAY = 700;
  const DETAILED = "DETAILED PORTFOLIO";
  const NUMBER_FIELDS = new Set(["invested", "quantity", "current_value", "xirr", "sip", "newSip"]);

  let data = null, edits = {}, wb = null, schemeRows = new Map(), names = new Map();
  let groups = [], openGroups = new Set(); // DETAILED PORTFOLIO blocks; folded unless opened
  let openCards = new Set(); // dashboard cards opened with their dropdown (fund types, sections)
  let foldsSet = false; // the card view starts with every scheme shown
  let blocks = [], grandRow = null; // DETAILED PORTFOLIO platform blocks, for the card view
  // Sheets whose hidden columns hold client figures, so the page shows them.
  const SHOW_HIDDEN = new Set(["SUMMARY PORTFOLIO", DETAILED]);
  let sheetName = null, sel = null, editor = null, active = false, building = null, pending = false;
  let saveTimer = null, saving = null, dirty = false;
  let zoom = Number(store("xlZoom")) || 1;
  // Dashboard look by default; "Excel view" shows row numbers, column letters and the formula bar.
  let excelView = store("xlExcelView") === "1";
  const TAB_NAMES = { "1": "Cover", "SUMMARY PORTFOLIO": "Summary Portfolio", "DETAILED PORTFOLIO": "Detailed Portfolio" };

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; }
    return null;
  }

  const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

  // ---- Saving -----------------------------------------------------------------------------
  function setStatus(text, cls = "") {
    const el = $("xlStatus");
    if (el) { el.textContent = text; el.className = `xl-status ${cls}`; }
  }

  function scheduleSave() {
    dirty = true;
    setStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!dirty) return saving;
    dirty = false;
    const client = data.clientName;
    saving = api("PUT", `/review/edits?client=${enc(client)}`, { edits: clean(edits) })
      .then(() => { if (data?.clientName === client && !dirty) setStatus("All changes saved", "ok"); })
      .catch((e) => { dirty = true; setStatus(`Not saved: ${e.message}`, "err"); throw e; });
    return saving;
  }

  async function flush() {
    if (!data) return;
    try { if (dirty) await save(); else await saving; } catch {}
  }

  // Drop empty objects so the saved document only holds real changes. Cell values of "" are kept:
  // they mean the reviewer cleared that cell.
  function clean(o, isCells = false) {
    if (Array.isArray(o) || o === null || typeof o !== "object") return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const c = clean(v, isCells || k === "cells");
      if (c === undefined || c === false || (c === "" && !isCells) || c === null) continue;
      if (typeof c === "object" && !Object.keys(c).length) continue;
      out[k] = c;
    }
    return out;
  }

  // ---- Page ---------------------------------------------------------------------------------
  async function show(name) {
    active = false;
    await flush();
    document.body.classList.add("xl-mode");
    view.innerHTML = '<div class="loading">Loading the review sheet…</div>';
    try {
      data = await api("GET", `/review?client=${enc(name)}`);
    } catch (e) {
      data = null;
      view.innerHTML = `<div class="xl-error"><nav class="crumbs"><a href="#/dashboard">Dashboard</a></nav>
        <div class="card empty-state"><h2>Couldn't load the review report</h2><p>${esc(e.message)}</p></div></div>`;
      return;
    }
    edits = data.edits && typeof data.edits === "object" ? structuredClone(data.edits) : {};
    dirty = false;
    sel = null;
    const prep = Review.prepare(data, {});
    names = new Map([...prep.raw.holdings, ...prep.raw.sips].map((r) => [Review.rowKey(r), r.security_name || "Scheme"]));
    foldsSet = false;
    openGroups = new Set();
    openCards = new Set();
    seeded = new Set();
    shell();
    active = true;
    await rebuild();
  }

  function shell() {
    const c = data.clientName;
    view.innerHTML = `<div class="xl-app ${excelView ? "" : "modern"}" id="xlApp">
      <div class="xl-bar">
        <a class="xl-back" href="#/client/${enc(c)}" title="Back to ${esc(c)}">‹</a>
        <div class="xl-avatar" aria-hidden="true">${esc(c.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase())}</div>
        <div class="xl-title"><b>${esc(c)}</b><span title="Click a cell to change it. Right-click a scheme to change its fund type or leave it out.">Review sheet</span></div>
        <div class="xl-kpis" id="xlKpis"></div>
        <label class="xl-date" title="Review date">Date <input type="date" id="xlDate" value="${esc(edits.reviewDate || data.today)}"></label>
        <span id="xlStatus" class="xl-status ${data.editsSavedAt ? "ok" : ""}">${data.editsSavedAt ? "Changes saved" : "No changes yet"}</span>
        <button type="button" class="xl-btn" id="xlView" title="Switch between the dashboard look and a spreadsheet look">${excelView ? "Dashboard view" : "Excel view"}</button>
        <button type="button" class="xl-btn" id="xlReset">Reset changes</button>
        <button type="button" class="xl-btn xl-export" id="xlExport">Export Excel</button>
      </div>
      <div class="xl-fx"><span id="xlName" class="xl-name"></span><span class="xl-fxl">fx</span><input id="xlFx" autocomplete="off" spellcheck="false"></div>
      <div id="xlHost" class="xl-host" tabindex="0"></div>
      <div class="xl-foot">
        <div id="xlTabs" class="xl-tabs" role="tablist"></div>
        <span class="xl-folds" id="xlFolds" hidden><button type="button" data-fold="open">▾ Expand all</button><button type="button" data-fold="close">▸ Collapse all</button></span>
        <button type="button" id="xlOut" class="xl-out" hidden></button>
        <div class="xl-zoom"><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><span id="xlZoom"></span><button type="button" data-zoom="1" aria-label="Zoom in">+</button></div>
      </div>
      <div id="xlMenu" class="xl-menu" hidden></div>
    </div>`;
    $("xlExport").addEventListener("click", exportNow);
    $("xlView").addEventListener("click", () => {
      excelView = !excelView;
      store("xlExcelView", excelView ? "1" : "0");
      $("xlApp").classList.toggle("modern", !excelView);
      $("xlView").textContent = excelView ? "Dashboard view" : "Excel view";
      draw();
    });
    $("xlReset").addEventListener("click", reset);
    $("xlDate").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v && v !== data.today) edits.reviewDate = v; else delete edits.reviewDate;
      changed();
    });
    $("xlFx").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (sel) commit(sel.r, sel.c, $("xlFx").value, { r: 1, c: 0 }); $("xlHost").focus(); }
      if (e.key === "Escape") { showSelection(); $("xlHost").focus(); }
    });
    view.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      zoom = Math.min(2, Math.max(0.4, Math.round((zoom + Number(b.dataset.zoom) * 0.1) * 10) / 10));
      store("xlZoom", zoom);
      draw();
    }));
    $("xlOut").addEventListener("click", (e) => leftOutMenu(e));
    view.querySelectorAll("[data-fold]").forEach((b) => b.addEventListener("click", () => {
      openGroups = b.dataset.fold === "open" ? new Set(groups.map((g) => g.id)) : new Set();
      openCards = b.dataset.fold === "open" ? new Set([...openCards, ...[...$("xlHost").querySelectorAll("[data-toggle]")].map((x) => x.dataset.toggle)]) : new Set();
      draw();
    }));
    const host = $("xlHost");
    host.addEventListener("click", (e) => {
      const tg = e.target.closest("[data-toggle]");
      if (tg && !e.target.closest("[data-r][data-c], button")) {
        if (openCards.has(tg.dataset.toggle)) openCards.delete(tg.dataset.toggle); else openCards.add(tg.dataset.toggle);
        draw();
        return;
      }
      const td = e.target.closest("[data-r][data-c]");
      if (!td) return;
      const r = Number(td.dataset.r);
      const g = sheetName === DETAILED && groups.find((x) => x.head === r || x.total === r);
      if (g && (g.head === r || !openGroups.has(g.id))) {
        if (openGroups.has(g.id)) openGroups.delete(g.id); else openGroups.add(g.id);
        draw();
      }
      select(r, Number(td.dataset.c));
      if (td.classList.contains("cv-edit")) openEditor();
    });
    host.addEventListener("dblclick", (e) => {
      const td = e.target.closest("[data-r][data-c]");
      if (td) { select(Number(td.dataset.r), Number(td.dataset.c)); openEditor(); }
    });
    host.addEventListener("contextmenu", (e) => {
      const td = e.target.closest("[data-r][data-c]");
      if (!td) return;
      e.preventDefault();
      select(Number(td.dataset.r), Number(td.dataset.c));
      cellMenu(e);
    });
    host.addEventListener("keydown", onKey);
  }

  // Rebuilds the workbook from the uploaded data and the edits, and shows it again.
  async function rebuild() {
    if (building) { pending = true; return building; }
    const host = $("xlHost");
    host?.classList.add("busy");
    building = (async () => {
      try {
        const out = await Review.assemble(data, await Review.template(), clean(edits));
        schemeRows = out.schemeRows;
        groups = out.groups || [];
        blocks = out.blocks || [];
        if (!foldsSet) { foldsSet = true; if (!excelView) openGroups = new Set(groups.map((g) => g.id)); }
        grandRow = out.grand ?? null;
        wb = await SheetView.load(out.zip);
        if (!sheetName || !wb.sheets.some((s) => s.name === sheetName && !s.hidden)) {
          const remembered = store("xlSheet");
          sheetName = wb.sheets.some((s) => s.name === remembered && !s.hidden) ? remembered
            : wb.sheets.find((s) => s.name === "Summary")?.name || wb.sheets.find((s) => !s.hidden).name;
        }
        if (active) { tabs(); draw(); leftOut(); kpis(); }
      } catch (e) {
        if (active) host.innerHTML = `<div class="card empty-state"><h2>Couldn't build the review sheet</h2><p>${esc(e.message)}</p></div>`;
      } finally {
        host?.classList.remove("busy");
      }
    })();
    await building;
    building = null;
    if (pending) { pending = false; await rebuild(); }
  }

  function tabs() {
    $("xlTabs").innerHTML = wb.sheets.filter((s) => !s.hidden).map((s) =>
      `<button type="button" role="tab" class="xl-tab ${s.name === sheetName ? "on" : ""}" data-sheet="${esc(s.name)}" aria-selected="${s.name === sheetName}">${esc(TAB_NAMES[s.name] || s.name.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()))}</button>`).join("");
    $("xlTabs").querySelectorAll("[data-sheet]").forEach((b) => b.addEventListener("click", () => {
      sheetName = b.dataset.sheet;
      store("xlSheet", sheetName);
      sel = null;
      tabs();
      draw(true);
    }));
  }

  function draw(top = false) {
    const host = $("xlHost");
    const scroll = top ? { x: 0, y: 0 } : { x: host.scrollLeft, y: host.scrollTop };
    const detailed = sheetName === DETAILED;
    const hideRows = new Set();
    if (detailed) for (const g of groups) if (!openGroups.has(g.id)) for (let r = g.first; r <= g.last; r++) hideRows.add(r);
    if (detailed && !excelView) Cards.render(host);
    else if (!excelView && Pages[sheetName]) Pages[sheetName](host);
    else SheetView.render(wb, sheetName, host, { zoom, modern: !excelView, isEdited, isEditable, hideRows, showHidden: SHOW_HIDDEN.has(sheetName), decorate: detailed ? decorate : null });
    $("xlFolds").hidden = !(detailed && groups.length) && !host.querySelector("[data-toggle]");
    host.scrollLeft = scroll.x;
    host.scrollTop = scroll.y;
    $("xlZoom").textContent = `${Math.round(zoom * 100)}%`;
    showSelection();
  }

  // Fold arrows on DETAILED PORTFOLIO: on each fund type (or platform) heading, and on its
  // Grand Total while folded.
  function decorate(r, c) {
    const g = groups.find((x) => x.head === r || x.total === r);
    if (!g) return null;
    const open = openGroups.has(g.id);
    const n = [...schemeRows.keys()].filter((x) => x >= g.first && x <= g.last).length;
    if (g.head === r && c === 2) {
      return { cls: "xl-fold", before: `<span class="xl-caret" title="${open ? "Hide" : "Show"} the ${n} scheme${n === 1 ? "" : "s"}">${open ? "▾" : "▸"}</span>` };
    }
    if (g.total === r && !open && c === 1) return { cls: "xl-fold", before: `<span class="xl-caret">▸</span>` };
    if (g.head === r || (g.total === r && !open)) return { cls: "xl-fold" };
    return null;
  }

  // DETAILED PORTFOLIO in the dashboard look: a card per platform, its fund types as rows that
  // open into scheme cards. Every figure is read from the sheet, so edits and totals match the
  // Excel view and the export; values carry data-r/data-c, so clicking one types into that cell.
  const TYPE_COLORS = ["#1f3864", "#0f766e", "#b45309", "#7c3aed", "#e8590c", "#0284c7", "#be185d", "#4d7c0f"];
  const Cards = {
    val: (r, c) => wb.value(DETAILED, r, SheetView.colNum(c)),
    num(r, c) { const v = this.val(r, c); return typeof v === "number" ? v : null; },
    text(r, c) {
      const v = this.val(r, c);
      if (v === null || v === undefined || v === "") return "";
      const f = SheetView.format(v, wb.xf(wb.sheet(DETAILED), r, SheetView.colNum(c)).fmt);
      return `${f.left ?? ""}${f.text}`.trim();
    },
    // One figure: label over value. Editable figures open the editor on click.
    cell(r, c, label, shown, cls = "") {
      const cc = SheetView.colNum(c);
      const edit = isEditable(r, cc), edited = isEdited(r, cc);
      return `<div class="cv-f ${cls}"><span>${label}</span><b class="${edit ? "cv-edit" : ""} ${edited ? "xl-edited" : ""}" data-r="${r}" data-c="${cc}"`
        + `${edit ? ` title="Click to change"` : ""}>${shown || "–"}</b></div>`;
    },
    pct(r, c) { const v = this.num(r, c); return v === null ? "" : fmt.pct(v); },
    gain(r) {
      const inv = this.num(r, "D") || 0, cur = this.num(r, "J") ?? this.num(r, "G") ?? 0;
      return cur - inv;
    },
    stats(r) {
      return this.statsOf({ inv: this.num(r, "D") ?? 0, cur: this.num(r, "J") ?? this.num(r, "G") ?? 0, ret: this.pct(r, "L"), xirr: this.pct(r, "K"), sip: this.num(r, "O") ?? 0 });
    },
    statsOf({ inv, cur, ret, xirr, sip }) {
      const g = cur - inv;
      return `<div class="cv-stats">
        <div><span>Invested</span><b>${fmt.money(inv)}</b></div>
        <div><span>Current value</span><b>${fmt.money(cur)}</b></div>
        <div class="${g < 0 ? "cv-down" : "cv-up"}"><span>Gain</span><b>${fmt.money(g)}</b></div>
        <div><span>Abs. return</span><b>${ret || "–"}</b></div>
        <div><span>XIRR</span><b>${xirr || "–"}</b></div>
        <div><span>Live SIP</span><b>${fmt.money(sip)}</b></div>
      </div>`;
    },
    scheme(r) {
      const g = (this.num(r, "G") || 0) - (this.num(r, "D") || 0);
      const ret = this.pct(r, "L");
      return `<article class="cv-scheme">
        <div class="cv-shead" data-r="${r}" data-c="2" title="Right-click to change the fund type or leave it out">
          <span class="cv-no">${this.text(r, "A")}</span><h4>${esc(this.text(r, "B") || "Scheme")}</h4>
          ${ret ? `<span class="cv-pill ${g < 0 ? "cv-down" : "cv-up"}">${ret}</span>` : ""}
        </div>
        ${this.cell(r, "C", "Sub type", esc(this.text(r, "C")), "cv-wide")}
        <div class="cv-main">
          ${this.cell(r, "D", "Invested", this.num(r, "D") === null ? "" : fmt.money(this.num(r, "D")))}
          ${this.cell(r, "G", "Current value", this.num(r, "G") === null ? "" : fmt.money(this.num(r, "G")))}
        </div>
        <div class="cv-grid">
          ${this.cell(r, "F", "Units", this.text(r, "F"))}
          ${this.cell(r, "K", "XIRR", this.pct(r, "K"))}
          ${this.cell(r, "M", "Holding", this.pct(r, "M"))}
          ${this.cell(r, "N", "Tenure", esc(this.text(r, "N")))}
          ${this.cell(r, "O", "Live SIP", this.num(r, "O") === null ? "" : fmt.money(this.num(r, "O")))}
          ${this.cell(r, "P", "New SIP", this.num(r, "P") === null ? "" : fmt.money(this.num(r, "P")))}
        </div>
        ${this.cell(r, "T", "Remarks", esc(this.text(r, "T")), "cv-wide cv-note")}
        ${this.cell(r, "U", "Suggestions", esc(this.text(r, "U")), "cv-wide cv-note")}
      </article>`;
    },
    rowsOf: (g) => [...schemeRows.keys()].filter((x) => x >= g.first && x <= g.last).sort((a, b) => a - b),
    cur(r) { return this.num(r, "J") ?? this.num(r, "G") ?? 0; },
    initials: (t) => t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•",
    // One platform inside a fund type: its figures, then all its scheme cards.
    platform(e, typeValue) {
      const { g, platform, color } = e;
      const open = openGroups.has(g.id);
      const rows = this.rowsOf(g);
      const value = this.cur(g.total);
      const share = typeValue ? Math.max(0, Math.min(100, (value / typeValue) * 100)) : 0;
      const gain = this.gain(g.total);
      return `<div class="cv-group ${open ? "open" : ""}">
        <div class="cv-ghead" data-r="${g.head}" data-c="2" role="button" aria-expanded="${open}" title="${open ? "Hide" : "Show"} the schemes">
          <span class="cv-caret">${open ? "▾" : "▸"}</span>
          <div class="cv-gname"><i class="cv-plogo cv-c${color % 3}">${esc(this.initials(platform))}</i><div><b>${esc(platform)}</b><span>${rows.length} scheme${rows.length === 1 ? "" : "s"}</span></div></div>
          <div class="cv-bar" title="${share.toFixed(1)}% of this fund type"><i style="width:${share}%"></i></div>
          <div class="cv-gnum"><span>Invested</span><b>${fmt.money(this.num(g.total, "D") ?? 0)}</b></div>
          <div class="cv-gnum"><span>Current</span><b>${fmt.money(value)}</b></div>
          <div class="cv-gnum ${gain < 0 ? "cv-down" : "cv-up"}"><span>Return</span><b>${this.pct(g.total, "L") || "–"}</b></div>
        </div>
        ${open ? `<div class="cv-schemes">${rows.map((r) => this.scheme(r)).join("") || '<p class="cv-empty">No schemes.</p>'}</div>` : ""}
      </div>`;
    },
    // Fund types first (Equity, Hybrid, Debt, Others, then Stocks, PMS…), each with its platforms.
    types() {
      const out = new Map();
      blocks.forEach((b, bi) => {
        if (b.loans) return;
        const [platform, product = ""] = this.text(b.head, "B").split(" · ");
        for (const id of b.folds) {
          const g = groups.find((x) => x.id === id);
          if (!g) continue;
          const parts = id.split("|");
          const mf = parts[1] === "MF";
          const key = mf ? `MF|${parts[2]}` : parts[1];
          if (!out.has(key)) out.set(key, { name: mf ? parts[2] : product || parts[1], kind: mf ? "Mutual funds" : "", entries: [] });
          out.get(key).entries.push({ g, platform, color: bi });
        }
      });
      const order = (k) => { const i = Review.MF_TYPES.indexOf(k.replace(/^MF\|/, "")); return k.startsWith("MF|") && i >= 0 ? i : 100; };
      return [...out.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([, t]) => t);
    },
    type(t, i) {
      const totals = t.entries.map((e) => e.g.total);
      const inv = totals.reduce((a, r) => a + (this.num(r, "D") ?? 0), 0);
      const cur = totals.reduce((a, r) => a + this.cur(r), 0);
      const sip = totals.reduce((a, r) => a + (this.num(r, "O") ?? 0), 0);
      const w = totals.filter((r) => this.num(r, "K") !== null && this.cur(r));
      const wv = w.reduce((a, r) => a + this.cur(r), 0);
      const xirr = wv ? fmt.pct(w.reduce((a, r) => a + this.num(r, "K") * this.cur(r), 0) / wv) : "";
      const count = t.entries.reduce((a, e) => a + this.rowsOf(e.g).length, 0);
      const np = t.entries.length;
      const key = `type|${t.name}`, open = openCards.has(key);
      return `<section class="cv-block ${open ? "" : "cv-closed"}">
        <header class="cv-head cv-toggle" data-toggle="${esc(key)}" role="button" aria-expanded="${open}" title="${open ? "Hide" : "Show"} the platforms">
          <div class="cv-logo cv-t${i % 6}">${esc(t.name.slice(0, 1).toUpperCase())}</div>
          <div class="cv-title"><h3>${esc(t.name)}</h3><span>${t.kind ? `${t.kind} · ` : ""}${np} platform${np === 1 ? "" : "s"} · ${count} scheme${count === 1 ? "" : "s"}</span></div>
          ${this.statsOf({ inv, cur, sip, xirr, ret: inv ? fmt.pct(((cur - inv) / inv) * 100) : "" })}
          <span class="cv-drop">${open ? "▴" : "▾"}</span>
        </header>
        ${open ? `<div class="cv-groups">${t.entries.map((e) => this.platform(e, cur)).join("")}</div>` : ""}
      </section>`;
    },
    loans(b) {
      return `<section class="cv-block cv-loans"><header class="cv-head"><div class="cv-title"><h3>${esc(this.text(b.head, "B"))}</h3></div></header>
        <div class="cv-loanlist">${b.loans.map((r) => `<div><span>${esc(this.text(r, "B"))}</span><b>${fmt.money(this.num(r, "G") ?? 0)}</b></div>`).join("")}</div></section>`;
    },
    render(host) {
      const scroll = host.scrollTop;
      // Where the money sits: one bar across the fund types.
      const types = this.types();
      const parts = types.map((t) => ({ name: t.name, v: Math.max(0, t.entries.reduce((a, e) => a + this.cur(e.g.total), 0)) }));
      const sum = parts.reduce((a, x) => a + x.v, 0);
      const COLORS = TYPE_COLORS;
      const mix = sum && parts.length > 1 ? `<section class="cv-mix"><h3>Portfolio by fund type</h3>
          <div class="cv-mixbar">${parts.map((x, i) => `<i style="width:${(x.v / sum) * 100}%;background:${COLORS[i % COLORS.length]}" title="${esc(x.name)}"></i>`).join("")}</div>
          <div class="cv-legend">${parts.map((x, i) => `<span style="--dot:${COLORS[i % COLORS.length]}">${esc(x.name)} <b>${fmt.money(x.v)}</b> ${((x.v / sum) * 100).toFixed(1)}%</span>`).join("")}</div>
        </section>` : "";
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">${mix}${types.map((t, i) => this.type(t, i)).join("")
        || '<div class="card empty-state"><h2>No holdings</h2><p>Upload this client\'s portfolio to see it here.</p></div>'}${blocks.filter((b) => b.loans).map((b) => this.loans(b)).join("")}</div>`;
      host.scrollTop = scroll;
    },
  };

  // The other sheets in the dashboard look, as cards built from their cells. Every value carries
  // data-r/data-c, so it stays clickable and editable as in the Excel view.
  let seeded = new Set(); // card pages whose cards have been opened by default once
  const Pages = {
    v: (r, c) => wb.value(sheetName, r, c),
    t(r, c) {
      const v = this.v(r, c);
      if (v === null || v === undefined || v === "") return "";
      const f = SheetView.format(v, wb.xf(wb.sheet(sheetName), r, c).fmt);
      return `${f.left ?? ""}${f.text}`.trim();
    },
    n(r, c) { const v = this.v(r, c); return typeof v === "number" ? v : null; },
    range: (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i),
    // A cell's value that types into the cell when clicked.
    val(r, c, cls = "") {
      const e = isEditable(r, c);
      return `<b class="${cls} ${e ? "cv-edit" : ""} ${isEdited(r, c) ? "xl-edited" : ""}" data-r="${r}" data-c="${c}"${e ? ' title="Click to change"' : ""}>${esc(this.t(r, c)) || "–"}</b>`;
    },
    initials: (t) => t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•",
    findRow(c, re, from = 1) {
      const sh = wb.sheet(sheetName);
      for (let r = from; r <= sh.maxRow; r++) if (re.test(this.t(r, c))) return r;
      return null;
    },

    // Cover: the client, the review and the sheet's document details.
    "1"(host) {
      const logo = (wb.drawings["1"] || []).find((d) => d.img);
      const [title, sub = ""] = this.t(8, 4).split("\n");
      const tabs = wb.sheets.filter((s) => !s.hidden && s.name !== "1");
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">
        <section class="cv-cover">
          <div class="cv-cover-main">
            ${logo ? `<div class="cv-cover-logo"><img src="${logo.img}" alt=""></div>` : ""}
            <span class="cv-eyebrow">${esc(title)} ${esc(sub)}</span>
            <h2>${this.val(17, 4)}</h2>
            <p>Review date ${esc(SheetView.format(SheetView.toSerial(new Date(`${edits.reviewDate || data.today}T00:00:00Z`)), "dd mmm yyyy").text)}</p>
          </div>
          <dl class="cv-cover-meta">${[3, 4, 5].map((r) => `<div><dt>${esc(this.t(r, 16))}</dt><dd>${this.val(r, 17)}</dd></div>`).join("")}</dl>
        </section>
        <div class="cv-tiles">${tabs.map((s, i) => `<button type="button" class="cv-tile" data-goto="${esc(s.name)}"><i class="cv-logo cv-t${i % 6}">${i + 1}</i>
          <span><b>${esc(TAB_NAMES[s.name] || s.name.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()))}</b><small>Open this section</small></span><em>›</em></button>`).join("")}</div>
      </div>`;
      host.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => $("xlTabs").querySelector(`[data-sheet="${CSS.escape(b.dataset.goto)}"]`)?.click()));
    },

    // Summary: today's wealth and live SIP, and the two journey charts.
    Summary(host) {
      const charts = (wb.drawings.Summary || []).filter((d) => d.chart);
      const tile = (lr, vr, cls) => `<section class="cv-hero ${cls}"><span>${esc(this.t(lr, 8))}</span><b>${esc(this.t(vr, 8)) || "–"}</b></section>`;
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">
        <div class="cv-two">${tile(5, 11, "cv-hero-a")}${tile(18, 24, "cv-hero-b")}</div>
        <div class="cv-two">${charts.map((d) => `<section class="cv-block cv-chart">${SheetView.chart(wb, d.chart, 640, 330, true)}</section>`).join("")}</div>
      </div>`;
    },

    // ---- Shared pieces for the card pages ----
    str(r, c) { const x = wb.raw(sheetName, r, c); return x && !x.f && typeof x.v === "string" && x.v.trim() ? x.v.trim() : null; },
    filled(r, cols) { return cols.some((c) => { const v = this.v(r, c); return v !== null && v !== undefined && v !== "" && v !== 0; }); },
    stat: (label, value, cls = "") => `<div class="${cls}"><span>${esc(label)}</span><b>${value}</b></div>`,
    // A card that opens with its dropdown. o: {key, logo, logoCls, title, sub, stats, body() (only built when open), dim}.
    drop(o) {
      const open = openCards.has(o.key);
      return `<section class="cv-block ${open ? "" : "cv-closed"} ${o.dim ? "cv-dim" : ""}">
        <header class="cv-head cv-toggle" data-toggle="${esc(o.key)}" role="button" aria-expanded="${open}">
          ${o.logo ? `<div class="cv-logo ${o.logoCls || ""}">${esc(o.logo)}</div>` : ""}
          <div class="cv-title"><h3>${esc(o.title)}</h3>${o.sub ? `<span>${o.sub}</span>` : ""}</div>
          ${o.stats ? `<div class="cv-stats cv-stats-auto">${o.stats}</div>` : ""}
          <span class="cv-drop">${open ? "▴" : "▾"}</span>
        </header>
        ${open ? `<div class="cv-inner">${o.body()}</div>` : ""}
      </section>`;
    },
    // A clean table of cells: rows [{r, label, cls}], cols [{c, label}]; values type into their cells.
    table(rows, cols, opts = {}) {
      return `<div class="cv-tablewrap"><table class="cv-table ${opts.cls || ""}"><thead><tr>${opts.noLabel ? "" : `<th>${esc(opts.corner || "")}</th>`}${cols.map((x) => `<th>${esc(x.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((x) => `<tr class="${x.cls || ""}">${opts.noLabel ? "" : `<th>${esc(x.label)}</th>`}${cols.map((k) => `<td class="${typeof this.v(x.r, k.c) === "number" || !this.str(x.r, k.c) ? "cv-num" : ""}">${this.val(x.r, k.c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    },
    seed(sheet, keys) {
      if (seeded.has(sheet)) return;
      seeded.add(sheet);
      for (const k of keys) openCards.add(k);
    },
    page(host, html) {
      host.innerHTML = `<div class="cv" style="zoom:${zoom}">${html}</div>`;
    },

    // Portfolio Journey: like DETAILED PORTFOLIO. A "wealth by year" card, then a card per section
    // (mutual funds, stocks, other savings, passive income) that opens to its platforms or items;
    // each opens to its rows by year, which can be typed into.
    "Portfolio Journey"(host) {
      const sh = wb.sheet(sheetName);
      const start = this.n(5, 6) || 0, rd = this.n(2, 7);
      const year = rd ? SheetView.fromSerial(rd).getUTCFullYear() : start;
      const yc = 6 + Math.max(0, year - start);
      let last = yc;
      for (const x of sh.cells.values()) if (x.r > 5 && x.c > last && typeof x.v === "number" && !x.f && x.v) last = x.c;
      const years = this.range(6, last).map((c) => ({ c, label: this.t(5, c) }));
      const ycols = years.map((y) => y.c);
      const label = (r) => this.str(r, 5) || this.str(r, 4) || this.t(r, 4) || this.t(r, 2);
      const money = (r, c = yc) => fmt.money(this.n(r, c) ?? 0);
      const growth = (r) => {
        const a = this.n(r, yc - 1), b = this.n(r, yc);
        if (yc <= 6 || !a || b === null) return "";
        const g = ((b - a) / Math.abs(a)) * 100;
        return `<span class="cv-pill ${g < 0 ? "cv-down" : "cv-up"}">${g >= 0 ? "▲" : "▼"} ${Math.abs(g).toFixed(1)}%</span>`;
      };
      const find = (re, from = 6) => this.findRow(2, re, from);
      const stocks = find(/^STOCKS$/i), other = find(/^OTHER SAVINGS/i), grand = find(/^Grand Total Portfolio Value/i), passive = find(/^Existing Passive Income/i);
      const SECTION_ROW = /^(Total\s+\S|Grand Total|Redemption|Reason|Withdrawal|Remarks)/i;
      // Items of a section: a new one starts at each name in column B.
      const parse = (a, b) => {
        const items = [], extra = [];
        let cur = null;
        for (let r = a; r <= b; r++) {
          const name = this.str(r, 2);
          if (name && SECTION_ROW.test(name)) { cur = null; extra.push(r); continue; }
          if (name) { cur = { name, rows: [] }; items.push(cur); }
          if (cur && label(r)) cur.rows.push(r);
        }
        return { items, extra };
      };
      const item = (sec, it, i) => {
        const key = `pj|${sec}|${it.name}`, open = openCards.has(key);
        const total = it.rows.find((r) => this.str(r, 4) && !this.str(r, 5) && it.rows.length > 2 && /Portfolio Value$/i.test(this.str(r, 4)));
        const head = it.head ?? total ?? it.rows[0];
        const sip = it.sip ?? it.rows.find((r) => r !== head && /SIP|Monthly|Contribution/i.test(label(r)) && (!total || !this.str(r, 5)));
        const any = it.rows.some((r) => this.filled(r, ycols));
        const chips = years.map((y) => `<span class="cv-chip ${y.c === yc ? "on" : ""}"><small>${esc(y.label)}</small>${money(head, y.c)}</span>`).join("");
        return `<div class="cv-group ${open ? "open" : ""} ${any ? "" : "cv-dim"}">
          <div class="cv-ghead cv-jhead" data-toggle="${esc(key)}" role="button" aria-expanded="${open}">
            <span class="cv-caret">${open ? "▾" : "▸"}</span>
            <div class="cv-gname"><i class="cv-plogo cv-c${i % 3}">${esc(this.initials(it.name))}</i><div><b>${esc(it.name)}</b><span>${any ? esc(label(head)) : "No values yet · click to add"}</span></div></div>
            <div class="cv-chips">${chips}</div>
            <div class="cv-gnum"><span>${esc(String(year))}</span><b>${money(head)}</b>${growth(head)}</div>
            ${sip ? `<div class="cv-gnum"><span>${/SIP/i.test(label(sip)) ? "Live SIP" : "Monthly"}</span><b>${money(sip)}</b></div>` : "<div></div>"}
          </div>
          ${open ? `<div class="cv-schemes cv-one">${this.table(it.rows.map((r) => ({ r, label: label(r), cls: r === total ? "cv-trow" : "" })), years, { corner: "By year" })}</div>` : ""}
        </div>`;
      };
      const sections = [];
      const sec = (key, title, logo, a, b, sub) => {
        if (!a || b < a) return;
        const { items, extra } = parse(a, b);
        const stats = extra.filter((r) => /^(Total|Grand Total)/i.test(this.str(r, 2)) && this.n(r, yc) !== null);
        const notes = extra.filter((r) => !stats.includes(r));
        // The TOTAL block of mutual funds: the totals by fund type, across platforms.
        for (const it of items) if (/^TOTAL$/i.test(it.name)) { it.name = "All platforms"; it.head = stats[0]; it.sip = stats[1]; }
        sections.push(this.drop({ key: `pj|${key}`, logo, logoCls: `cv-t${sections.length % 6}`, title,
          sub: `${sub} · ${items.length} ${key === "passive" ? "source" : "item"}${items.length === 1 ? "" : "s"}`,
          stats: stats.slice(0, 2).map((r) => this.stat(this.str(r, 2).replace(/\s*\(.*\)$/, ""), money(r))).join(""),
          body: () => `<div class="cv-groups">${items.map((it, i) => item(key, it, i)).join("")}</div>
            ${notes.length ? `<div class="cv-notes">${this.table(notes.map((r) => ({ r, label: this.str(r, 2) })), years, { corner: "Notes", cls: "cv-table-notes" })}</div>` : ""}` }));
      };
      sec("mf", "Mutual funds", "M", 6, (stocks || sh.maxRow + 1) - 1, "By platform");
      sec("stocks", "Stocks & PMS", "S", stocks && stocks + 1, (other || sh.maxRow + 1) - 1, "By platform");
      sec("other", "Other savings & investments", "O", other && other + 1, (grand || passive || sh.maxRow + 1) - 1, "EPF, PPF, FD, NPS, gold and more");
      sec("passive", "Passive income", "P", passive && passive + 1, sh.maxRow, "Existing monthly provision");
      // Wealth by year, from the grand total rows.
      const gRows = grand ? this.range(grand, (passive || grand + 3) - 1).filter((r) => this.str(r, 2)) : [];
      const tiles = gRows.length ? `<section class="cv-block cv-years"><header class="cv-head"><div class="cv-logo cv-t0">₹</div><div class="cv-title"><h3>Wealth by year</h3><span>All assets, up to the review year</span></div></header>
        <div class="cv-yeargrid">${years.map((y, i) => {
          const v = this.n(gRows[0], y.c), p = i ? this.n(gRows[0], y.c - 1) : null;
          const g = p ? ((v - p) / Math.abs(p)) * 100 : null;
          return `<div class="cv-year ${y.c === yc ? "on" : ""}"><span>${esc(y.label)}</span><b>${fmt.money(v ?? 0)}</b>
            ${g !== null && Number.isFinite(g) ? `<em class="${g < 0 ? "cv-down" : "cv-up"}">${g >= 0 ? "▲" : "▼"} ${Math.abs(g).toFixed(1)}% vs ${esc(years[i - 1].label)}</em>` : "<em>&nbsp;</em>"}
            ${gRows.slice(1).map((r) => `<small>${esc(this.str(r, 2).replace(/^(Grand )?Total /i, "").replace(/\s*\(.*\)$/, ""))} <i>${fmt.money(this.n(r, y.c) ?? 0)}</i></small>`).join("")}</div>`;
        }).join("")}</div></section>` : "";
      this.page(host, tiles + sections.join(""));
    },

    // Summary Portfolio: a "review history" card (wealth, invested, gain and SIP on each review
    // date), then a card per platform that opens to its figures by date.
    "SUMMARY PORTFOLIO"(host) {
      const sh = wb.sheet(sheetName);
      const dates = this.range(3, sh.maxRow).filter((r) => this.v(r, 1) !== null && this.v(r, 1) !== "");
      const groups = sh.merges.filter((m) => m.r1 === 1 && this.t(1, m.c1)).sort((a, b) => a.c1 - b.c1)
        .map((m) => ({ title: this.t(1, m.c1), cols: this.range(m.c1, m.c2).filter((c) => this.t(2, c)) }));
      const head = (c) => this.t(2, c);
      const colOf = (g, re) => [...g.cols].reverse().find((c) => re.test(head(c)));
      const latest = dates[dates.length - 1];
      const grandG = groups.find((g) => /GRAND TOTAL/i.test(g.title));
      const firmG = groups.find((g) => /TOTAL PORTFOLIO/i.test(g.title) && g !== grandG);
      const inv = grandG && colOf(grandG, /INVESTED/i), wealth = grandG && colOf(grandG, /WEALTH|VALUE/i), gain = grandG && colOf(grandG, /GAIN/i);
      const sipC = firmG && colOf(firmG, /SIP/i);
      const hist = dates.length ? `<section class="cv-block cv-years"><header class="cv-head"><div class="cv-logo cv-t0">₹</div><div class="cv-title"><h3>Review history</h3><span>${dates.length} review date${dates.length === 1 ? "" : "s"}</span></div></header>
        <div class="cv-yeargrid">${dates.map((r, i) => {
          const v = wealth ? this.n(r, wealth) : null, p = i && wealth ? this.n(dates[i - 1], wealth) : null;
          const g = p ? ((v - p) / Math.abs(p)) * 100 : null;
          return `<div class="cv-year ${r === latest ? "on" : ""}"><span>${esc(this.t(r, 1))}</span><b>${fmt.money(v ?? 0)}</b>
            ${g !== null && Number.isFinite(g) ? `<em class="${g < 0 ? "cv-down" : "cv-up"}">${g >= 0 ? "▲" : "▼"} ${Math.abs(g).toFixed(1)}% since last review</em>` : "<em>&nbsp;</em>"}
            ${inv ? `<small>Invested <i>${fmt.money(this.n(r, inv) ?? 0)}</i></small>` : ""}
            ${gain ? `<small>Gain <i>${fmt.money(this.n(r, gain) ?? 0)}</i></small>` : ""}
            ${sipC ? `<small>Live SIP <i>${fmt.money(this.n(r, sipC) ?? 0)}</i></small>` : ""}</div>`;
        }).join("")}</div></section>` : "";
      const cards = groups.map((g, i) => {
        const any = dates.some((r) => this.filled(r, g.cols));
        const tot = colOf(g, /WEALTH|PORTFOLIO VALUE/i) || colOf(g, /TOTAL/i), sip = colOf(g, /SIP/i);
        return this.drop({ key: `sp|${g.title}`, logo: this.initials(g.title.replace(/\b(TOTAL|PORTFOLIO)\b/gi, "").trim() || g.title), logoCls: `cv-t${i % 6}`,
          title: g.title.replace(/\b\w+/g, (w) => (w.length > 3 || !/^[A-Z]+$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)), dim: !any,
          sub: any ? `${g.cols.length} column${g.cols.length === 1 ? "" : "s"} · latest ${esc(this.t(latest, 1))}` : "No figures yet · open to add",
          stats: any ? [tot && this.stat(head(tot).replace(/^TOTAL\s*/i, "") || "Total", fmt.money(this.n(latest, tot) ?? 0)), sip && sip !== tot && this.stat("Live SIP", fmt.money(this.n(latest, sip) ?? 0))].filter(Boolean).join("") : "",
          body: () => this.table(dates.map((r) => ({ r, label: this.t(r, 1) })), g.cols.map((c) => ({ c, label: head(c) })), { corner: "Review date" }) });
      });
      this.page(host, hist + cards.join(""));
    },

    // Freedom Blueprint: a card per section. Personal details as a form, the levels as cards
    // with progress, the asset table as a clean table, and the charts on light cards.
    "Freedom Blueprint"(host) {
      const sh = wb.sheet(sheetName);
      const COLS = this.range(2, 16);
      const marks = [];
      for (let r = 1; r <= sh.maxRow; r++) {
        const t = this.t(r, 2);
        if (/^Section [A-Z]\b|^CONCLUSION$/i.test(t)) marks.push({ r, title: t });
        else if (/^In How Many Years/i.test(t)) marks.push({ r, title: t, question: true });
      }
      const keys = marks.map((m) => `bp|${m.title}`);
      this.seed(sheetName, keys);
      const strCells = (r) => COLS.filter((c) => this.str(r, c));
      const charts = (a, b) => (wb.drawings[sheetName] || []).filter((d) => d.chart && d.from && d.from.r + 1 >= a && d.from.r + 1 <= b);
      // Tables in a block of rows: a heading row (3+ text cells), maybe a second heading row, then data rows.
      const tables = (a, b) => {
        const out = [];
        let r = a;
        while (r <= b) {
          const hs = strCells(r);
          if (hs.length < 3 || hs.some((c) => wb.raw(sheetName, r + 1, c)?.f)) { r++; continue; }
          const cols = hs.map((c) => ({ c, label: this.str(r, c).replace(/\s+/g, " ") }));
          let d = r + 1;
          const sub = strCells(d);
          if (sub.length && sub.every((c) => hs.includes(c)) && !COLS.some((c) => typeof this.v(d, c) === "number")) {
            for (const x of cols) if (this.str(d, x.c)) x.label += ` · ${this.str(d, x.c).replace(/\s+/g, " ")}`;
            d++;
          }
          const rows = [];
          let gap = 0;
          for (; d <= b && gap < 2; d++) {
            if (this.filled(d, hs) || hs.some((c) => wb.raw(sheetName, d, c))) { rows.push(d); gap = 0; } else if (rows.length) gap++;
          }
          out.push({ head: r, cols, rows: rows.filter((x) => this.filled(x, hs)) });
          r = d;
        }
        return out;
      };
      const levelCards = (t) => {
        const [lv, stage, ...rest] = t.cols;
        const req = rest.find((x) => /Required\s+Wealth/i.test(x.label)), exp = rest.find((x) => /^Expected Wealth/i.test(x.label));
        return `<div class="cv-levels">${t.rows.map((r) => {
          const fill = wb.xf(sh, r, lv.c).fill;
          const p = req && exp && this.n(r, req.c) ? Math.max(0, Math.min(100, ((this.n(r, exp.c) || 0) / this.n(r, req.c)) * 100)) : null;
          return `<article class="cv-level" style="--lv:#${fill || "E6ECF6"}">
            <div class="cv-lvhead"><span class="cv-lvchip">${esc(this.t(r, lv.c))}</span><h4>${esc(this.t(r, stage.c))}</h4></div>
            ${p !== null ? `<div class="cv-prog" title="${p.toFixed(0)}% of the target"><i style="width:${p}%"></i></div><small class="cv-progl">${p >= 100 ? "Reached" : `${p.toFixed(0)}% of the target`}</small>` : ""}
            <div class="cv-lvfields">${rest.map((x) => `<div class="cv-f ${x.label.length > 40 ? "cv-wide2" : ""}"><span>${esc(x.label)}</span>${this.val(r, x.c)}</div>`).join("")}</div>
          </article>`;
        }).join("")}</div>`;
      };
      const body = (m, a, b) => {
        let html = "";
        if (/Personal/i.test(m.title)) {
          const fields = [];
          for (let r = a; r <= b; r++) {
            const ls = strCells(r).filter((c) => !/^Date\s*:?$/i.test(this.str(r, c)));
            if (ls.length >= 2) { for (const c of ls) fields.push({ label: this.str(r, c), r: r + 1, c }); r++; }
          }
          const dc = COLS.find((c) => /^Date\s*:?$/i.test(this.str(m.r, c) || ""));
          return `<div class="cv-form">${fields.map((f) => `<div class="cv-f"><span>${esc(f.label)}</span>${this.val(f.r, f.c, "cv-input")}</div>`).join("")}
            ${dc ? `<div class="cv-f"><span>Review date</span>${this.val(m.r, COLS.find((c) => c > dc && this.v(m.r, c) !== null) || dc + 1, "cv-input")}</div>` : ""}</div>`;
        }
        const ts = tables(a, b);
        const before = ts.length ? ts[0].head : b + 1;
        const notes = this.range(a, before - 1).flatMap((r) => strCells(r).map((c) => this.str(r, c)));
        if (notes.length) html += `<p class="cv-lead">${notes.map(esc).join(" ")}</p>`;
        for (const t of ts) {
          const isLevels = t.rows.length && t.rows.every((r) => /Level\s*\d/i.test(this.t(r, t.cols[0].c)));
          html += isLevels ? levelCards(t)
            : this.table(t.rows.map((r) => ({ r, label: "", cls: /^total$/i.test(this.t(r, t.cols[1]?.c) || this.t(r, t.cols[0].c)) ? "cv-trow" : "" })), t.cols, { noLabel: true, cls: "cv-table-wide" });
        }
        const cs = charts(a, b);
        if (cs.length) html += `<div class="cv-two">${cs.map((d) => `<section class="cv-block cv-chart">${SheetView.chart(wb, d.chart, 640, 330, true)}</section>`).join("")}</div>`;
        if (!ts.length) {
          const text = this.range(a, b).flatMap((r) => COLS.filter((c) => this.str(r, c)).map((c) => ({ r, c })));
          html += text.map((x) => `<p class="cv-text">${this.val(x.r, x.c)}</p>`).join("");
        }
        return html;
      };
      const cards = marks.map((m, i) => {
        const end = (marks[i + 1]?.r || sh.maxRow + 1) - 1;
        if (m.question) {
          const vc = COLS.find((c) => c > 2 && this.v(m.r, c) !== null && this.v(m.r, c) !== "");
          return `<section class="cv-question"><span>${esc(m.title)}</span><div>${this.val(m.r, vc || 15, "cv-qval")}<small>years</small></div></section>`;
        }
        const [letter, name] = m.title.includes(":") ? m.title.split(/\s*:\s*/) : ["", m.title];
        return this.drop({ key: `bp|${m.title}`, logo: (letter.match(/Section ([A-Z])/i)?.[1] || name[0]).toUpperCase(), logoCls: `cv-t${i % 6}`,
          title: name.replace(/\s+$/, ""), sub: letter || "", body: () => body(m, m.r + 1, end) });
      });
      this.page(host, cards.join(""));
    },
  };

  // Totals with the changes, for the header.
  function kpis() {
    const el = $("xlKpis");
    if (!el) return;
    const f = Review.prepare(data, clean(edits)).current;
    const gain = f.value - f.invested;
    const chip = (label, v, cls = "") => `<div class="xl-kpi ${cls}"><span>${label}</span><b>${v}</b></div>`;
    // XIRR as the review sheet works it out (value-weighted, on DETAILED PORTFOLIO's total row).
    const xirr = wb && grandRow ? wb.value(DETAILED, grandRow, 11) : null;
    el.innerHTML = chip("Invested", fmt.money(f.invested), "k-inv") + chip("Current value", fmt.money(f.value), "k-cur")
      + chip("Gain", fmt.money(gain), gain < 0 ? "xl-down" : "xl-up")
      + chip("Abs. return", fmt.pct(f.invested ? (gain / f.invested) * 100 : null), "k-ret")
      + chip("XIRR", typeof xirr === "number" ? fmt.pct(xirr) : "–", "k-xirr")
      + chip("Live SIP", fmt.money(f.sip), "k-sip");
  }

  // ---- Which cells can change -----------------------------------------------------------------
  const field = (r, c) => (sheetName === DETAILED && schemeRows.has(r) ? Review.DETAIL_FIELDS[SheetView.colName(c)] : null);
  function isEditable(r, c) {
    if (sheetName === DETAILED) return !!field(r, c);
    const x = wb.raw(sheetName, r, c);
    return !x || !x.f;
  }
  function isEdited(r, c) {
    if (sheetName === DETAILED) {
      const f = field(r, c);
      return !!f && edits.schemes?.[schemeRows.get(r)]?.[f] !== undefined;
    }
    return edits.cells?.[sheetName]?.[SheetView.refOf(r, c)] !== undefined;
  }

  // ---- Selection and typing -------------------------------------------------------------------
  function select(r, c) {
    sel = { r, c };
    showSelection();
  }

  function rawText(r, c) {
    const x = wb.raw(sheetName, r, c);
    if (!x) return "";
    if (x.f) return `=${x.f}`;
    if (x.v === null || x.v === undefined) return "";
    if (typeof x.v === "number") {
      const st = wb.xf(wb.sheet(sheetName), r, c);
      if (/[dy]/i.test(st.fmt.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/[0#]/.test(st.fmt)) return SheetView.format(x.v, "dd-mm-yyyy").text;
      if (/%/.test(st.fmt)) return `${Math.round(x.v * 1e6) / 1e4}%`;
      return String(Math.round(x.v * 1e4) / 1e4);
    }
    return typeof x.v === "object" ? x.v.e || "" : String(x.v);
  }

  function showSelection() {
    const host = $("xlHost");
    if (!host) return;
    host.querySelectorAll(".xl-sel").forEach((x) => x.classList.remove("xl-sel"));
    if (!sel) { $("xlName").textContent = ""; $("xlFx").value = ""; $("xlFx").readOnly = true; return; }
    const td = host.querySelector(`[data-r="${sel.r}"][data-c="${sel.c}"]`);
    if (td) td.classList.add("xl-sel");
    $("xlName").textContent = SheetView.refOf(sel.r, sel.c);
    $("xlFx").value = rawText(sel.r, sel.c);
    $("xlFx").readOnly = !isEditable(sel.r, sel.c);
    $("xlFx").title = isEditable(sel.r, sel.c) ? "" : readOnlyReason(sel.r, sel.c);
  }

  function readOnlyReason(r) {
    if (sheetName === DETAILED) return schemeRows.has(r) ? "This column is worked out from the others." : "Totals and headings are worked out from the schemes.";
    return "This cell is a formula and is worked out from other cells.";
  }

  function move(dr, dc) {
    if (!sel) return;
    const r = Math.max(1, sel.r + dr), c = Math.max(1, sel.c + dc);
    // Skip hidden rows and columns.
    const host = $("xlHost");
    let rr = r, cc = c;
    for (let i = 0; i < 50 && !host.querySelector(`[data-r="${rr}"][data-c="${cc}"]`); i++) { rr += dr; cc += dc; if (rr < 1 || cc < 1) return; }
    if (!host.querySelector(`[data-r="${rr}"][data-c="${cc}"]`)) return;
    select(rr, cc);
    host.querySelector(".xl-sel")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function onKey(e) {
    if (editor || !sel) return;
    const k = e.key;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1], Enter: [1, 0] };
    if (k === "F2") { e.preventDefault(); openEditor(); return; }
    if (arrows[k]) { e.preventDefault(); move(...arrows[k]); return; }
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); commit(sel.r, sel.c, ""); return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openEditor(k); }
  }

  function openEditor(initial) {
    if (!sel) return;
    if (!isEditable(sel.r, sel.c)) { setStatus(readOnlyReason(sel.r, sel.c), "warn"); return; }
    const td = $("xlHost").querySelector(`[data-r="${sel.r}"][data-c="${sel.c}"]`);
    if (!td) return;
    const rect = td.getBoundingClientRect();
    closeEditor(false);
    const { r, c } = sel;
    const input = document.createElement("input");
    input.className = "xl-editor";
    input.value = initial !== undefined ? initial : rawText(r, c);
    Object.assign(input.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(rect.width, 120)}px`, height: `${Math.max(rect.height, 22)}px` });
    document.body.appendChild(input);
    editor = { input, r, c };
    input.focus();
    if (initial === undefined) input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); closeEditor(true, { r: 1, c: 0 }); }
      else if (e.key === "Tab") { e.preventDefault(); closeEditor(true, { r: 0, c: e.shiftKey ? -1 : 1 }); }
      else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    });
    input.addEventListener("blur", () => closeEditor(true));
  }

  function closeEditor(keep, step) {
    if (!editor) return;
    const { input, r, c } = editor;
    editor = null;
    input.remove();
    $("xlHost")?.focus({ preventScroll: true });
    if (keep && input.value !== rawText(r, c)) commit(r, c, input.value, step);
    else if (step) move(step.r, step.c);
  }

  // What the reviewer typed, as a number, date serial or text.
  function parseInput(text, r, c) {
    const t = String(text).trim();
    if (t === "") return "";
    if (t.startsWith("=")) return { error: "Formulas can't be typed here; type the value instead." };
    const n = t.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
    if (/^-?\d*\.?\d+%$/.test(n)) return Number(n.slice(0, -1)) / 100;
    if (/^-?\d*\.?\d+$/.test(n)) return Number(n);
    const st = wb.xf(wb.sheet(sheetName), r, c);
    const d = /^(\d{1,2})[-/. ](\d{1,2}|[A-Za-z]{3,})[-/. ](\d{2,4})$/.exec(t) || null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (iso) return SheetView.toSerial(new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])));
    if (d && (/[dmy]/i.test(st.fmt) || /[A-Za-z]/.test(d[2]))) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const m = /^\d+$/.test(d[2]) ? Number(d[2]) : months.indexOf(d[2].slice(0, 3).toLowerCase()) + 1;
      const y = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
      if (m >= 1 && m <= 12) return SheetView.toSerial(new Date(Date.UTC(y, m - 1, Number(d[1]))));
    }
    return t;
  }

  async function commit(r, c, text, step) {
    if (!isEditable(r, c)) { setStatus(readOnlyReason(r, c), "warn"); return; }
    const v = parseInput(text, r, c);
    if (v && typeof v === "object") { setStatus(v.error, "warn"); return; }
    if (sheetName === DETAILED) {
      const f = field(r, c), k = schemeRows.get(r);
      const s = ((edits.schemes ||= {})[k] ||= {});
      if (v === "") delete s[f];
      else if (NUMBER_FIELDS.has(f)) {
        if (typeof v !== "number") { setStatus("Type a number in this column.", "warn"); return; }
        s[f] = f === "xirr" && /%/.test(text) ? v * 100 : v;
      } else s[f] = String(typeof v === "number" ? text.trim() : v);
      if (!Object.keys(s).length) delete edits.schemes[k];
    } else {
      ((edits.cells ||= {})[sheetName] ||= {})[SheetView.refOf(r, c)] = v;
    }
    if (step) move(step.r, step.c);
    changed();
  }

  function changed() {
    scheduleSave();
    rebuild();
  }

  // ---- Right-click menu -------------------------------------------------------------------------
  function hideMenu() { const m = $("xlMenu"); if (m) m.hidden = true; }

  function openMenu(e, items) {
    const m = $("xlMenu");
    if (!items.length) return;
    m.innerHTML = items.map((it, i) => (it === "-" ? '<hr>' : it.head ? `<div class="xl-mh">${esc(it.head)}</div>`
      : `<button type="button" data-i="${i}" ${it.on ? 'class="on"' : ""}>${esc(it.label)}</button>`)).join("");
    m.hidden = false;
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.min(e.clientX, innerWidth - w - 8)}px`;
    m.style.top = `${Math.min(e.clientY, innerHeight - h - 8)}px`;
    m.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { hideMenu(); items[Number(b.dataset.i)].run(); }));
  }

  function cellMenu(e) {
    const { r, c } = sel;
    const items = [];
    if (isEditable(r, c)) items.push({ label: "Change this cell…", run: () => openEditor() });
    if (isEdited(r, c)) {
      items.push({ label: "Undo my change to this cell", run: () => {
        if (sheetName === DETAILED) { const s = edits.schemes[schemeRows.get(r)]; delete s[field(r, c)]; if (!Object.keys(s).length) delete edits.schemes[schemeRows.get(r)]; }
        else { delete edits.cells[sheetName][SheetView.refOf(r, c)]; }
        changed();
      } });
    }
    if (sheetName === DETAILED && schemeRows.has(r)) {
      const k = schemeRows.get(r);
      const s = edits.schemes?.[k] || {};
      if (k.split("|")[1] === "MF") {
        items.push("-", { head: `Fund type of ${names.get(k) || "this scheme"}` });
        for (const t of Review.MF_TYPES) {
          items.push({ label: t, on: s.type === t, run: () => { const x = ((edits.schemes ||= {})[k] ||= {}); x.type = t; changed(); } });
        }
        if (s.type) items.push({ label: "As uploaded", run: () => { delete edits.schemes[k].type; if (!Object.keys(edits.schemes[k]).length) delete edits.schemes[k]; changed(); } });
      }
      items.push("-", { label: "Leave this scheme out of the report", run: () => { ((edits.schemes ||= {})[k] ||= {}).excluded = true; changed(); } });
      if (Object.keys(s).length) items.push({ label: "Undo all changes to this scheme", run: () => { delete edits.schemes[k]; changed(); } });
    }
    if (!items.length) items.push({ head: readOnlyReason(r, c) });
    openMenu(e, items);
  }

  const leftOutKeys = () => Object.entries(edits.schemes || {}).filter(([, s]) => s.excluded).map(([k]) => k);
  function leftOut() {
    const b = $("xlOut");
    const ks = leftOutKeys();
    b.hidden = !ks.length;
    b.textContent = `${ks.length} scheme${ks.length === 1 ? "" : "s"} left out ▾`;
  }
  function leftOutMenu(e) {
    const items = [{ head: "Bring a scheme back into the report" }];
    for (const k of leftOutKeys()) items.push({ label: names.get(k) || k, run: () => { delete edits.schemes[k].excluded; if (!Object.keys(edits.schemes[k]).length) delete edits.schemes[k]; changed(); } });
    openMenu(e, items);
  }

  // ---- Export and reset -------------------------------------------------------------------------
  async function exportNow() {
    const b = $("xlExport");
    b.disabled = true;
    b.textContent = "Preparing…";
    try {
      await flush();
      await Review.exportFile(data, clean(edits));
    } catch (err) {
      alert(`Could not create the review report: ${err.message}`);
    } finally {
      b.disabled = false;
      b.textContent = "Export Excel";
    }
  }

  async function reset() {
    if (!confirm(`Remove every change made to ${data.clientName}'s review sheet? It goes back to the uploaded figures.`)) return;
    clearTimeout(saveTimer);
    dirty = false;
    try {
      await api("DELETE", `/review/edits?client=${enc(data.clientName)}`);
    } catch (e) { return alert(`Could not reset: ${e.message}`); }
    edits = {};
    $("xlDate").value = data.today;
    setStatus("Changes removed", "ok");
    await rebuild();
  }

  // Leaving the page (another route) saves what is pending.
  function leave() {
    document.body.classList.remove("xl-mode");
    closeEditor(true);
    hideMenu();
    if (!active) return;
    active = false;
    flush();
  }
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#xlMenu")) hideMenu(); });
  window.addEventListener("beforeunload", (e) => { if (dirty) { save().catch(() => {}); e.preventDefault(); } });

  return { show, leave };
})();
