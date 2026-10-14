// Build the standardized Excel report from uploaded AUM and SIP files.
//
// Layout (the same whatever the source platform or file format):
//   1. Summary         - details, totals, breakdown by category, platform, asset class (and client)
//   2. Client Summary  - one row per client (reports covering many clients only)
//   3. Holdings        - every holding in one standard column set (loans excluded)
//   4. Loans (LAS)     - loans against securities, kept out of the AUM totals (if any)
//   5. SIPs            - every SIP registration with its monthly equivalent (if any)
//   6. Source Files    - which uploads went into the report and what was read from each
(function () {
  const NAVY = "FF1F3864";
  const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const HEADER_FILL = fill(NAVY), SUBTLE_FILL = fill("FFD9E1F2"), TOTAL_FILL = fill("FFF2F2F2");
  const WHITE_BOLD = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  const BOLD = { name: "Arial", bold: true };
  const BASE = { name: "Arial" };
  const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
  const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  const SECTION = { name: "Arial", bold: true, size: 12, color: { argb: NAVY } };

  const MONEY = '#,##0.00;[Red](#,##0.00);"-"';
  const QTY = '#,##0.###;[Red](#,##0.###);"-"';
  const PCT = '0.00%;[Red](0.00%);"-"';

  function headerRow(ws, row, headers) {
    headers.forEach((h, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = h;
      Object.assign(c, { font: WHITE_BOLD, fill: HEADER_FILL, border: BORDER });
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
  }

  function setCell(ws, row, col, value, { font = BASE, numFmt, border = BORDER, fill: f } = {}) {
    const c = ws.getCell(row, col);
    c.value = value ?? null;
    c.font = font;
    if (border) c.border = border;
    if (numFmt) c.numFmt = numFmt;
    if (f) c.fill = f;
    return c;
  }

  function totals(items) {
    const inv = items.reduce((s, h) => s + (h.invested || 0), 0);
    const cur = items.reduce((s, h) => s + (h.current_value || 0), 0);
    const gain = items.reduce((s, h) => s + (h.gain_loss || 0), 0);
    const r2 = (n) => Math.round(n * 100) / 100;
    return { inv: r2(inv), cur: r2(cur), gain: r2(gain), ret: inv ? gain / inv : null };
  }

  function groupBy(items, key) {
    const m = new Map();
    items.forEach((h) => {
      const k = h[key] || "Unclassified";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(h);
    });
    return m;
  }

  function breakdownTable(ws, row, title, groups, grandValue) {
    ws.getCell(row, 1).value = title;
    ws.getCell(row, 1).font = SECTION;
    row++;
    headerRow(ws, row, [title.replace("By ", ""), "Holdings", "Invested Amount", "Current Value",
      "Gain / Loss", "Return %", "Share of Portfolio"]);
    const sorted = [...groups.entries()].sort((a, b) => totals(b[1]).cur - totals(a[1]).cur);
    for (const [name, items] of sorted) {
      row++;
      const t = totals(items);
      const vals = [name, items.length, t.inv, t.cur, t.gain, t.ret, grandValue ? t.cur / grandValue : null];
      const fmts = [null, "0", MONEY, MONEY, MONEY, PCT, PCT];
      vals.forEach((v, i) => setCell(ws, row, i + 1, v, { numFmt: fmts[i] }));
    }
    return row + 2;
  }

  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    const mon = d.toLocaleString("en-US", { month: "short" });
    return `${p(d.getDate())}-${mon}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function summarySheet(wb, title, info, t) {
    const ws = wb.addWorksheet("Summary", { views: [{ showGridLines: false }] });
    ws.getCell("A1").value = title;
    ws.getCell("A1").font = { name: "Arial", bold: true, size: 16, color: { argb: NAVY } };
    info.forEach(([k, v], i) => {
      setCell(ws, 3 + i, 1, k, { font: BOLD, border: null });
      setCell(ws, 3 + i, 2, v, { border: null }).alignment = { horizontal: "left" };
    });
    let row = 3 + info.length + 1;
    ws.getCell(row, 1).value = "Portfolio Overview";
    ws.getCell(row, 1).font = SECTION;
    row++;
    headerRow(ws, row, ["Total Invested", "Current Value", "Gain / Loss", "Return %"]);
    [[t.inv, MONEY], [t.cur, MONEY], [t.gain, MONEY], [t.ret, PCT]].forEach(([v, f], i) =>
      setCell(ws, row + 1, i + 1, v, { numFmt: f, fill: SUBTLE_FILL, font: { name: "Arial", bold: true, size: 12 } }));
    [24, 18, 18, 18, 16, 12, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    return { ws, row: row + 3 };
  }

  // One row per holding in the given columns, with a total row; labelCol holds "TOTAL".
  function holdingsSheet(wb, columns, holdings, t, freezeCols, labelCol, weightTotal = true, name = "Holdings") {
    const wh = wb.addWorksheet(name, { views: [{ state: "frozen", xSplit: freezeCols, ySplit: 1 }] });
    headerRow(wh, 1, columns.map((c) => c[0]));
    wh.getRow(1).height = 30;
    holdings.forEach((h, idx) => {
      columns.forEach(([, key, fmt], col) => {
        let v = key === null ? idx + 1 : h[key];
        if ((key === "return_pct" || key === "xirr") && v !== null && v !== undefined) v = v / 100;
        setCell(wh, idx + 2, col + 1, v, { numFmt: fmt });
      });
    });
    const totalRow = holdings.length + 2;
    const colOf = (key) => columns.findIndex((c) => c[1] === key) + 1;
    columns.forEach((_, i) => setCell(wh, totalRow, i + 1, null, { font: BOLD, fill: TOTAL_FILL }));
    wh.getCell(totalRow, labelCol).value = "TOTAL";
    [["invested", t.inv], ["current_value", t.cur], ["gain_loss", t.gain], ["return_pct", t.ret], ["weight", weightTotal && t.cur ? 1 : null]]
      .forEach(([key, v]) => {
        const col = colOf(key);
        if (!col) return;
        const c = wh.getCell(totalRow, col);
        c.value = v;
        c.numFmt = columns[col - 1][2];
      });
    columns.forEach(([, , , w], i) => { wh.getColumn(i + 1).width = w; });
    if (holdings.length) wh.autoFilter = { from: { row: 1, column: 1 }, to: { row: totalRow - 1, column: columns.length } };
    wh.pageSetup.printTitlesRow = "1:1";
    return wh;
  }

  function sourceSheet(wb, headers, widths, rows) {
    const ws = wb.addWorksheet("Source Files", { views: [{ state: "frozen", ySplit: 1 }] });
    headerRow(ws, 1, headers);
    rows.forEach((vals, i) => vals.forEach((v, col) => setCell(ws, i + 2, col + 1, v)));
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  }

  async function finish(wb) {
    // Print each sheet landscape, one page wide.
    wb.worksheets.forEach((s) => { Object.assign(s.pageSetup, { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }); });
    return wb.xlsx.writeBuffer();
  }

  const byText = (key) => (a, b) => (a[key] || "").toLowerCase().localeCompare((b[key] || "").toLowerCase());
  const UNASSIGNED = "Unassigned (no client in file)";
  const LOANS = "LAS";
  const KIND = { aum: "AUM", sip: "SIP" };

  const col = (header, key, fmt, width) => [header, key, fmt, width];
  function holdingColumns(multi) {
    return [
      col("S.No", null, "0", 6),
      ...(multi ? [col("Client Name", "client_name", null, 24), col("Client ID / PAN", "client_id", null, 15)] : []),
      col("Category", "product", null, 10),
      col("Platform", "platform", null, 18),
      col("Asset Class", "asset_class", null, 14),
      col("Type (as reported)", "category", null, 16),
      col("Security Name", "security_name", null, 42),
      col("ISIN", "isin", null, 15),
      col("Symbol / Folio", "identifier", null, 15),
      col("Quantity", "quantity", QTY, 12),
      col("Avg Cost", "avg_cost", MONEY, 12),
      col("Invested Amount", "invested", MONEY, 16),
      col("Current Price", "current_price", MONEY, 13),
      col("Current Value", "current_value", MONEY, 16),
      col("Gain / Loss", "gain_loss", MONEY, 15),
      col("Return %", "return_pct", PCT, 10),
      col("XIRR %", "xirr", PCT, 9),
      col(multi ? "Weight in Client %" : "Weight %", "weight", PCT, 11),
      col("As of Date", "as_of", null, 12),
      col("Source File", "source_file", null, 30),
    ];
  }

  function sipColumns(multi) {
    return [
      col("S.No", null, "0", 6),
      ...(multi ? [col("Client Name", "client_name", null, 24)] : []),
      col("Category", "product", null, 10),
      col("Platform", "platform", null, 18),
      col("Scheme / Security", "security_name", null, 42),
      col("ISIN", "isin", null, 15),
      col("Folio / SIP No", "identifier", null, 16),
      col("SIP Amount", "sip_amount", MONEY, 13),
      col("Frequency", "frequency", null, 12),
      col("Monthly Equivalent", "monthly_amount", MONEY, 15),
      col("SIP Day", "sip_day", "0", 8),
      col("Start Date", "start_date", null, 12),
      col("End Date", "end_date", null, 12),
      col("Status", "status", null, 12),
      col("Live", "live_text", null, 7),
      col("Source File", "source_file", null, 30),
    ];
  }

  function sipSheet(wb, sips, multi) {
    const columns = sipColumns(multi);
    const ws = wb.addWorksheet("SIPs", { views: [{ state: "frozen", xSplit: multi ? 2 : 1, ySplit: 1 }] });
    headerRow(ws, 1, columns.map((c) => c[0]));
    ws.getRow(1).height = 30;
    sips.forEach((s, i) => columns.forEach(([, key, f], c) => setCell(ws, i + 2, c + 1, key === null ? i + 1 : s[key], { numFmt: f })));
    const r = sips.length + 2;
    columns.forEach((_, i) => setCell(ws, r, i + 1, null, { font: BOLD, fill: TOTAL_FILL }));
    const monthlyCol = columns.findIndex((c) => c[1] === "monthly_amount") + 1;
    ws.getCell(r, monthlyCol - 1).value = "LIVE TOTAL";
    ws.getCell(r, monthlyCol).value = sips.filter((s) => s.live).reduce((t, s) => t + (s.monthly_amount || 0), 0);
    ws.getCell(r, monthlyCol).numFmt = MONEY;
    columns.forEach(([, , , w], i) => { ws.getColumn(i + 1).width = w; });
    if (sips.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: r - 1, column: columns.length } };
  }

  // One row per client with totals, SIPs and current value per category.
  function clientSummarySheet(wb, clients, sipsByClient, cats, t) {
    const ws = wb.addWorksheet("Client Summary", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
    const headers = ["Client Name", "Client ID / PAN", "Holdings", "Invested Amount", "Current Value", "Gain / Loss",
      "Return %", "Share of Total", "Live SIPs", "Monthly SIP", ...cats.map((a) => `${a} (Current Value)`)];
    headerRow(ws, 1, headers);
    ws.getRow(1).height = 30;
    const fmts = [null, null, "0", MONEY, MONEY, MONEY, PCT, PCT, "0", MONEY, ...cats.map(() => MONEY)];
    const names = [...new Set([...clients.keys(), ...sipsByClient.keys()])]
      .sort((a, b) => totals(clients.get(b) || []).cur - totals(clients.get(a) || []).cur);
    names.forEach((name, i) => {
      const items = clients.get(name) || [], sips = (sipsByClient.get(name) || []).filter((s) => s.live);
      const ct = totals(items);
      const ids = [...new Set(items.map((h) => h.client_id).filter(Boolean))].join(", ");
      const perCat = cats.map((a) => totals(items.filter((h) => h.product === a)).cur || null);
      [name, ids, items.length, ct.inv, ct.cur, ct.gain, ct.ret, t.cur ? ct.cur / t.cur : null, sips.length,
        sips.reduce((s, x) => s + (x.monthly_amount || 0), 0), ...perCat]
        .forEach((v, c) => setCell(ws, i + 2, c + 1, v, { numFmt: fmts[c] }));
    });
    headers.forEach((h, i) => { ws.getColumn(i + 1).width = i === 0 ? 28 : i === 1 ? 16 : Math.max(12, Math.min(20, h.length + 2)); });
    if (names.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: names.length + 1, column: headers.length } };
  }

  // title: client name (Client Wise) or a label. multiClient: the report covers many clients.
  async function build(title, uploads, { multiClient = false } = {}) {
    const all = [], sips = [];
    uploads.forEach((u) => {
      const base = { platform: u.platform, product: u.product || "Other", source_file: u.originalName };
      (u.holdings || []).forEach((h) => all.push({ ...h, ...base, client_name: h.client_name || UNASSIGNED }));
      (u.sips || []).forEach((s) => sips.push({ ...s, ...base, client_name: s.client_name || UNASSIGNED, live_text: s.live === false ? "No" : "Yes" }));
    });
    const order = (a, b) => (multiClient ? byText("client_name")(a, b) : 0) || PRODUCT_ORDER(a, b) || byText("platform")(a, b)
      || byText("asset_class")(a, b) || byText("security_name")(a, b);
    const holdings = all.filter((h) => h.product !== LOANS).sort(order);
    const loans = all.filter((h) => h.product === LOANS).sort(order);
    sips.sort((a, b) => Number(b.live !== false) - Number(a.live !== false) || order(a, b));
    const t = totals(holdings);
    const clients = groupBy(holdings, "client_name");
    if (multiClient) clients.forEach((items) => { const ct = totals(items); items.forEach((h) => { h.weight = ct.cur ? (h.current_value || 0) / ct.cur : null; }); });
    else holdings.forEach((h) => { h.weight = t.cur ? (h.current_value || 0) / t.cur : null; });
    const live = sips.filter((s) => s.live !== false);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Upload Details";
    const platforms = [...new Set(uploads.map((u) => u.platform))].sort();
    const cats = PRODUCTS.filter((p) => uploads.some((u) => u.product === p));
    const dates = uploads.map((u) => u.snapshotDate).filter(Boolean).sort();
    const info = [
      [multiClient ? "Report" : "Client Name", title],
      ["Report Generated", fmtDate(new Date())],
      ["Data as of", dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`) : "–"],
      ["Categories", cats.join(", ")],
      ["Platforms", platforms.join(", ")],
      ...(multiClient ? [["Clients", [...new Set([...holdings, ...sips].map((h) => h.client_name))].filter((c) => c !== UNASSIGNED).length]] : []),
      ["Files", uploads.length],
      ["Holdings", holdings.length],
      ["Live SIPs", `${live.length} (monthly ${live.reduce((s, x) => s + (x.monthly_amount || 0), 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })})`],
      ...(loans.length ? [["Loans (LAS)", totals(loans).cur.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " (not included in totals)"]] : []),
    ];
    let { ws, row } = summarySheet(wb, multiClient ? "Multi Asset Report" : "Consolidated Investment Report", info, t);
    row = breakdownTable(ws, row, "By Category", groupBy(holdings, "product"), t.cur);
    row = breakdownTable(ws, row, "By Platform", groupBy(holdings, "platform"), t.cur);
    row = breakdownTable(ws, row, "By Asset Class", groupBy(holdings, "asset_class"), t.cur);
    if (multiClient) row = breakdownTable(ws, row, "By Client", clients, t.cur);
    if (multiClient && clients.has(UNASSIGNED)) {
      ws.getCell(row, 1).value = "Note: some rows had no client name in the file and are listed as Unassigned.";
      ws.getCell(row, 1).font = { name: "Arial", italic: true, color: { argb: "FFC00000" } };
      row++;
    }
    if (uploads.some((u) => !(u.holdings || []).length && !(u.sips || []).length)) {
      ws.getCell(row, 1).value = "Note: some uploaded files had no readable data. See the Source Files sheet.";
      ws.getCell(row, 1).font = { name: "Arial", italic: true, color: { argb: "FFC00000" } };
    }

    if (multiClient) clientSummarySheet(wb, clients, groupBy(sips, "client_name"), cats.filter((c) => c !== LOANS), t);
    const columns = holdingColumns(multiClient);
    const nameCol = columns.findIndex((c) => c[1] === "security_name") + 1;
    holdingsSheet(wb, columns, holdings, t, multiClient ? 3 : 2, nameCol, !multiClient);
    if (loans.length) {
      const lt = totals(loans);
      loans.forEach((h) => { h.weight = null; });
      holdingsSheet(wb, columns, loans, lt, multiClient ? 3 : 2, nameCol, false, "Loans (LAS)");
    }
    if (sips.length) sipSheet(wb, sips, multiClient);
    sourceSheet(wb, ["File Name", "File", "Category", "Platform", "Upload Type", "Version", "Data as of", "Uploaded At", "Rows Read", "Status", "Notes"],
      [34, 6, 10, 18, 13, 8, 12, 17, 10, 14, 50],
      uploads.map((u) => [u.originalName, KIND[u.kind] || "AUM", u.product, u.platform, u.uploadType === "platform" ? "Platform Wise" : "Client Wise",
        u.version, u.snapshotDate, u.uploadedAt, (u.holdings || []).length + (u.sips || []).length, u.status, u.notes || ""]));
    return finish(wb);
  }

  const PRODUCTS = ["MF", "Stocks", "PMS", "AIF", "Bonds", "LAS", "Other"];
  const PRODUCT_ORDER = (a, b) => PRODUCTS.indexOf(a.product) - PRODUCTS.indexOf(b.product);
  const buildPlatform = (label, uploads) => build(label, uploads, { multiClient: true });

  window.Report = { build, buildPlatform };
})();
