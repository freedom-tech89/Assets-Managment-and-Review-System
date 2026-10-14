// Dashboards: home (categories + platforms) -> one platform or category -> one client.
const Dashboard = (() => {
  const view = $("dashView");
  const COLORS = ["#1f3864", "#0f766e", "#e8590c", "#7c3aed", "#b45309", "#0369a1", "#be123c", "#4d7c0f", "#6b7385"];

  const enc = encodeURIComponent;
  const loading = () => { view.innerHTML = `<div class="loading">Loading…</div>`; };

  function crumbs(parts) {
    return `<nav class="crumbs">${parts.map(([label, href], i) =>
      `${i ? '<span class="sep">›</span>' : ""}${href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`}`).join("")}</nav>`;
  }

  const gainText = (gain, ret) =>
    `<span class="${fmt.signCls(gain)}">${fmt.money(gain)}${ret === null || ret === undefined ? "" : ` (${fmt.pct(ret)})`}</span>`;

  function kpis(t, extra = []) {
    const cards = [
      ["Total Invested", fmt.money(t.invested), "", "#e8590c"],
      ["Current Value", fmt.money(t.current_value), "", "#0f766e"],
      ["Gain / Loss", `<span class="${fmt.signCls(t.gain_loss)}">${fmt.money(t.gain_loss)}</span>`,
        `<span class="s ${fmt.signCls(t.return_pct)}">${fmt.pct(t.return_pct)} absolute return</span>`, "#15803d"],
      ["XIRR", fmt.pct(t.xirr), `<span class="s muted">${t.xirr === null ? "not in the uploaded files" : "value-weighted, where reported"}</span>`, "#7c3aed"],
      ...extra,
    ];
    return `<div class="kpis">${cards.map(([l, v, s, c]) =>
      `<div class="kpi" style="--c:${c}"><div class="v">${v}</div><div class="l">${l}</div>${s || ""}</div>`).join("")}</div>`;
  }

  function allocation(assets, total) {
    if (!assets.length) return "";
    return `<div class="card"><h3 class="section-title">Asset Allocation</h3><div class="alloc">${assets.map((a, i) => {
      const share = total ? (a.current_value / total) * 100 : 0;
      return `<div class="row" style="--c:${COLORS[i % COLORS.length]}"><span>${esc(a.name)}</span>
        <span class="muted">${fmt.money(a.current_value)} · ${share.toFixed(1)}%</span>
        <div class="bar"><span style="width:${Math.max(share, 0.5).toFixed(2)}%"></span></div></div>`;
    }).join("")}</div></div>`;
  }

  // Sortable, searchable table. columns: {label, value(row), html(row)?, num?, search?}
  function dataTable(host, { columns, rows, onClick, searchPlaceholder, footer, initialSort, wide }) {
    let sortIdx = initialSort ?? -1, dir = -1, term = "";
    host.innerHTML = `
      ${searchPlaceholder ? `<div class="toolbar"><input type="search" placeholder="${esc(searchPlaceholder)}" aria-label="Search">
        <span class="muted count"></span></div>` : ""}
      <div class="table-wrap"><table class="data${wide ? " wide" : ""}"><thead><tr>${columns.map((c, i) =>
        `<th class="sort${c.num ? " num" : ""}${c.cls ? ` ${c.cls}` : ""}" data-i="${i}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody></tbody>${footer ? `<tfoot><tr>${footer.map((f, i) => `<td class="${columns[i].num ? "num" : ""}">${f ?? ""}</td>`).join("")}</tr></tfoot>` : ""}
      </table></div>`;
    const tbody = host.querySelector("tbody"), count = host.querySelector(".count");
    function draw() {
      let list = rows;
      if (term) list = list.filter((r) => columns.some((c) => c.search && String(c.value(r) ?? "").toLowerCase().includes(term)));
      if (sortIdx >= 0) {
        const c = columns[sortIdx];
        list = [...list].sort((a, b) => {
          const x = c.value(a), y = c.value(b);
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
        });
      }
      tbody.innerHTML = list.length ? list.map((r, i) => `<tr${onClick ? ` class="click" tabindex="0" data-i="${rows.indexOf(r)}"` : ""}>${columns.map((c) =>
        `<td class="${c.num ? "num" : ""}${c.cls ? ` ${c.cls}` : ""}">${c.html ? c.html(r, i) : esc(c.value(r) ?? "–")}</td>`).join("")}</tr>`).join("")
        : `<tr class="empty"><td colspan="${columns.length}">Nothing matches your search.</td></tr>`;
      if (count) count.textContent = `${list.length} of ${rows.length}`;
      host.querySelectorAll("th").forEach((th, i) => {
        th.classList.toggle("asc", i === sortIdx && dir === 1);
        th.classList.toggle("desc", i === sortIdx && dir === -1);
      });
    }
    host.querySelector("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      const i = Number(th.dataset.i);
      dir = sortIdx === i ? -dir : columns[i].num ? -1 : 1;
      sortIdx = i;
      draw();
    });
    const search = host.querySelector("input[type=search]");
    if (search) search.addEventListener("input", () => { term = search.value.trim().toLowerCase(); draw(); });
    if (onClick) {
      const go = (e) => {
        if (e.target.closest("[data-sips], [data-filter-sips]")) return; // the SIP button in a row opens the SIP list instead
        const tr = e.target.closest("tr[data-i]");
        if (tr) onClick(rows[Number(tr.dataset.i)]);
      };
      tbody.addEventListener("click", go);
      tbody.addEventListener("keydown", (e) => { if (e.key === "Enter") go(e); });
    }
    draw();
  }

  function errorView(e, back) {
    view.innerHTML = `${back ? crumbs([["Dashboard", "#/dashboard"]]) : ""}<div class="card empty-state"><h2>Couldn't load this page</h2><p>${esc(e.message)}</p></div>`;
  }

  const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
  const platLink = (name, prod) => `#/platform/${enc(name)}${prod ? `/${enc(prod)}` : ""}`;
  const catLink = (prod) => `#/category/${enc(prod)}`;
  const chips = (list) => (list || []).map((p) => `<span class="chip">${esc(p)}</span>`).join("");
  const KIND = { aum: "AUM", sip: "SIP" };
  const CAT_COLORS = { MF: "#1f3864", Stocks: "#0f766e", PMS: "#7c3aed", AIF: "#b45309", Bonds: "#0369a1", LAS: "#be123c", Other: "#6b7385" };

  // KPI cards with SIP and loan cards added when there is data for them.
  function allKpis(t, extra = []) {
    const more = [];
    if (t.sips) more.push(["Monthly SIP", fmt.money(t.sip_monthly), `<span class="s muted">${plural(t.live_sips, "live SIP")} of ${t.sips} · view ›</span>`, "#0369a1"]);
    if (t.loan_rows) more.push(["Loans (LAS)", fmt.money(t.loans), `<span class="s muted">not added to AUM</span>`, "#be123c"]);
    return kpis({ ...t }, [...more, ...extra]).replace("Current Value</div>", "Current Value (AUM)</div>");
  }

  // Make the "Monthly SIP" KPI card open the SIP list (or scroll to the SIP table on a client page).
  function linkSipKpi(params) {
    const card = [...view.querySelectorAll(".kpi")].find((k) => k.querySelector(".l")?.textContent === "Monthly SIP");
    if (!card) return;
    card.classList.add("link");
    card.tabIndex = 0;
    card.title = "Show SIP details";
    const go = () => {
      const table = $("sipTable");
      if (table) table.scrollIntoView({ behavior: "smooth", block: "start" });
      else location.hash = `#/sips${params ? `?${params}` : ""}`;
    };
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  // ---- SIP list and SIP detail ----------------------------------------------------------
  async function sips(query = "") {
    loading();
    const params = new URLSearchParams(query);
    const showAll = params.get("live") === "0";
    let rows;
    try { rows = await api("GET", `/sips?${params}`); } catch (e) { return errorView(e, true); }
    const scopeLabel = params.get("client") || params.get("platform") || params.get("product") || "";
    const live = rows.filter((r) => r.live);
    const monthly = live.reduce((t, r) => t + (r.monthly_amount || 0), 0);
    const toggle = new URLSearchParams(params);
    showAll ? toggle.delete("live") : toggle.set("live", "0");
    view.innerHTML = `${crumbs([["Dashboard", "#/dashboard"], [`SIPs${scopeLabel ? ` · ${scopeLabel}` : ""}`]])}
      <div class="page-head"><div><h1>${showAll ? "All SIPs" : "Live SIPs"}${scopeLabel ? ` · ${esc(scopeLabel)}` : ""}</h1>
        <div class="sub">${plural(live.length, "live SIP")} · ${fmt.money(monthly)} a month · ${plural(new Set(rows.map((r) => r.client_name)).size, "client")}</div></div>
        <a class="outline" style="text-decoration:none;padding:9px 16px;border-radius:7px;border:1px solid var(--line);background:#fff" href="#/sips?${toggle}">${showAll ? "Show live SIPs only" : "Show ended SIPs too"}</a></div>
      <div class="card"><p class="muted small" style="margin:-4px 0 10px">Click a SIP to see its full details.</p><div id="sipList"></div></div>`;
    dataTable($("sipList"), {
      rows, searchPlaceholder: "Search client, scheme, folio or platform", initialSort: 6, wide: false,
      onClick: (r) => sipDetail(r.id),
      columns: [
        { label: "Client", value: (r) => r.client_name, search: true, html: (r) => `<b>${esc(r.client_name)}</b>` },
        { label: "Category", value: (r) => r.product, search: true },
        { label: "Platform", value: (r) => r.platform, search: true, cls: "nw" },
        { label: "Scheme", value: (r) => r.security_name, search: true, cls: "scheme",
          html: (r) => `${esc(r.security_name || "–")}${r.identifier ? `<span class="note">${esc(r.identifier)}</span>` : ""}` },
        { label: "SIP Amount", value: (r) => r.sip_amount, num: true, html: (r) => fmt.money(r.sip_amount) },
        { label: "Frequency", value: (r) => r.frequency },
        { label: "Monthly", value: (r) => r.monthly_amount, num: true, html: (r) => fmt.money(r.monthly_amount) },
        { label: "SIP Day", value: (r) => r.sip_day, num: true },
        { label: "Start", value: (r) => r.start_date, cls: "nw", html: (r) => fmt.date(r.start_date) },
        { label: "Status", value: (r) => (r.live ? 1 : 0), html: (r) => `<span class="badge ${r.live ? "ok" : "muted"}">${esc(r.status || (r.live ? "Active" : "Ended"))}</span>` },
      ],
    });
  }

  let sipModal;
  function modalShell() {
    if (sipModal) return sipModal;
    sipModal = document.createElement("div");
    sipModal.className = "modal";
    sipModal.hidden = true;
    sipModal.setAttribute("role", "dialog");
    sipModal.setAttribute("aria-modal", "true");
    sipModal.innerHTML = `<div class="modal-card sip-card"><button class="close" type="button" aria-label="Close">×</button><div class="body"></div></div>`;
    document.body.appendChild(sipModal);
    const close = () => { sipModal.hidden = true; };
    sipModal.querySelector(".close").addEventListener("click", close);
    sipModal.addEventListener("click", (e) => { if (e.target === sipModal) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sipModal.hidden) close(); });
    window.addEventListener("hashchange", close);
    return sipModal;
  }

  let listFilter = null; // the SIP list the detail was opened from, for "Back to list"

  async function sipListModal(query) {
    const m = modalShell(), body = m.querySelector(".body");
    listFilter = query;
    body.innerHTML = `<div class="loading">Loading SIPs…</div>`;
    m.hidden = false;
    const params = new URLSearchParams(query);
    params.set("live", "0");
    let rows;
    try { rows = await api("GET", `/sips?${params}`); } catch (e) { body.innerHTML = `<h2>Couldn't load the SIPs</h2><p class="muted">${esc(e.message)}</p>`; return; }
    rows.sort((a, b) => Number(b.live) - Number(a.live) || (b.monthly_amount || 0) - (a.monthly_amount || 0));
    const live = rows.filter((r) => r.live);
    const who = params.get("client");
    const where = [params.get("product"), params.get("platform")].filter(Boolean).join(" · ");
    body.innerHTML = `
      <h2>${who ? `SIPs of ${esc(who)}` : "SIPs"}</h2>
      <div class="meta">${where ? `<span class="chip">${esc(where)}</span>` : ""}
        <span class="muted small">${plural(live.length, "live SIP")} · ${fmt.money(live.reduce((t, r) => t + (r.monthly_amount || 0), 0))} a month${rows.length > live.length ? ` · ${rows.length - live.length} ended` : ""}</span></div>
      <p class="muted small" style="margin:0 0 10px">Click a SIP to see its full details.</p>
      <div class="table-wrap"><table class="uploads data"><thead><tr>${who ? "" : "<th>Client</th>"}<th>Scheme</th><th>Platform</th><th class="num">SIP Amount</th>
        <th>Frequency</th><th class="num">Monthly</th><th class="num">SIP Day</th><th>Start</th><th>Status</th></tr></thead><tbody>${rows.map((r) => `
        <tr class="click" tabindex="0" data-sip="${r.id}">${who ? "" : `<td><b>${esc(r.client_name)}</b></td>`}
          <td>${esc(r.security_name || "–")}${r.identifier ? `<span class="note">${esc(r.identifier)}</span>` : ""}</td>
          <td class="nw">${esc(r.platform)}<span class="note">${esc(r.product)}</span></td><td class="num">${fmt.money(r.sip_amount)}</td>
          <td>${esc(r.frequency || "")}</td><td class="num">${fmt.money(r.monthly_amount)}</td><td class="num">${r.sip_day ?? "–"}</td>
          <td class="nw">${fmt.date(r.start_date)}</td>
          <td><span class="badge ${r.live ? "ok" : "muted"}">${esc(r.status || (r.live ? "Active" : "Ended"))}</span></td></tr>`).join("")
        || `<tr class="empty"><td colspan="9">No SIPs found.</td></tr>`}</tbody></table></div>`;
    body.querySelectorAll("tr[data-sip]").forEach((tr) => {
      const open = () => sipDetail(Number(tr.dataset.sip), true);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    });
    m.querySelector(".modal-card").scrollTop = 0;
    m.querySelector(".close").focus();
  }

  // Any "n live SIPs" button on a dashboard opens the list of those SIPs.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sips]");
    if (!b) return;
    e.preventDefault();
    sipListModal(b.dataset.sips);
  });

  async function sipDetail(id, fromList = false) {
    if (!fromList) listFilter = null;
    const m = modalShell(), body = m.querySelector(".body");
    body.innerHTML = `<div class="loading">Loading SIP…</div>`;
    m.hidden = false;
    let d;
    try { d = await api("GET", `/sips/${id}`); } catch (e) { body.innerHTML = `<h2>Couldn't load this SIP</h2><p class="muted">${esc(e.message)}</p>`; return; }
    const s = d.sip, sc = d.schedule;
    const dash = (v) => (v === null || v === undefined || v === "" ? "–" : esc(v));
    const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    body.innerHTML = `
      ${listFilter !== null ? `<button type="button" class="back-link" data-back>‹ Back to the SIP list</button>` : ""}
      <h2 id="sipTitle">${esc(s.security_name || "SIP")}</h2>
      <div class="meta"><span class="badge ${s.live ? "ok" : "muted"}">${esc(s.status || (s.live ? "Active" : "Ended"))}</span>
        <span class="chip">${esc(s.product)}</span><span class="chip">${esc(s.platform)}</span>
        <span class="muted small">for <a href="#/client/${enc(s.client_name)}">${esc(s.client_name)}</a></span></div>
      <div class="mini-kpis">
        <div><b>${fmt.money(s.sip_amount)}</b><span>${esc(s.frequency || "Monthly")} SIP</span></div>
        <div><b>${fmt.money(s.monthly_amount)}</b><span>monthly equivalent</span></div>
        <div><b>${s.sip_day ? `${s.sip_day}${ordinal(s.sip_day)}` : "–"}</b><span>SIP day</span></div>
        <div><b>${sc ? `${sc.paid}${sc.total !== null ? ` of ${sc.total}` : ""}` : "–"}</b><span>installments so far</span></div>
        <div><b>${sc && sc.next_due ? fmt.date(sc.next_due) : "–"}</b><span>next installment</span></div>
        <div><b>${sc && sc.invested_estimate !== null ? fmt.money(sc.invested_estimate) : "–"}</b><span>invested through SIP</span></div>
      </div>
      ${sc ? `<p class="est">Installments, next date and amount invested are worked out from the start date, end date and frequency.</p>` : ""}
      <dl class="facts">
        ${fact("Client", `<a href="#/client/${enc(s.client_name)}">${esc(s.client_name)}</a>`)}
        ${fact("Client ID / PAN", dash(s.client_id))}
        ${fact("Folio / SIP No", dash(s.identifier))}
        ${fact("ISIN", dash(s.isin))}
        ${fact("Asset class", dash(s.asset_class))}
        ${fact("Start date", fmt.date(s.start_date))}
        ${fact("End date", s.end_date ? fmt.date(s.end_date) : "Until cancelled")}
        ${fact("Installments left", sc && sc.remaining !== null ? String(sc.remaining) : "–")}
        ${fact("Source file", `<a href="/api/uploads/${s.upload_id}/file">${esc(s.source_file)}</a>`)}
        ${fact("Version", `v${s.version} · data as of ${fmt.date(s.snapshot_date)}${s.current ? "" : " (older version)"}`)}
        ${fact("Uploaded", `${esc(s.uploaded_at)} · ${s.upload_type === "platform" ? "Platform Wise" : "Client Wise"}`)}
      </dl>
      <h3 class="section-title">Current holding in this scheme</h3>
      ${d.holdings.length ? `<div class="table-wrap"><table class="uploads"><thead><tr><th>Platform</th><th class="num">Units</th><th class="num">Invested</th>
        <th class="num">Current Value</th><th class="num">Gain</th><th class="num">XIRR</th><th>As at</th></tr></thead><tbody>${d.holdings.map((h) => `
        <tr><td>${esc(h.platform)} <span class="chip">${esc(h.product)}</span></td><td class="num">${fmt.qty(h.quantity)}</td>
        <td class="num">${fmt.money(h.invested)}</td><td class="num">${fmt.money(h.current_value)}</td>
        <td class="num">${gainText(h.gain_loss, h.return_pct)}</td><td class="num">${fmt.pct(h.xirr)}</td><td class="nw">${fmt.date(h.as_of)}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted small">No holding of this scheme was found in the uploaded AUM files.</p>`}
      <h3 class="section-title">Change history</h3>
      <div class="table-wrap"><table class="uploads"><thead><tr><th>Version</th><th>Data as of</th><th class="num">SIP Amount</th><th>Frequency</th>
        <th>Status</th><th>File</th><th></th></tr></thead><tbody>${d.history.map((h) => `
        <tr><td>v${h.version}</td><td class="nw">${fmt.date(h.snapshot_date)}</td><td class="num">${fmt.money(h.sip_amount)}</td><td>${esc(h.frequency)}</td>
        <td><span class="badge ${h.live ? "ok" : "muted"}">${esc(h.status || "")}</span></td><td class="small">${esc(h.original_name)}</td>
        <td>${h.current ? `<span class="badge ok">In use</span>` : `<span class="badge muted">Older</span>`}</td></tr>`).join("")}</tbody></table></div>
      ${d.others.length ? `<h3 class="section-title">Other SIPs of ${esc(s.client_name)}</h3>
        <div class="table-wrap"><table class="uploads data"><tbody>${d.others.map((o) => `
        <tr class="click" tabindex="0" data-sip="${o.id}"><td>${esc(o.security_name || "–")}<span class="note">${esc(o.platform)} · ${esc(o.product)}</span></td>
        <td class="num">${fmt.money(o.sip_amount)} <span class="muted small">${esc(o.frequency)}</span></td>
        <td><span class="badge ${o.live ? "ok" : "muted"}">${esc(o.status || "")}</span></td></tr>`).join("")}</tbody></table></div>` : ""}`;
    const back = body.querySelector("[data-back]");
    if (back) back.addEventListener("click", () => sipListModal(listFilter));
    body.querySelectorAll("tr[data-sip]").forEach((tr) => {
      const open = () => sipDetail(Number(tr.dataset.sip), listFilter !== null);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    });
    m.querySelector(".modal-card").scrollTop = 0;
    m.querySelector(".close").focus();
  }

  const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

  function historyTable(host, rows, { client } = {}) {
    dataTable(host, {
      rows, initialSort: 0, searchPlaceholder: "Search file, platform or category",
      columns: [
        { label: "Uploaded", value: (r) => r.uploadedAt || r.uploaded_at, cls: "nw" },
        { label: "Type", value: (r) => ((r.uploadType || r.upload_type) === "platform" ? "Platform Wise" : "Client Wise") },
        { label: "Category", value: (r) => r.product, search: true },
        { label: "Platform", value: (r) => r.platform, search: true },
        { label: "File", value: (r) => r.originalName || r.original_name, search: true,
          html: (r) => `<span class="chip" style="margin:0 6px 0 0">${KIND[r.kind]}</span><a href="/api/uploads/${r.id}/file">${esc(r.originalName || r.original_name)}</a>` },
        { label: "Version", value: (r) => r.version, num: true, html: (r) => `v${r.version}` },
        { label: "Data as of", value: (r) => r.snapshotDate || r.snapshot_date, cls: "nw", html: (r) => fmt.date(r.snapshotDate || r.snapshot_date) },
        ...(client ? [
          { label: "Value / SIP", value: (r) => r.value ?? r.monthly, num: true,
            html: (r) => (r.kind === "sip" ? `${fmt.money(r.monthly)}<span class="note">monthly</span>` : fmt.money(r.value)) },
        ] : [{ label: "Rows", value: (r) => r.rowsCount, num: true }]),
        { label: "Status", value: (r) => (r.current ? 1 : 0), html: (r) => (r.current ? `<span class="badge ok">In use</span>` : `<span class="badge muted">Older version</span>`) },
      ],
    });
  }

  // Monthly SIP cell that opens the list of those SIPs. filter: {client, platform, product}.
  function sipCell(r, filter) {
    if (!r.sips) return "–";
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    return `<button type="button" class="sip-link" data-sips="${esc(q.toString())}" title="Show these SIPs">${fmt.money(r.sip_monthly)}
      <span class="note">${plural(r.live_sips, "live SIP")} ›</span></button>`;
  }

  function clientColumns(scope = {}) {
    return [
      { label: "Client", value: (r) => r.client_name, search: true, html: (r) => `<a href="#/client/${enc(r.client_name)}">${esc(r.client_name)}</a>${chips(r.products)}` },
      { label: "Client ID / PAN", value: (r) => r.client_id, search: true },
      { label: "Holdings", value: (r) => r.holdings, num: true },
      { label: "Invested", value: (r) => r.invested, num: true, html: (r) => fmt.money(r.invested) },
      { label: "Current Value", value: (r) => r.current_value, num: true, html: (r) => fmt.money(r.current_value) },
      { label: "Gain / Loss", value: (r) => r.gain_loss, num: true, html: (r) => gainText(r.gain_loss) },
      { label: "Abs Ret %", value: (r) => r.return_pct, num: true, html: (r) => `<span class="${fmt.signCls(r.return_pct)}">${fmt.pct(r.return_pct)}</span>` },
      { label: "XIRR %", value: (r) => r.xirr, num: true, html: (r) => fmt.pct(r.xirr) },
      { label: "Monthly SIP", value: (r) => r.sip_monthly, num: true, html: (r) => sipCell(r, { client: r.client_name, ...scope }) },
      { label: "Loans", value: (r) => r.loan_value, num: true, html: (r) => (r.loan_value ? fmt.money(r.loan_value) : "–") },
    ];
  }

  function emptyHome() {
    view.innerHTML = `${crumbs([["Dashboard"]])}<div class="card empty-state"><h2>No investment data yet</h2>
      <p>Upload AUM and SIP files in the Admin Panel, client wise or platform wise. They will show up here.</p>
      <a class="primary big" href="#/admin" style="text-decoration:none;display:inline-block;padding:11px 22px;border-radius:7px;color:#fff">Go to Admin Panel</a></div>`;
  }

  // ---- Home: categories, platforms, recent updates ---------------------------------------
  async function home() {
    loading();
    let d, meta;
    try { [d, meta] = await Promise.all([api("GET", "/dashboard"), api("GET", "/meta")]); } catch (e) { return errorView(e); }
    const t = d.total;
    if (!t.clients) return emptyHome();
    const catCards = meta.products.map((prod) => {
      const c = d.products.find((x) => x.product === prod);
      const listed = meta.platforms.filter((p) => p.product === prod).length;
      if (!c) {
        return `<div class="ccard empty" style="--c:${CAT_COLORS[prod]}"><div class="top"><span class="name">${esc(prod)}</span>
          <span class="tag">${plural(listed, "platform")}</span></div><div class="big muted">No data yet</div></div>`;
      }
      const isLoan = prod === "LAS";
      return `<a class="ccard" href="${catLink(prod)}" style="--c:${CAT_COLORS[prod]}">
        <div class="top"><span class="name">${esc(prod)}</span><span class="tag">${plural(c.clients, "client")} · ${plural(c.platform_count, "platform")}</span></div>
        <div class="big">${fmt.money(isLoan ? c.loan_value : c.current_value)}</div>
        <div class="small muted">${isLoan ? "loans outstanding" : `${t.current_value ? ((c.current_value / t.current_value) * 100).toFixed(1) : "0.0"}% of AUM · ${gainText(c.gain_loss, c.return_pct)}`}</div>
        ${c.sips ? `<div class="small" style="margin-top:4px">SIP ${fmt.money(c.sip_monthly)}/month · ${plural(c.live_sips, "live SIP")}</div>` : ""}
      </a>`;
    }).join("");
    view.innerHTML = `${crumbs([["Dashboard"]])}
      <div class="page-head"><div><h1>Multi Asset Dashboard</h1>
        <div class="sub">${plural(t.clients, "client")} · ${plural(t.platforms, "platform")} · ${plural(d.products.length, "category", "categories")} · ${plural(t.files, "uploaded file")}</div></div></div>
      ${allKpis(t)}
      <h3 class="section-title">Categories</h3>
      <div class="cards ccards">${catCards}</div>
      <div class="two-col" style="margin-top:18px"><div><h3 class="section-title">Platforms</h3><div class="cards">${d.platforms.map((p) => `
        <a class="pcard" href="${platLink(p.platform)}">
          <div class="top"><span class="name">${esc(p.platform)}</span><span class="tag">${plural(p.clients, "client")}</span></div>
          <div style="margin:-4px 0 10px -6px">${chips(p.products)}</div>
          <dl><div><dt>Current value</dt><dd>${p.holdings ? fmt.money(p.current_value) : "–"}</dd></div><div><dt>Gain / Loss</dt><dd>${p.holdings ? gainText(p.gain_loss, p.return_pct) : "–"}</dd></div>
          <div><dt>Monthly SIP</dt><dd>${p.sips ? fmt.money(p.sip_monthly) : "–"}</dd></div><div><dt>${p.loan_value ? "Loans" : "XIRR · As at"}</dt>
          <dd>${p.loan_value ? fmt.money(p.loan_value) : `${fmt.pct(p.xirr)} · ${fmt.date(p.as_of)}`}</dd></div></dl>
        </a>`).join("")}</div></div>
      <div>${allocation(d.assets, t.current_value)}
        <div class="card"><h3 class="section-title">Recent updates</h3><div class="recent">${d.recent.map((b) => `
          <div class="ritem"><div><b>${b.upload_type === "client" ? esc(b.client_name) : "Platform Wise"}</b>
            <span class="muted small"> · ${esc(b.uploaded_at)}</span></div>
            <div class="small">${esc(b.platforms)} ${chips(b.products)}</div>
            <div class="small muted">${plural(b.files, "file")}: ${b.new_files ? `${b.new_files} new` : ""}${b.new_files && b.files - b.new_files ? ", " : ""}${b.files - b.new_files ? `${b.files - b.new_files} added as new versions` : ""} · data as of ${fmt.date(b.snapshot_date)}</div>
          </div>`).join("")}</div>
          <a href="#/admin" class="small">Upload more files →</a></div>
      </div></div>`;
    linkSipKpi("");
  }

  // ---- One platform and/or one category --------------------------------------------------
  async function scope({ platform, product }) {
    loading();
    let d;
    const q = new URLSearchParams(Object.entries({ platform, product }).filter(([, v]) => v));
    try { d = await api("GET", `/dashboard/scope?${q}`); } catch (e) { return errorView(e, true); }
    const t = d.total;
    const pName = d.platformName || platform;
    const title = pName && product ? `${pName} · ${product}` : pName || product;
    const trail = [["Dashboard", "#/dashboard"]];
    if (pName && product) trail.push([pName, platLink(pName)]);
    trail.push([product && !pName ? `${product} (category)` : title]);
    view.innerHTML = `${crumbs(trail)}
      <div class="page-head"><div><h1>${esc(title)}</h1><div class="sub">${plural(t.clients, "client")} · ${plural(t.holdings, "holding")}${t.sips ? ` · ${plural(t.sips, "SIP")}` : ""} · as at ${fmt.date(t.as_of)}</div></div>
        <button class="outline" id="dlScope">Download Excel report</button></div>
      ${allKpis(t)}
      ${!(pName && product) ? `<div class="card"><h3 class="section-title">${pName ? "By category" : "By platform"}</h3><div id="splitTable"></div></div>` : ""}
      <div class="two-col"><div class="card"><h3 class="section-title">Clients</h3><div id="clientTable"></div></div>
      <div>${allocation(d.assets, t.current_value)}</div></div>
      <div class="card"><h3 class="section-title">Update history</h3><div id="histTable"></div></div>`;

    if (!(pName && product)) {
      const rows = pName ? d.products : d.platforms;
      dataTable($("splitTable"), {
        rows, initialSort: 2,
        onClick: (r) => { location.hash = platLink(pName || r.platform, product || r.product); },
        columns: [
          pName ? { label: "Category", value: (r) => r.product, html: (r) => `<a href="${platLink(pName, r.product)}">${esc(r.product)}</a>` }
            : { label: "Platform", value: (r) => r.platform, html: (r) => `<a href="${platLink(r.platform, product)}">${esc(r.platform)}</a>` },
          { label: "Clients", value: (r) => r.clients, num: true },
          { label: "Current Value", value: (r) => r.current_value || r.loan_value, num: true, html: (r) => fmt.money(r.current_value || r.loan_value) },
          { label: "Invested", value: (r) => r.invested, num: true, html: (r) => fmt.money(r.invested) },
          { label: "Gain / Loss", value: (r) => r.gain_loss, num: true, html: (r) => gainText(r.gain_loss, r.return_pct) },
          { label: "XIRR", value: (r) => r.xirr, num: true, html: (r) => fmt.pct(r.xirr) },
          { label: "Monthly SIP", value: (r) => r.sip_monthly, num: true, html: (r) => sipCell(r, { platform: pName || r.platform, product: product || r.product }) },
          { label: "As at", value: (r) => r.as_of, cls: "nw", html: (r) => fmt.date(r.as_of) },
        ],
      });
    }
    dataTable($("clientTable"), {
      rows: d.clients, searchPlaceholder: "Search clients", initialSort: 4,
      onClick: (r) => { location.hash = `#/client/${enc(r.client_name)}`; },
      columns: clientColumns({ platform: pName || "", product: product || "" }),
      footer: ["Total", "", t.holdings, fmt.money(t.invested), fmt.money(t.current_value), gainText(t.gain_loss), fmt.pct(t.return_pct),
        fmt.pct(t.xirr), t.sips ? fmt.money(t.sip_monthly) : "–", t.loans ? fmt.money(t.loans) : "–"],
    });
    historyTable($("histTable"), d.history);
    linkSipKpi(q.toString());
    $("dlScope").addEventListener("click", () => exportExcel(q, title, true));
  }

  // ---- One client -----------------------------------------------------------------------
  async function client(name) {
    loading();
    let d;
    try { d = await api("GET", `/dashboard/client?name=${enc(name)}`); } catch (e) { return errorView(e, true); }
    const t = d.total;
    const back = d.platforms.length === 1 ? [[d.platforms[0].platform, platLink(d.platforms[0].platform)]] : [];
    view.innerHTML = `${crumbs([["Dashboard", "#/dashboard"], ...back, [d.clientName]])}
      <div class="page-head"><div><h1>${esc(d.clientName)}</h1>
        <div class="sub">${d.clientId ? `${esc(d.clientId)} · ` : ""}${plural(t.holdings, "holding")} · ${plural(d.products.length, "category", "categories")} · ${plural(t.platforms, "platform")} · as at ${fmt.date(t.as_of)}</div></div>
        <button class="outline" id="dlClient">Download Excel report</button></div>
      ${allKpis(t)}
      <div class="card"><h3 class="section-title">Category & Platform</h3><div id="ppTable"></div></div>
      <div class="alloc-wide">${allocation(d.assets, t.current_value)}</div>
      <div class="card"><h3 class="section-title">Scheme-wise Investment Details</h3><div id="schemeTable"></div></div>
      ${d.sips.length ? `<div class="card"><h3 class="section-title">SIP Details</h3>
        <div class="seg-chips" id="sipCats" role="group" aria-label="Filter SIPs by category"></div>
        <p id="sipFilterNote" class="filter-note" hidden></p><div id="sipTable"></div></div>` : ""}
      <div class="card"><h3 class="section-title">Update history</h3><p class="muted small" style="margin:-6px 0 10px">Every upload with this client's data is kept. The latest version of each platform + category is used above.</p><div id="histTable"></div></div>`;

    dataTable($("ppTable"), {
      rows: d.platformProducts, initialSort: 4,
      onClick: (r) => { location.hash = platLink(r.platform, r.product); },
      columns: [
        { label: "Category", value: (r) => r.product, html: (r) => `<a href="${catLink(r.product)}">${esc(r.product)}</a>` },
        { label: "Platform", value: (r) => r.platform, html: (r) => `<a href="${platLink(r.platform, r.product)}">${esc(r.platform)}</a>` },
        { label: "Version", value: (r) => r.version, num: true, html: (r) => `v${r.version}<span class="note">${fmt.date(r.snapshot_date)}</span>` },
        { label: "Invested", value: (r) => r.invested, num: true, html: (r) => (r.product === "LAS" || !r.holdings ? "–" : fmt.money(r.invested)) },
        { label: "Current Value", value: (r) => r.current_value, num: true, html: (r) => (!r.holdings ? "–" : `${fmt.money(r.current_value)}${r.product === "LAS" ? '<span class="note">loan outstanding</span>' : ""}`) },
        { label: "Gain", value: (r) => r.gain_loss, num: true, html: (r) => (r.product === "LAS" || !r.holdings ? "–" : gainText(r.gain_loss, r.return_pct)) },
        { label: "XIRR", value: (r) => r.xirr, num: true, html: (r) => fmt.pct(r.xirr) },
        { label: "Monthly SIP", value: (r) => r.sip_monthly, num: true, html: (r) => (r.sips
          ? `<button type="button" class="sip-link" data-filter-sips="${esc(r.product)}|${esc(r.platform)}" title="Show these SIPs below">${fmt.money(r.sip_monthly)}
            <span class="note">${plural(r.live_sips, "live SIP")} ›</span></button>` : "–") },
      ],
    });

    const total = t.current_value;
    const aum = d.holdings.filter((h) => h.product !== "LAS");
    dataTable($("schemeTable"), {
      rows: d.holdings, searchPlaceholder: "Search scheme, folio, ISIN, platform or category", initialSort: 10, wide: true,
      columns: [
        { label: "No", value: (r) => d.holdings.indexOf(r) + 1, num: true },
        { label: "Category", value: (r) => r.product, search: true, cls: "nw" },
        { label: "Platform", value: (r) => r.platform, search: true, cls: "nw" },
        { label: "Folio / Symbol", value: (r) => r.identifier, search: true },
        { label: "Scheme Name", value: (r) => r.security_name, search: true, cls: "scheme",
          html: (r) => `${esc(r.security_name || "–")}<span class="chip">${esc(r.asset_class || "Unclassified")}</span>${r.isin ? `<span class="note">${esc(r.isin)}</span>` : ""}` },
        { label: "Units", value: (r) => r.quantity, num: true, html: (r) => fmt.qty(r.quantity) },
        { label: "Avg NAV / Cost", value: (r) => r.avg_cost, num: true, html: (r) => fmt.money2(r.avg_cost) },
        { label: "Inv. Cost", value: (r) => r.invested, num: true, html: (r) => fmt.money(r.invested) },
        { label: "Latest NAV / Price", value: (r) => r.current_price, num: true, html: (r) => fmt.money2(r.current_price) },
        { label: "NAV Date", value: (r) => r.as_of, cls: "nw", html: (r) => fmt.date(r.as_of) },
        { label: "Current Value", value: (r) => r.current_value, num: true, html: (r) => fmt.money(r.current_value) },
        { label: "Unrealised Gain", value: (r) => r.gain_loss, num: true, html: (r) => gainText(r.gain_loss) },
        { label: "Weight %", value: (r) => (total && r.product !== "LAS" ? (r.current_value || 0) / total * 100 : null), num: true,
          html: (r) => (r.product === "LAS" ? '<span class="muted small">loan</span>' : fmt.pct(total ? (r.current_value || 0) / total * 100 : null)) },
        { label: "Abs Ret %", value: (r) => r.return_pct, num: true, html: (r) => `<span class="${fmt.signCls(r.return_pct)}">${fmt.pct(r.return_pct)}</span>` },
        { label: "XIRR %", value: (r) => r.xirr, num: true, html: (r) => fmt.pct(r.xirr) },
      ],
      footer: aum.length ? ["", "", "", "", `Total AUM <span class="muted small">(excl. loans)</span>`, "", "", fmt.money(t.invested), "", "", fmt.money(t.current_value), gainText(t.gain_loss), "100.00%", fmt.pct(t.return_pct), fmt.pct(t.xirr)] : null,
    });

    // SIP table with a category filter (All, MF, Stocks, ...).
    // cat: category to show ("" = all); platform: optionally only that platform's SIPs.
    const drawSips = (cat, platform = "") => {
      const rows = d.sips.filter((x) => (!cat || x.product === cat) && (!platform || x.platform === platform));
      const note = $("sipFilterNote");
      note.hidden = !platform;
      if (platform) {
        note.innerHTML = `Showing ${plural(rows.filter((x) => x.live).length, "live SIP")} in <b>${esc(cat)} · ${esc(platform)}</b>
          (${rows.length} in total). <button type="button" class="back-link" data-all>Show all SIPs</button>`;
        note.querySelector("[data-all]").addEventListener("click", () => drawSips(""));
      }
      const live = rows.filter((x) => x.live);
      $("sipCats").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.cat === (cat || "")));
      dataTable($("sipTable"), {
        rows, searchPlaceholder: "Search scheme, folio or platform", initialSort: 6,
        onClick: (r) => sipDetail(r.id),
        columns: [
          { label: "Category", value: (r) => r.product, search: true },
          { label: "Platform", value: (r) => r.platform, search: true, cls: "nw" },
          { label: "Scheme", value: (r) => r.security_name, search: true, cls: "scheme",
            html: (r) => `${esc(r.security_name || "–")}${r.identifier ? `<span class="note">${esc(r.identifier)}</span>` : ""}` },
          { label: "SIP Amount", value: (r) => r.sip_amount, num: true, html: (r) => fmt.money(r.sip_amount) },
          { label: "Frequency", value: (r) => r.frequency },
          { label: "SIP Day", value: (r) => r.sip_day, num: true },
          { label: "Monthly", value: (r) => (r.live ? r.monthly_amount : null), num: true, html: (r) => fmt.money(r.monthly_amount) },
          { label: "Start", value: (r) => r.start_date, cls: "nw", html: (r) => fmt.date(r.start_date) },
          { label: "End", value: (r) => r.end_date, cls: "nw", html: (r) => fmt.date(r.end_date) },
          { label: "Status", value: (r) => (r.live ? 1 : 0), html: (r) => `<span class="badge ${r.live ? "ok" : "muted"}">${esc(r.status || (r.live ? "Active" : "Ended"))}</span>` },
        ],
        footer: ["Live total", "", plural(live.length, "live SIP"), "", "", "", fmt.money(live.reduce((x, r) => x + (r.monthly_amount || 0), 0)), "", "", ""],
      });
    };
    if (d.sips.length) {
      const cats = [...new Set(d.sips.map((x) => x.product))];
      $("sipCats").innerHTML = (cats.length > 1 ? [["", "All"], ...cats.map((c) => [c, c])] : [])
        .map(([v, l]) => `<button type="button" class="chip-btn" data-cat="${esc(v)}">${esc(l)} <span class="muted">${v ? d.sips.filter((x) => x.product === v && x.live).length : t.live_sips}</span></button>`).join("");
      $("sipCats").addEventListener("click", (e) => { const b = e.target.closest("button[data-cat]"); if (b) drawSips(b.dataset.cat); });
      drawSips("");
      // "n live SIPs" in the Category & Platform table filters the SIP table to that row.
      $("ppTable").addEventListener("click", (e) => {
        const b = e.target.closest("[data-filter-sips]");
        if (!b) return;
        const [cat, platform] = b.dataset.filterSips.split("|");
        drawSips(cat, platform);
        $("sipTable").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    historyTable($("histTable"), d.history, { client: true });
    linkSipKpi("");
    $("dlClient").addEventListener("click", () => exportExcel(new URLSearchParams({ client: d.clientName }), d.clientName, false));
  }

  async function exportExcel(params, label, multiClient) {
    try {
      const { uploads } = await api("GET", `/export?${params}`);
      const buffer = await Report.build(label, uploads, { multiClient });
      download(xlsxBlob(buffer), reportName(label, multiClient ? "Multi_Asset" : "Consolidated"));
    } catch (e) {
      alert(`Could not create the report: ${e.message}`);
    }
  }

  return { home, scope, client, sips, sipDetail, sipListModal };
})();
