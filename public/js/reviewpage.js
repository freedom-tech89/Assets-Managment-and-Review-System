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
  let sheetName = null, sel = null, editor = null, active = false, building = null, pending = false;
  let saveTimer = null, saving = null, dirty = false;
  let zoom = Number(store("xlZoom")) || 0.9;

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
    shell();
    active = true;
    await rebuild();
  }

  function shell() {
    const c = data.clientName;
    view.innerHTML = `<div class="xl-app">
      <div class="xl-bar">
        <a class="xl-back" href="#/client/${enc(c)}" title="Back to ${esc(c)}">‹</a>
        <div class="xl-title"><b>Review Sheet of ${esc(c)}</b><span>Click a cell to change it. Right-click a scheme for more.</span></div>
        <label class="xl-date">Review date <input type="date" id="xlDate" value="${esc(edits.reviewDate || data.today)}"></label>
        <span id="xlStatus" class="xl-status ${data.editsSavedAt ? "ok" : ""}">${data.editsSavedAt ? "Changes saved" : "No changes yet"}</span>
        <button type="button" class="xl-btn" id="xlReset">Reset changes</button>
        <button type="button" class="xl-btn xl-export" id="xlExport">Export Excel</button>
      </div>
      <div class="xl-fx"><span id="xlName" class="xl-name"></span><span class="xl-fxl">fx</span><input id="xlFx" autocomplete="off" spellcheck="false"></div>
      <div id="xlHost" class="xl-host" tabindex="0"></div>
      <div class="xl-foot">
        <div id="xlTabs" class="xl-tabs" role="tablist"></div>
        <button type="button" id="xlOut" class="xl-out" hidden></button>
        <div class="xl-zoom"><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><span id="xlZoom"></span><button type="button" data-zoom="1" aria-label="Zoom in">+</button></div>
      </div>
      <div id="xlMenu" class="xl-menu" hidden></div>
    </div>`;
    $("xlExport").addEventListener("click", exportNow);
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
    const host = $("xlHost");
    host.addEventListener("click", (e) => {
      const td = e.target.closest("td[data-r]");
      if (td) select(Number(td.dataset.r), Number(td.dataset.c));
    });
    host.addEventListener("dblclick", (e) => {
      const td = e.target.closest("td[data-r]");
      if (td) { select(Number(td.dataset.r), Number(td.dataset.c)); openEditor(); }
    });
    host.addEventListener("contextmenu", (e) => {
      const td = e.target.closest("td[data-r]");
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
        wb = await SheetView.load(out.zip);
        if (!sheetName || !wb.sheets.some((s) => s.name === sheetName && !s.hidden)) {
          const remembered = store("xlSheet");
          sheetName = wb.sheets.some((s) => s.name === remembered && !s.hidden) ? remembered
            : wb.sheets.find((s) => s.name === "Summary")?.name || wb.sheets.find((s) => !s.hidden).name;
        }
        if (active) { tabs(); draw(); leftOut(); }
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
      `<button type="button" role="tab" class="xl-tab ${s.name === sheetName ? "on" : ""}" data-sheet="${esc(s.name)}" aria-selected="${s.name === sheetName}">${esc(s.name)}</button>`).join("");
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
    SheetView.render(wb, sheetName, host, { zoom, isEdited, isEditable });
    host.scrollLeft = scroll.x;
    host.scrollTop = scroll.y;
    $("xlZoom").textContent = `${Math.round(zoom * 100)}%`;
    showSelection();
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
    const td = host.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`);
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
    for (let i = 0; i < 50 && !host.querySelector(`td[data-r="${rr}"][data-c="${cc}"]`); i++) { rr += dr; cc += dc; if (rr < 1 || cc < 1) return; }
    if (!host.querySelector(`td[data-r="${rr}"][data-c="${cc}"]`)) return;
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
    const td = $("xlHost").querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`);
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
