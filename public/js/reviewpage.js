// Review Report page (#/review/<client>): the figures that go into the client review sheet, which
// the reviewer can correct and add to before exporting. Changes are saved per client on the server
// (/api/review/edits), apart from the uploaded data, which is never changed. Export builds the
// Excel file from the uploaded data with these changes applied (public/js/review.js).
const ReviewPage = (() => {
  const view = $("dashView");
  const enc = encodeURIComponent;
  const SAVE_DELAY = 700;

  let data = null;      // /api/review response
  let edits = {};       // the reviewer's changes, saved as they type
  let rows = [];        // one line per scheme: uploaded figures
  let saveTimer = null, saving = null, dirty = false, active = false;

  const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const same = (a, b) => (isNum(a) && isNum(b) ? Math.abs(Number(a) - Number(b)) < 0.005 : String(a ?? "") === String(b ?? ""));
  const roundTo = (v, d = 2) => (isNum(v) ? Math.round(Number(v) * 10 ** d) / 10 ** d : "");
  const sum = (list, f) => list.reduce((a, r) => a + (r[f] || 0), 0);

  // ---- Saving -----------------------------------------------------------------------------
  function setStatus(text, cls = "") {
    const el = $("rvStatus");
    if (el) { el.textContent = text; el.className = `rv-status ${cls}`; }
  }

  function scheduleSave() {
    dirty = true;
    setStatus("Unsaved changes…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!dirty) return saving;
    dirty = false;
    const client = data.clientName;
    setStatus("Saving…");
    saving = api("PUT", `/review/edits?client=${enc(client)}`, { edits: clean(edits) })
      .then((r) => { if (data?.clientName === client && !dirty) setStatus(`All changes saved · ${time(r.savedAt)}`, "ok"); })
      .catch((e) => { dirty = true; setStatus(`Not saved: ${e.message}`, "err"); throw e; });
    return saving;
  }

  const time = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  // Drop empty values so the saved document only holds real changes.
  function clean(o) {
    if (Array.isArray(o) || o === null || typeof o !== "object") return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const c = clean(v);
      if (c === undefined || c === null || c === "" || c === false) continue;
      if (typeof c === "object" && !Object.keys(c).length) continue;
      out[k] = c;
    }
    return out;
  }

  // Read / write a value at a dotted path inside edits ("personal.mobile", "savings.epf.value").
  const getPath = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), edits);
  function setPath(path, value) {
    const keys = path.split(".");
    let o = edits;
    for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
    const last = keys[keys.length - 1];
    if (value === undefined || value === "" || value === false) delete o[last]; else o[last] = value;
  }
  const schemeEdit = (key) => ((edits.schemes ||= {})[key] ||= {});

  // ---- Scheme lines -------------------------------------------------------------------------
  // The latest uploaded holdings and live SIPs, one line per scheme on each platform.
  function schemeRows(prep) {
    const map = new Map();
    const line = (r) => {
      const k = Review.rowKey(r);
      if (!map.has(k)) {
        map.set(k, { key: k, platform: r.platform, product: r.product, name: r.security_name || "–", isin: r.isin, category: r.category,
          holdings: [], sips: [] });
      }
      return map.get(k);
    };
    for (const h of prep.raw.holdings) line(h).holdings.push(h);
    for (const s of prep.raw.sips.filter((x) => x.live)) line(s).sips.push(s);
    const order = ["MF", "Stocks", "PMS", "AIF", "Bonds", "Other", "LAS"];
    return [...map.values()].map((r) => {
      const h = r.holdings;
      const inv = sum(h, "invested"), val = sum(h, "current_value");
      return {
        ...r,
        base: {
          type: r.product === "MF" ? Review.typeOfRow(h[0] || r.sips[0]) : "",
          subType: Review.subType(r.name, r.category),
          quantity: h.length ? roundTo(sum(h, "quantity"), 3) : "",
          invested: h.length ? roundTo(inv) : "",
          current_value: h.length ? roundTo(val) : "",
          xirr: h.length === 1 && isNum(h[0].xirr) ? roundTo(h[0].xirr) : "",
          sip: r.sips.length ? roundTo(sum(r.sips, "monthly_amount")) : "",
        },
      };
    }).sort((a, b) => order.indexOf(a.product) - order.indexOf(b.product) || a.platform.localeCompare(b.platform)
      || (a.base.type || "").localeCompare(b.base.type || "") || b.base.current_value - a.base.current_value);
  }

  // ---- Rendering ------------------------------------------------------------------------------
  async function show(name) {
    active = false;
    await flush();
    view.innerHTML = '<div class="loading">Loading…</div>';
    try {
      data = await api("GET", `/review?client=${enc(name)}`);
    } catch (e) {
      data = null;
      view.innerHTML = `<nav class="crumbs"><a href="#/dashboard">Dashboard</a></nav>
        <div class="card empty-state"><h2>Couldn't load the review report</h2><p>${esc(e.message)}</p></div>`;
      return;
    }
    edits = data.edits && typeof data.edits === "object" ? structuredClone(data.edits) : {};
    dirty = false;
    rows = schemeRows(Review.prepare(data, {}));
    active = true;
    render();
  }

  function render() {
    const c = data.clientName;
    view.innerHTML = `<nav class="crumbs"><a href="#/dashboard">Dashboard</a><span class="sep">›</span>
        <a href="#/client/${enc(c)}">${esc(c)}</a><span class="sep">›</span><span>Review Report</span></nav>
      <div class="page-head"><div><h1>Review Report · ${esc(c)}</h1>
        <div class="sub">Change any figure below for this review. The uploaded data stays as it is; your changes are saved for this client and go into the exported Excel.</div></div>
        <div class="actions">
          <span id="rvStatus" class="rv-status ${data.editsSavedAt ? "ok" : ""}">${data.editsSavedAt ? `Changes saved · ${fmt.date(data.editsSavedAt.slice(0, 10))}` : "No changes yet"}</span>
          <button type="button" class="outline" id="rvReset">Reset changes</button>
          <button type="button" class="success" id="rvExport">Export Excel</button>
        </div></div>
      <div id="rvKpis"></div>
      <div class="card">
        <h3 class="section-title">Review details</h3>
        <div class="rv-grid">
          ${field("Review date", "reviewDate", { type: "date", placeholder: data.today, value: edits.reviewDate || data.today })}
          ${field("Mobile", "personal.mobile")}
          ${field("E-mail", "personal.email", { type: "email" })}
          ${field("Occupation", "personal.occupation")}
          ${field("Date of birth", "personal.dob", { type: "date" })}
          ${field("City", "personal.city")}
          ${field("Country", "personal.country")}
          ${field("Relationship manager", "personal.rm")}
          ${field("Years with us", "personal.years", { type: "number", min: 0 })}
          <label>Freedom level<select data-path="personal.level"><option value="">–</option>
            ${Review.LEVELS.map((l) => `<option ${edits.personal?.level === l ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        </div>
      </div>
      <div class="card">
        <div class="toolbar"><h3 class="section-title" style="margin:0">Investments</h3>
          <span class="muted small">Edited cells are highlighted. Clear a cell to go back to the uploaded figure. Untick a scheme to leave it out of the report.</span></div>
        <div class="table-wrap"><table class="rv-table" id="rvSchemes">${schemeTable()}</table></div>
      </div>
      <div class="two-col rv-two">
        <div class="card"><h3 class="section-title">Other savings</h3>
          <table class="rv-table"><thead><tr><th>Saving</th><th class="num">Current value (₹)</th><th class="num">Monthly (₹)</th></tr></thead><tbody>
          ${Review.SAVINGS.map(([k, label, , mr]) => `<tr><td>${k === "other"
            ? `<input class="rv-label" data-path="otherLabel" value="${esc(edits.otherLabel || "")}" placeholder="${esc(label)}">` : esc(label)}</td>
            <td class="num">${numInput(`savings.${k}.value`)}</td><td class="num">${mr ? numInput(`savings.${k}.monthly`) : ""}</td></tr>`).join("")}
          </tbody></table></div>
        <div>
          <div class="card"><h3 class="section-title">Passive income (monthly)</h3>
            <table class="rv-table"><tbody>
            ${Review.PASSIVE.map(([k, label]) => `<tr><td>${esc(label)}</td><td class="num">${numInput(`passive.${k}`)}</td></tr>`).join("")}
            </tbody></table></div>
          <div class="card"><h3 class="section-title">Redemptions this year</h3>
            <table class="rv-table"><thead><tr><th></th><th class="num">Amount (₹)</th><th>Reason</th></tr></thead><tbody>
            ${Review.REDEMPTION.map(([k, label]) => `<tr><td>${esc(label)}</td><td class="num">${numInput(`redemption.${k}.value`)}</td>
              <td><input data-path="redemption.${k}.reason" value="${esc(getPath(`redemption.${k}.reason`) || "")}"></td></tr>`).join("")}
            </tbody></table></div>
        </div>
      </div>
      <div class="card"><h3 class="section-title">Discussion notes</h3>
        <p class="muted small" style="margin:-6px 0 8px">One point per line. They go into the Discussion sheet.</p>
        <textarea data-path="notes" rows="7" class="rv-notes" placeholder="e.g. Increase the NJ equity SIP by ₹5,000 from next month">${esc(edits.notes || "")}</textarea>
      </div>`;
    kpis();
    $("rvExport").addEventListener("click", exportNow);
    $("rvReset").addEventListener("click", reset);
  }

  function field(label, path, { type = "text", placeholder = "", value, ...attrs } = {}) {
    const v = value ?? getPath(path) ?? "";
    const extra = Object.entries(attrs).map(([k, x]) => `${k}="${esc(x)}"`).join(" ");
    return `<label>${esc(label)}<input type="${type}" data-path="${path}" value="${esc(v)}" placeholder="${esc(placeholder)}" ${extra}></label>`;
  }
  const numInput = (path) => `<input type="number" step="any" class="rv-num" data-path="${path}" value="${esc(getPath(path) ?? "")}">`;

  function schemeTable() {
    let html = `<thead><tr><th title="Include in the report">In</th><th>Scheme</th><th>Fund type</th><th>Sub type</th>
      <th class="num">Units</th><th class="num">Invested (₹)</th><th class="num">Current value (₹)</th><th class="num">XIRR %</th>
      <th class="num">Monthly SIP (₹)</th><th>SIP tenure</th><th class="num">New SIP (₹)</th><th>Remarks</th><th>Suggestions</th></tr></thead><tbody>`;
    let group = "";
    for (const r of rows) {
      const g = `${r.product} · ${r.platform}`;
      if (g !== group) {
        group = g;
        html += `<tr class="grp"><td colspan="13">${esc(r.product === "LAS" ? `${g} (loan, not counted in the total)` : g)}</td></tr>`;
      }
      const e = edits.schemes?.[r.key] || {};
      const hasHolding = r.holdings.length > 0;
      const cell = (f, { digits = 2, disabled = false } = {}) => {
        const v = e[f] !== undefined ? e[f] : r.base[f];
        return `<td class="num"><input type="number" step="any" class="rv-num ${e[f] !== undefined ? "edited" : ""}" data-key="${esc(r.key)}"
          data-field="${f}" value="${esc(v === "" ? "" : roundTo(v, digits))}" placeholder="–" ${disabled ? "disabled" : ""}></td>`;
      };
      const text = (f, cls = "") => `<td><input class="${cls} ${e[f] ? "edited" : ""}" data-key="${esc(r.key)}" data-field="${f}" value="${esc(e[f] || "")}"></td>`;
      const type = e.type || r.base.type;
      html += `<tr class="${e.excluded ? "excluded" : ""}" data-row="${esc(r.key)}">
        <td><input type="checkbox" data-key="${esc(r.key)}" data-field="included" ${e.excluded ? "" : "checked"} aria-label="Include ${esc(r.name)}"></td>
        <td class="scheme">${esc(r.name)}${r.isin ? `<span class="note">${esc(r.isin)}</span>` : ""}${hasHolding ? "" : '<span class="note">SIP only</span>'}</td>
        <td>${r.product === "MF" ? `<select data-key="${esc(r.key)}" data-field="type" class="${e.type ? "edited" : ""}">
          ${Review.MF_TYPES.map((t) => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select>` : '<span class="muted">–</span>'}</td>
        <td><input class="rv-sub ${e.subType ? "edited" : ""}" data-key="${esc(r.key)}" data-field="subType" value="${esc(e.subType || "")}" placeholder="${esc(r.base.subType || "–")}"></td>
        ${cell("quantity", { digits: 3, disabled: !hasHolding })}${cell("invested", { disabled: !hasHolding })}
        ${cell("current_value", { disabled: !hasHolding })}${cell("xirr", { disabled: !hasHolding })}
        ${cell("sip")}${text("tenure", "rv-short")}
        <td class="num"><input type="number" step="any" class="rv-num ${isNum(e.newSip) ? "edited" : ""}" data-key="${esc(r.key)}" data-field="newSip" value="${esc(e.newSip ?? "")}"></td>
        ${text("remarks")}${text("suggestions")}</tr>`;
    }
    return `${html}</tbody>`;
  }

  // Totals with the changes applied, against the uploaded ones.
  function kpis() {
    const now = Review.prepare(data, edits).current;
    const was = Review.prepare(data, {}).current;
    const gain = now.value - now.invested;
    const diff = (a, b) => (same(a, b) ? "" : `<span class="note">Uploaded: ${fmt.money(b)}</span>`);
    $("rvKpis").innerHTML = `<div class="kpis">
      <div class="kpi"><div class="l">Current value</div><div class="v">${fmt.money(now.value)}</div>${diff(now.value, was.value)}</div>
      <div class="kpi" style="--c:#6b7a99"><div class="l">Invested</div><div class="v">${fmt.money(now.invested)}</div>${diff(now.invested, was.invested)}</div>
      <div class="kpi" style="--c:${gain >= 0 ? "#1e8e5a" : "#c0392b"}"><div class="l">Gain</div><div class="v ${fmt.signCls(gain)}">${fmt.money(gain)}</div>
        <div class="s">${fmt.pct(now.invested ? (gain / now.invested) * 100 : null)}</div></div>
      <div class="kpi" style="--c:#d4880f"><div class="l">Monthly SIP</div><div class="v">${fmt.money(now.sip)}</div>${diff(now.sip, was.sip)}</div>
    </div>`;
  }

  // ---- Changes ----------------------------------------------------------------------------------
  function onInput(e) {
    const el = e.target;
    if (!active || !data || !(el.dataset.path || el.dataset.key)) return;
    if (e.type === "input" && (el.tagName === "SELECT" || el.type === "checkbox")) return; // handled on change
    if (el.dataset.path) {
      let v = el.type === "number" ? (isNum(el.value) ? Number(el.value) : undefined) : el.value;
      if (el.dataset.path === "reviewDate" && (v === data.today || !v)) v = undefined;
      setPath(el.dataset.path, v);
    } else {
      const r = rows.find((x) => x.key === el.dataset.key);
      const f = el.dataset.field;
      const s = schemeEdit(r.key);
      if (f === "included") {
        if (el.checked) delete s.excluded; else s.excluded = true;
        el.closest("tr").classList.toggle("excluded", !el.checked);
      } else if (f in r.base && f !== "subType") {
        // Same as uploaded (or cleared): no change.
        const raw = f === "type" ? el.value : (isNum(el.value) ? Number(el.value) : undefined);
        if (raw === undefined || same(raw, r.base[f])) delete s[f]; else s[f] = raw;
        if (raw === undefined && el.type === "number" && e.type === "change") el.value = r.base[f] === "" ? "" : r.base[f];
        el.classList.toggle("edited", s[f] !== undefined);
      } else {
        const v = el.type === "number" ? (isNum(el.value) ? Number(el.value) : undefined) : el.value.trim() || undefined;
        if (v === undefined) delete s[f]; else s[f] = v;
        el.classList.toggle("edited", v !== undefined);
      }
      if (!Object.keys(s).length) delete edits.schemes[r.key];
    }
    kpis();
    scheduleSave();
  }

  async function flush() {
    if (!data) return;
    try { if (dirty) await save(); else await saving; } catch {}
  }

  async function exportNow() {
    const b = $("rvExport");
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
    if (!confirm(`Remove every change made for ${data.clientName}'s review? The report goes back to the uploaded figures.`)) return;
    clearTimeout(saveTimer);
    dirty = false;
    try {
      await api("DELETE", `/review/edits?client=${enc(data.clientName)}`);
    } catch (e) { return alert(`Could not reset: ${e.message}`); }
    edits = {};
    data.editsSavedAt = null;
    render();
    setStatus("Changes removed", "ok");
  }

  // Leaving the page (another route) saves what is pending.
  function leave() {
    if (!active) return;
    active = false;
    flush();
  }
  view.addEventListener("input", onInput);
  view.addEventListener("change", onInput);
  window.addEventListener("beforeunload", (e) => { if (dirty) { save().catch(() => {}); e.preventDefault(); } });

  return { show, leave };
})();
