// Client Review Sheet: fills the Finowise review workbook (templates/client-review.xlsx) with one
// client's data (plus the reviewer's edits) and downloads it. The template keeps every sheet, style, formula, chart and logo
// of the review sheet the team already uses; only its data cells are written here:
//   1                   client name and review date (cover)
//   Portfolio Journey   values by year: MF by platform and type, stocks / PMS / AIF / bonds, SIPs
//   SUMMARY PORTFOLIO   one row per date data was uploaded for
//   DETAILED PORTFOLIO  scheme-wise list, grouped by platform and fund type
// Summary and Freedom Blueprint are formulas over Portfolio Journey, so Excel works them out when
// the file is opened. Other savings (EPF, PPF, property...), personal details and the discussion
// notes are not uploaded anywhere: the RM types them on the Review Report page
// (public/js/reviewpage.js), which also lets them correct the uploaded figures for the report.
//
// The workbook is edited as XML inside the zip (JSZip), because rebuilding it with a spreadsheet
// library would drop the charts and much of the formatting.
const Review = (() => {
  const TEMPLATE_URL = "templates/client-review.xlsx";
  const LOANS = "LAS";
  const MF_TYPES = ["Equity", "Hybrid", "Debt", "Others"];

  // ---- Worksheet XML ---------------------------------------------------------------------
  const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colName = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const splitRef = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); return [colNum(m[1]), Number(m[2])]; };
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const round2 = (n) => Math.round(n * 100) / 100;

  // Excel date serial for an ISO date (YYYY-MM-DD).
  const serial = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  };

  class Sheet {
    constructor(xml) {
      const m = /<sheetData\s*\/>|<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml);
      this.head = xml.slice(0, m.index);
      this.tail = xml.slice(m.index + m[0].length);
      this.rows = new Map();
      for (const rm of (m[1] || "").matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = Number(/\br="(\d+)"/.exec(rm[1])[1]);
        const cells = new Map();
        for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          cells.set(splitRef(/\br="([A-Z]+\d+)"/.exec(cm[1])[1])[0], cm[0]);
        }
        this.rows.set(r, { attrs: rm[1].replace(/\s*\b(r|spans)="[^"]*"/g, ""), cells });
      }
    }

    row(r) {
      if (!this.rows.has(r)) this.rows.set(r, { attrs: "", cells: new Map() });
      return this.rows.get(r);
    }

    style(ref) {
      const [c, r] = splitRef(ref);
      const x = this.rows.get(r)?.cells.get(c);
      const m = x && /\bs="(\d+)"/.exec(x.slice(0, x.indexOf(">")));
      return m ? m[1] : null;
    }

    text(ref) {
      const [c, r] = splitRef(ref);
      const x = this.rows.get(r)?.cells.get(c) || "";
      const m = /<t[^>]*>([^<]*)<\/t>/.exec(x);
      return m ? m[1] : null;
    }

    // value: number, string, {f: formula}, or null/"" for an empty cell. The cell keeps its
    // style unless opts.s is given.
    set(ref, value, opts = {}) {
      const [c, r] = splitRef(ref);
      const s = opts.s !== undefined ? opts.s : this.style(ref);
      const sa = s !== null && s !== undefined ? ` s="${s}"` : "";
      let x;
      if (value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) {
        x = `<c r="${ref}"${sa}/>`;
      } else if (typeof value === "number") {
        x = `<c r="${ref}"${sa}><v>${Math.round(value * 1e4) / 1e4}</v></c>`;
      } else if (typeof value === "object" && value.f) {
        x = `<c r="${ref}"${sa}><f>${xmlEsc(value.f)}</f></c>`;
      } else {
        x = `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
      }
      this.row(r).cells.set(c, x);
    }

    clear(ref) { if (this.rows.get(splitRef(ref)[1])?.cells.has(splitRef(ref)[0])) this.set(ref, null); }

    clearArea(c1, c2, r1, r2) {
      for (let r = r1; r <= r2; r++) {
        const row = this.rows.get(r);
        if (!row) continue;
        for (const c of [...row.cells.keys()]) if (c >= colNum(c1) && c <= colNum(c2)) this.set(`${colName(c)}${r}`, null);
      }
    }

    // Style of every cell in a row, by column number.
    rowStyles(r) {
      const out = new Map();
      for (const [c] of this.rows.get(r)?.cells || []) out.set(c, this.style(`${colName(c)}${r}`));
      return out;
    }

    rowAttrs(r) { return this.rows.get(r)?.attrs || ""; }

    deleteRowsFrom(r1) { for (const r of [...this.rows.keys()]) if (r >= r1) this.rows.delete(r); }

    // Start row r afresh: no cells, the given row attributes, and an empty styled cell for each
    // entry of styles (so borders and fills carry across the row).
    blankRow(r, attrs, styles) {
      this.rows.set(r, { attrs, cells: new Map() });
      for (const [c, s] of styles) this.set(`${colName(c)}${r}`, null, { s });
    }

    setMerges(refs) {
      const xml = refs.length ? `<mergeCells count="${refs.length}">${refs.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
      if (/<mergeCells\b[\s\S]*?<\/mergeCells>/.test(this.tail)) this.tail = this.tail.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/, xml);
      else this.tail = xml + this.tail;
    }

    toXml() {
      const rows = [...this.rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, { attrs, cells }]) => {
        const cs = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join("");
        return cs ? `<row r="${r}"${attrs}>${cs}</row>` : `<row r="${r}"${attrs}/>`;
      }).join("");
      const last = Math.max(1, ...this.rows.keys());
      const head = this.head.replace(/<dimension ref="[^"]*"\/>/, (d) => d.replace(/:[A-Z]+\d+"/, (x) => x.replace(/\d+"$/, `${last}"`)));
      return `${head}<sheetData>${rows}</sheetData>${this.tail}`;
    }
  }

  // Sheet name -> path inside the zip.
  async function sheetPaths(zip) {
    const wb = await zip.file("xl/workbook.xml").async("string");
    const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    const target = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0])[1], t = /Target="([^"]+)"/.exec(m[0])[1];
      target[id] = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
    }
    const out = {};
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(m[0])[1].replace(/&amp;/g, "&");
      out[name] = target[/r:id="([^"]+)"/.exec(m[0])[1]];
    }
    return out;
  }

  // ---- Classifying holdings --------------------------------------------------------------
  const lower = (s) => String(s || "").toLowerCase();

  function mfType(name, category) {
    const t = `${lower(category)} ${lower(name)}`;
    if (/gold|silver|commodit/.test(t)) return "Others";
    if (/hybrid|balanced|dynamic asset|multi[\s-]*asset|asset allocat|arbitrage|equity savings|retirement|children/.test(t)) return "Hybrid";
    if (/liquid|overnight|money market|\bdebt\b|bond|gilt|duration|credit risk|banking (&|and) psu|psu debt|floater|floating|\bincome\b|treasury|dynamic term|fixed maturity|\bfmp\b|target maturity|savings fund|ultra short|low duration|corporate|g-?sec|constant maturity|accrual/.test(t)) return "Debt";
    return "Equity";
  }

  const SUB_TYPES = [
    [/large\s*(&|and)\s*mid/, "Large and Mid Cap"], [/large\s*cap|blue\s*chip|frontline|top 100/, "Large Cap"], [/mid[\s-]*cap|emerging equity/, "Mid Cap"],
    [/small[\s-]*cap/, "Small Cap"], [/flexi[\s-]*cap/, "Flexi Cap"], [/multi[\s-]*cap/, "Multi Cap"], [/focused/, "Focused"],
    [/elss|tax\s*saver/, "ELSS"], [/\bvalue\b|contra/, "Value / Contra"], [/dividend yield/, "Dividend Yield"],
    [/balanced advantage|dynamic asset/, "Bal Adv"], [/multi[\s-]*asset/, "Multi AA"], [/aggressive hybrid|equity hybrid/, "Aggressive Hybrid"],
    [/conservative hybrid/, "Conservative Hybrid"], [/arbitrage/, "Arbitrage"], [/equity savings/, "Equity Savings"],
    [/liquid/, "Liquid"], [/overnight/, "Overnight"], [/money market/, "Money Market"], [/gilt|g-?sec/, "Gilt"],
    [/corporate bond/, "Corporate Bond"], [/banking (&|and) psu/, "Banking & PSU"], [/short (term|duration)/, "Short Duration"],
    [/dynamic (bond|term)/, "Dyn. Bond"], [/ultra short|low duration/, "Ultra Short"], [/credit risk/, "Credit Risk"],
    [/gold/, "Gold Plan"], [/silver/, "Silver"], [/international|global|nasdaq|overseas|\bus\b/, "International"],
    [/index|nifty|sensex|\betf\b/, "Index"], [/sector|thematic|infra|pharma|banking|technology|consumption/, "Sectoral / Thematic"],
    [/fof|fund of fund/, "FOF"],
  ];
  const GENERIC = /^(mutual fund|mf|equity|debt|hybrid|others?|unclassified)$/i;

  function subType(name, category) {
    const cat = String(category || "").trim().replace(/^(equity|debt|hybrid|other|solution oriented)\s*[:\-–]\s*/i, "");
    if (cat && !GENERIC.test(cat)) return cat;
    const n = lower(name);
    const hit = SUB_TYPES.find(([re]) => re.test(n));
    return hit ? hit[1] : "";
  }

  const nameKey = (r) => lower(r.security_name).replace(/[^a-z0-9]+/g, " ").trim();
  const schemeKey = (r) => (r.isin ? `i:${r.isin}` : `n:${nameKey(r)}`);

  // SIP files rarely carry the ISIN that AUM files do. Give every row without one the ISIN another
  // row of the same scheme name has, so SIPs line up with their holdings.
  function shareIsins(rows) {
    const byName = new Map(rows.filter((r) => r.isin).map((r) => [nameKey(r), r.isin]));
    return rows.map((r) => (r.isin || !byName.has(nameKey(r)) ? r : { ...r, isin: byName.get(nameKey(r)) }));
  }

  // ---- Data as of a date -----------------------------------------------------------------
  // The rows of one upload for each platform + category. Now (date null): the latest upload, as
  // the dashboard's current_holdings / current_sips views pick it. As of a date: the upload with
  // the latest data date on or before it.
  function latestRows(rows, uploads, date) {
    const up = new Map(uploads.map((u) => [u.id, u]));
    const rank = (id) => (date ? `${up.get(id).snapshot_date}|${String(id).padStart(12, "0")}` : String(id).padStart(12, "0"));
    const best = new Map();
    for (const r of rows) {
      const u = up.get(r.upload_id);
      if (!u || (date && u.snapshot_date > date)) continue;
      const k = `${r.platform_key}|${r.product}`;
      if (!best.has(k) || rank(r.upload_id) > rank(best.get(k))) best.set(k, r.upload_id);
    }
    return rows.filter((r) => best.get(`${r.platform_key}|${r.product}`) === r.upload_id);
  }

  const PLATFORM = {
    nj: /^nj\b|\bnj wealth/, finowise: /finowise|advisor\s*khoj/, anandRathi: /anand\s*rathi/, freedom: /freedom\s*life\s*x|nflx/,
    motilal: /motilal/, omni: /omni\s*science/, piper: /piper/, phillip: /phil+ip/,
  };
  const is = (name, which) => PLATFORM[which].test(lower(name));

  // Fund type of a row: the reviewer's choice on the review dashboard, else from the category / name.
  const typeOfRow = (r) => r._type || mfType(r.security_name, r.category);

  function emptyMf() {
    const z = () => Object.fromEntries(MF_TYPES.map((t) => [t, 0]));
    return { value: z(), sip: z(), total: 0, sipTotal: 0, invested: 0 };
  }

  // Totals for one point in time.
  function figures(holdings, sips) {
    const own = holdings.filter((h) => h.product !== LOANS);
    const typeOf = new Map();
    const mf = new Map(); // platform name -> emptyMf()
    const add = (map, name) => { if (!map.has(name)) map.set(name, emptyMf()); return map.get(name); };
    for (const h of own.filter((x) => x.product === "MF")) {
      const t = typeOfRow(h);
      typeOf.set(schemeKey(h), t);
      const p = add(mf, h.platform);
      p.value[t] += h.current_value || 0; p.total += h.current_value || 0; p.invested += h.invested || 0;
    }
    const live = sips.filter((s) => s.live && s.product !== LOANS);
    for (const s of live.filter((x) => x.product === "MF")) {
      const t = typeOf.get(schemeKey(s)) || typeOfRow(s);
      const p = add(mf, s.platform);
      p.sip[t] += s.monthly_amount || 0; p.sipTotal += s.monthly_amount || 0;
    }
    // Stocks, PMS, AIF, bonds and other: value and live SIP by row of the Portfolio Journey.
    const other = new Map();
    const bump = (k, field, v) => { const o = other.get(k) || { value: 0, sip: 0 }; o[field] += v || 0; other.set(k, o); };
    const otherRow = (r) => {
      if (r.product === "PMS") return "PMS";
      if (r.product === "AIF") return "AIF";
      if (r.product === "Bonds") return "Bonds";
      if (r.product === "Other") return "Other";
      if (is(r.platform, "motilal")) return "Motilal";
      if (is(r.platform, "omni")) return "Omni";
      if (is(r.platform, "piper")) return "Piper";
      if (is(r.platform, "phillip")) return "Phillip";
      return "Direct";
    };
    for (const h of own.filter((x) => x.product !== "MF")) bump(otherRow(h), "value", h.current_value);
    for (const s of live.filter((x) => x.product !== "MF")) bump(otherRow(s), "sip", s.monthly_amount);
    const stocks = (row) => own.filter((h) => h.product === "Stocks" && is(h.platform, row)).reduce((a, h) => a + (h.current_value || 0), 0);
    return {
      mf, other,
      shares: { motilal: stocks("motilal"), omni: stocks("omni"), piper: stocks("piper"),
        total: own.filter((h) => h.product === "Stocks").reduce((a, h) => a + (h.current_value || 0), 0) },
      value: own.reduce((a, h) => a + (h.current_value || 0), 0),
      invested: own.reduce((a, h) => a + (h.invested || 0), 0),
      sip: live.reduce((a, s) => a + (s.monthly_amount || 0), 0),
    };
  }

  // ---- Filling the sheets ----------------------------------------------------------------
  const YEAR_COLS = Array.from({ length: 15 }, (_, i) => colName(6 + i)); // F..T
  const MF_BLOCKS = [6, 16, 26, 36, 46]; // first row of each MF platform block in Portfolio Journey
  const OTHER_ROWS = { PMS: 71, Motilal: 73, Omni: 75, Piper: 77, Phillip: 79, Direct: 81, Other: 83, AIF: 85, Bonds: 87 };

  // MF platforms in the five blocks: NJ, Finowise, Anand Rathi, then the largest other platform,
  // then all remaining platforms together.
  function mfBlocks(names) {
    const fixed = [names.find((n) => is(n, "nj")), names.find((n) => is(n, "finowise")), names.find((n) => is(n, "anandRathi"))];
    const rest = names.filter((n) => !fixed.includes(n));
    return [fixed[0], fixed[1], fixed[2], rest[0], rest.slice(1)].map((x) => (Array.isArray(x) ? x : x ? [x] : []));
  }

  function fillJourney(sh, years, current, reviewDate, allMf) {
    const startYear = Math.min(Number(reviewDate.slice(0, 4)), ...years.keys());
    sh.set("G2", serial(reviewDate));
    sh.set("F5", startYear);
    sh.set("G5", { f: "F5+1" });
    const blocks = mfBlocks(allMf);
    // Block labels for the 4th and 5th MF platforms.
    [[3, "B36", "D44", "D45", "Direct"], [4, "B46", "D54", "D55", "Other Advisors"]].forEach(([i, b, v, s, dflt]) => {
      const label = blocks[i].length === 1 ? blocks[i][0] : blocks[i].length ? "Other Advisors" : dflt;
      sh.set(b, label); sh.set(v, `${label} MF Portfolio Value`); sh.set(s, `${label} MF Live SIP`);
    });
    const used = new Set(Object.keys(OTHER_ROWS).filter((k) => [...years.values(), current].some((f) => f.other.has(k))));
    if (used.has("Other")) sh.set("B83", "Other Investments");
    if (used.has("AIF")) sh.set("B85", "AIF");
    if (used.has("Bonds")) sh.set("B87", "Bonds");

    YEAR_COLS.forEach((col, i) => {
      const y = startYear + i;
      const f = y === Number(reviewDate.slice(0, 4)) ? current : years.get(y);
      if (!f) return;
      blocks.forEach((names, b) => {
        const r0 = MF_BLOCKS[b];
        const sum = (field, t) => names.reduce((a, n) => a + (f.mf.get(n)?.[field][t] || 0), 0);
        MF_TYPES.forEach((t, k) => {
          sh.set(`${col}${r0 + k}`, sum("value", t) || null);
          sh.set(`${col}${r0 + 4 + k}`, sum("sip", t) || null);
        });
      });
      for (const [k, r] of Object.entries(OTHER_ROWS)) {
        const o = f.other.get(k);
        sh.set(`${col}${r}`, o?.value || null);
        sh.set(`${col}${r + 1}`, o?.sip || null);
      }
    });
    return startYear;
  }

  function fillSummaryPortfolio(sh, name, timeline) {
    const st = { a: sh.style("A37"), b: sh.style("B37"), n: sh.style("C37") };
    const attrs = sh.rowAttrs(37), gap = sh.rowAttrs(36);
    sh.deleteRowsFrom(3);
    // The Finowise MF platform takes the columns the old sheet used for Redvision.
    sh.set("M1", "FINOWISE");
    sh.set("U2", "FINOWISE LIVE SIP");
    sh.set("V2", "TOTAL FINOWISE MF PORTFOLIO VALUE");
    const mfCols = (f, which, cols) => {
      const p = [...f.mf.entries()].filter(([n]) => is(n, which)).map(([, v]) => v);
      const g = (field, t) => p.reduce((a, x) => a + x[field][t], 0);
      return cols.map((c, i) => [c, i < 8 ? g(i % 2 ? "sip" : "value", MF_TYPES[i >> 1]) : i === 8
        ? p.reduce((a, x) => a + x.sipTotal, 0) : p.reduce((a, x) => a + x.total, 0)]);
    };
    const span = (from, n) => Array.from({ length: n }, (_, i) => colName(colNum(from) + i));
    timeline.forEach(({ date, f }, i) => {
      const r = 3 + i * 2;
      sh.rows.set(r, { attrs, cells: new Map() });
      if (i) sh.rows.set(r - 1, { attrs: gap, cells: new Map() });
      sh.set(`A${r}`, serial(date), { s: st.a });
      sh.set(`B${r}`, name, { s: st.b });
      const ar = [...f.mf.entries()].filter(([n]) => is(n, "anandRathi")).map(([, v]) => v);
      const cells = [
        ...mfCols(f, "nj", span("C", 10)),
        ...mfCols(f, "finowise", span("M", 10)),
        ...MF_TYPES.map((t, k) => [colName(23 + k), ar.reduce((a, x) => a + x.value[t], 0)]), // W..Z
        ["AA", ar.reduce((a, x) => a + x.sipTotal, 0)], ["AB", ar.reduce((a, x) => a + x.total, 0)],
        ["AC", f.shares.motilal], ["AD", f.shares.omni], ["AE", f.shares.piper], ["AF", f.shares.total],
        ...mfCols(f, "freedom", span("AG", 10)),
        ["AQ", f.sip], ["AR", f.value], ["BL", f.sip], ["BM", f.invested], ["BN", f.value],
      ];
      for (const [c, v] of cells) sh.set(`${c}${r}`, v || null, { s: st.n });
      sh.set(`BO${r}`, { f: `BN${r}-BM${r}` }, { s: st.n });
    });
  }

  // rupee(styleId, refStyleId): the same cell style with the Live SIP column's ₹ number format.
  function fillDetailed(sh, client, holdings, sips, rupee = (id) => id) {
    // Styles from the template's own rows (see the review sheet this was built from).
    const proto = {
      investor: 3, type: 4, scheme: 6, groupTotal: 15, gap: 16, platformTotal: 34, platformGap: 35,
      header: 36, item: 37, subTotal: 38, subGap: 39, grand: 40,
    };
    const styles = Object.fromEntries(Object.entries(proto).map(([k, r]) => [k, sh.rowStyles(r)]));
    const attrs = Object.fromEntries(Object.entries(proto).map(([k, r]) => [k, sh.rowAttrs(r)]));
    sh.deleteRowsFrom(3);
    sh.set("P2", "New SIP");
    const merges = [];
    const schemeRows = new Map(); // row number -> rowKey of the scheme on it (for the review page)
    const folds = []; // fund-type and platform blocks the review page can fold: {id, head, first, last, total}
    let r = 3;
    const start = (kind) => { sh.blankRow(r, attrs[kind], styles[kind]); return r++; };
    // Scheme rows show ₹ on invested, current value and total, as on the Live SIP column.
    const RUPEE_COLS = new Set(["D", "G", "J"]);
    const put = (row, kind, values) => {
      for (const [c, v] of Object.entries(values)) {
        const st = styles[kind].get(colNum(c)) ?? null;
        sh.set(`${c}${row}`, v, { s: kind === "scheme" && RUPEE_COLS.has(c) && st !== null ? rupee(st, styles.scheme.get(15)) : st });
      }
    };
    const pct = (gain, inv) => (inv ? round2((gain / inv) * 100) : null);
    // Columns the reviewer fills on the review dashboard: tenure, new SIP, remarks, suggestions.
    const notes = (x) => Object.fromEntries([["N", x._tenure], ["P", x._newSip], ["T", x._remarks], ["U", x._suggest]].filter(([, v]) => v !== undefined && v !== ""));

    const row = start("investor");
    put(row, "investor", { A: "Investor", B: client.name + (client.id ? ` (${client.id})` : "") });
    r++;

    const own = holdings.filter((h) => h.product !== LOANS);
    const live = sips.filter((s) => s.live && s.product !== LOANS);
    const sipBy = new Map();
    for (const s of live) {
      const k = `${s.platform_key}|${s.product}|${schemeKey(s)}`;
      sipBy.set(k, (sipBy.get(k) || 0) + (s.monthly_amount || 0));
    }
    const totals = []; // rows of each platform total, for the grand total

    // Weighted XIRR of a set of rows, by current value.
    const xirrOf = (rows) => {
      const w = rows.filter((x) => Number.isFinite(x.xirr) && x.current_value);
      const v = w.reduce((a, x) => a + x.current_value, 0);
      return v ? round2(w.reduce((a, x) => a + x.xirr * x.current_value, 0) / v) : null;
    };

    // Mutual funds: one block per platform, schemes grouped by fund type.
    const mfPlatforms = [...new Set([...own, ...live].filter((x) => x.product === "MF").map((x) => x.platform_key))];
    for (const pk of mfPlatforms) {
      const hs = own.filter((h) => h.product === "MF" && h.platform_key === pk);
      const pname = (hs[0] || live.find((s) => s.platform_key === pk && s.product === "MF")).platform;
      put(start("header"), "header", { B: `${pname} · Mutual Funds` });
      const groupRows = [];
      const typeOf = new Map(hs.map((h) => [schemeKey(h), typeOfRow(h)]));
      for (const t of MF_TYPES) {
        const items = hs.filter((h) => typeOf.get(schemeKey(h)) === t).sort((a, b) => (b.current_value || 0) - (a.current_value || 0));
        // SIPs into schemes this platform's AUM file does not hold yet.
        const extra = live.filter((s) => s.product === "MF" && s.platform_key === pk && !typeOf.has(schemeKey(s))
          && typeOfRow(s) === t);
        const extraSchemes = [...new Map(extra.map((s) => [schemeKey(s), s])).values()];
        if (!items.length && !extraSchemes.length) continue;
        const head = start("type");
        put(head, "type", { A: "Type", B: t === "Others" ? "OTHERS" : t.toUpperCase() });
        const value = items.reduce((a, h) => a + (h.current_value || 0), 0);
        const first = r;
        let n = 0;
        for (const h of items) {
          const rr = start("scheme");
          schemeRows.set(rr, rowKey(h));
          put(rr, "scheme", {
            A: ++n, B: h.security_name || "", C: h._sub ?? subType(h.security_name, h.category), D: h.invested, E: 0, F: h.quantity,
            G: h.current_value, H: 0, I: 0, J: { f: `SUM(G${rr}:I${rr})` }, K: h.xirr, L: h.return_pct ?? pct((h.current_value || 0) - (h.invested || 0), h.invested),
            M: value ? round2(((h.current_value || 0) / value) * 100) : null, O: sipBy.get(`${pk}|MF|${schemeKey(h)}`) || null, ...notes(h),
          });
        }
        for (const s of extraSchemes) {
          const rr = start("scheme");
          schemeRows.set(rr, rowKey(s));
          put(rr, "scheme", { A: ++n, B: s.security_name || "", C: s._sub ?? subType(s.security_name, null), O: sipBy.get(`${pk}|MF|${schemeKey(s)}`) || null, ...notes(s) });
        }
        const last = r - 1;
        const gt = start("groupTotal");
        folds.push({ id: `${pk}|MF|${t}`, head, first, last, total: gt });
        merges.push(`A${gt}:C${gt}`);
        const sum = (c) => ({ f: `SUM(${c}${first}:${c}${last})` });
        const inv = items.reduce((a, h) => a + (h.invested || 0), 0);
        put(gt, "groupTotal", { A: "Grand Total", D: sum("D"), E: sum("E"), F: sum("F"), G: sum("G"), H: sum("H"), I: sum("I"), J: sum("J"),
          K: xirrOf(items), L: pct(value - inv, inv), M: 100, O: sum("O") });
        groupRows.push(gt);
        start("gap");
      }
      const pt = start("platformTotal");
      merges.push(`A${pt}:C${pt}`);
      const sumOf = (c) => ({ f: groupRows.length ? `SUM(${groupRows.map((g) => `${c}${g}`).join(",")})` : "0" });
      const value = hs.reduce((a, h) => a + (h.current_value || 0), 0), inv = hs.reduce((a, h) => a + (h.invested || 0), 0);
      put(pt, "platformTotal", { A: `Grand Total ${pname} Portfolio`, D: sumOf("D"), E: sumOf("E"), F: sumOf("F"), G: sumOf("G"), H: sumOf("H"),
        I: sumOf("I"), J: sumOf("J"), K: xirrOf(hs), L: pct(value - inv, inv), M: 100, O: sumOf("O") });
      totals.push(pt);
      start("platformGap");
    }

    // Stocks, PMS, AIF, bonds and other: one block per platform + category.
    const groups = [...new Set([...own, ...live].filter((x) => x.product !== "MF").map((x) => `${x.platform_key}|${x.product}`))];
    for (const g of groups) {
      const [pk, prod] = g.split("|");
      const hs = own.filter((h) => h.platform_key === pk && h.product === prod).sort((a, b) => (b.current_value || 0) - (a.current_value || 0));
      const pname = (hs[0] || live.find((s) => s.platform_key === pk && s.product === prod)).platform;
      const head = start("header");
      put(head, "header", { B: `${pname} · ${prod}` });
      const first = r;
      let n = 0;
      for (const h of hs) {
        const rr = start("item");
        schemeRows.set(rr, rowKey(h));
        put(rr, "item", { A: ++n, B: h.security_name || "", C: h._sub ?? (h.asset_class || ""), D: h.invested, F: h.quantity, G: h.current_value,
          J: { f: `G${rr}` }, K: h.xirr, L: h.return_pct ?? pct((h.current_value || 0) - (h.invested || 0), h.invested),
          O: sipBy.get(`${pk}|${prod}|${schemeKey(h)}`) || null, ...notes(h) });
      }
      const held = new Set(hs.map(schemeKey));
      for (const s of new Map(live.filter((x) => x.platform_key === pk && x.product === prod && !held.has(schemeKey(x))).map((x) => [schemeKey(x), x])).values()) {
        const rr = start("item");
        schemeRows.set(rr, rowKey(s));
        put(rr, "item", { A: ++n, B: s.security_name || "", O: sipBy.get(`${pk}|${prod}|${schemeKey(s)}`) || null, ...notes(s) });
      }
      const last = r - 1;
      const st = start("subTotal");
      folds.push({ id: `${pk}|${prod}`, head, first, last, total: st });
      const sum = (c) => ({ f: last >= first ? `SUM(${c}${first}:${c}${last})` : "0" });
      const value = hs.reduce((a, h) => a + (h.current_value || 0), 0), inv = hs.reduce((a, h) => a + (h.invested || 0), 0);
      put(st, "subTotal", { B: `TOTAL ${pname.toUpperCase()} ${prod.toUpperCase()} PORTFOLIO`, D: sum("D"), E: 0, G: sum("G"), H: 0,
        J: sum("J"), K: xirrOf(hs), L: pct(value - inv, inv), O: sum("O") });
      totals.push(st);
      start("subGap");
    }

    const gr = start("grand");
    const sumOf = (c) => ({ f: totals.length ? `SUM(${totals.map((t) => `${c}${t}`).join(",")})` : "0" });
    const value = own.reduce((a, h) => a + (h.current_value || 0), 0), inv = own.reduce((a, h) => a + (h.invested || 0), 0);
    put(gr, "grand", { B: `TOTAL PORTFOLIO OF ${client.name.toUpperCase()}`, D: sumOf("D"), G: sumOf("G"), J: sumOf("J"),
      K: xirrOf(own), L: pct(value - inv, inv), O: sumOf("O") });

    // Loans against securities are listed for reference only, never added to the total.
    const loans = holdings.filter((h) => h.product === LOANS);
    if (loans.length) {
      r++;
      put(start("header"), "header", { B: "Loans against securities (not included in the total above)" });
      for (const l of loans) put(start("item"), "item", { B: `${l.platform} · ${l.security_name || "Loan"}`, G: l.current_value });
    }
    sh.setMerges(merges);
    return { schemeRows, groups: folds };
  }

  // ---- Reviewer's edits -------------------------------------------------------------------
  // The review dashboard saves edits separately from the uploaded data (which is never changed):
  //   reviewDate, personal {mobile, email, occupation, dob, city, country, rm, years, level},
  //   schemes {rowKey: {excluded, type, subType, invested, quantity, current_value, xirr, sip,
  //            tenure, newSip, remarks, suggestions}},
  //   savings {key: {value, monthly}}, otherLabel, passive {key: amount},
  //   redemption {mf|stocks|other: {value, reason}}, notes.
  const rowKey = (r) => `${r.platform_key}|${r.product}|${schemeKey(r)}`;
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const NUM_FIELDS = ["invested", "quantity", "current_value", "xirr"];

  function applyEdits(holdings, sips, edits) {
    const sch = (edits && edits.schemes) || {};
    const marks = (e) => ({ _type: e.type || undefined, _sub: e.subType || undefined, _tenure: e.tenure, _newSip: num(e.newSip),
      _remarks: e.remarks, _suggest: e.suggestions });
    // A scheme held in several folios is one line on the dashboard; an edited total is shared
    // between its folios in proportion to what each held (equally when they held nothing).
    const groups = new Map();
    for (const h of holdings) { const k = rowKey(h); groups.set(k, [...(groups.get(k) || []), h]); }
    const share = (h, f, total) => {
      const g = groups.get(rowKey(h));
      if (f === "xirr" || g.length === 1) return total;
      const sum = g.reduce((a, r) => a + (r[f] || 0), 0);
      return sum ? total * ((h[f] || 0) / sum) : total / g.length;
    };
    const hs = [];
    for (const h of holdings) {
      const e = sch[rowKey(h)];
      if (!e) { hs.push(h); continue; }
      if (e.excluded) continue;
      const x = { ...h, ...marks(e) };
      let changed = false;
      for (const f of NUM_FIELDS) if (num(e[f]) !== undefined) { x[f] = share(h, f, num(e[f])); changed = changed || f !== "xirr"; }
      if (changed && x.invested) x.return_pct = round2((((x.current_value || 0) - x.invested) / x.invested) * 100);
      hs.push(x);
    }
    const ss = [];
    const replaced = new Set();
    for (const s of sips) {
      const k = rowKey(s), e = sch[k];
      if (!e) { ss.push(s); continue; }
      if (e.excluded) continue;
      if (num(e.sip) !== undefined && s.live) { replaced.add(k); continue; }
      ss.push({ ...s, ...marks(e) });
    }
    // A changed SIP amount replaces the scheme's live SIPs with one SIP of that amount.
    for (const [k, e] of Object.entries(sch)) {
      if (e.excluded || num(e.sip) === undefined || !num(e.sip)) continue;
      const ref = holdings.find((h) => rowKey(h) === k) || sips.find((s) => rowKey(s) === k);
      if (!ref) continue;
      ss.push({ platform: ref.platform, platform_key: ref.platform_key, product: ref.product, security_name: ref.security_name,
        isin: ref.isin, category: ref.category, monthly_amount: num(e.sip), sip_amount: num(e.sip), live: true, ...marks(e) });
    }
    return { holdings: hs, sips: ss };
  }

  // The client's data now (with edits) and as of each date anything was uploaded for.
  function prepare(data, edits = {}) {
    const rows = shareIsins([...data.holdings.map((r) => ({ ...r, _h: 1 })), ...data.sips]);
    const all = { holdings: rows.filter((r) => r._h), sips: rows.filter((r) => !r._h) };
    const at = (date) => figures(latestRows(all.holdings, data.uploads, date), latestRows(all.sips, data.uploads, date));
    const dates = [...new Set(data.uploads.map((u) => u.snapshot_date).filter(Boolean))].sort();
    const raw = { holdings: latestRows(all.holdings, data.uploads, null), sips: latestRows(all.sips, data.uploads, null) };
    const now = applyEdits(raw.holdings, raw.sips, edits);
    const current = figures(now.holdings, now.sips);
    // The latest date shows today's figures, edits included.
    const timeline = dates.map((date, i) => ({ date, f: i === dates.length - 1 ? current : at(date) }));
    const years = new Map();
    for (const t of timeline) years.set(Number(t.date.slice(0, 4)), t.f); // the last date of each year wins
    const allMf = [...new Set([...all.holdings, ...all.sips].filter((x) => x.product === "MF").map((x) => x.platform))];
    return { raw, now, current, timeline, years, allMf };
  }

  // Rows of Portfolio Journey for other savings (value row, monthly row) and passive income.
  const SAVINGS = [
    ["epf", "Employee Provident Fund (EPF)", 96, 97], ["gratuity", "Gratuity (expected amount)", 98, null],
    ["superannuation", "Superannuation", 100, 101], ["ppf", "Public Provident Fund (PPF)", 102, 103],
    ["fd", "Fixed Deposit (FD)", 104, 105], ["npsSelf", "NPS - Self", 106, 107], ["npsEmployer", "NPS - Employer", 108, 109],
    ["ulip", "ULIP", 110, 111], ["property", "Investment Property", 112, null], ["gold", "Gold as investment", 114, 115],
    ["insurance", "Traditional Insurance Policy", 116, 117], ["other", "Other Investments", 118, 119],
  ];
  const PASSIVE = [
    ["ipr1", "Investment Property 1 (rent)", 131], ["ipr2", "Investment Property 2 (rent)", 132], ["ipr3", "Investment Property 3 (rent)", 133],
    ["eps", "EPS pension", 134], ["superannuation", "Superannuation pension", 135], ["ip1", "Insurance Policy 1 pension", 136],
    ["ip2", "Insurance Policy 2 pension", 137], ["ip3", "Insurance Policy 3 pension", 138], ["dividend", "Average monthly dividend", 139],
    ["other", "Other passive income", 140],
  ];
  const REDEMPTION = [["mf", "Mutual funds", 66, 67], ["stocks", "Stocks", 91, 92], ["other", "Other savings", 122, 123]];
  const LEVELS = ["Level 1", "Level 2", "Level 3", "Level 4", "Level 5", "Level 6"];
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function fillEdits(sheets, edits, col) {
    const { journey, blueprint, discussion } = sheets;
    const p = edits.personal || {};
    const txt = (sh, ref, v) => { if (v !== undefined && v !== null && String(v).trim() !== "") sh.set(ref, String(v).trim()); };
    txt(blueprint, "G8", p.mobile); txt(blueprint, "I8", p.email); txt(blueprint, "M8", p.occupation);
    txt(blueprint, "I11", p.city); txt(blueprint, "K11", p.country); txt(blueprint, "M11", p.rm);
    if (ISO.test(p.dob || "")) blueprint.set("C11", serial(p.dob));
    if (num(p.years) !== undefined) blueprint.set("O14", num(p.years));
    if (LEVELS.includes(p.level)) blueprint.set("M160", p.level);
    const sv = edits.savings || {};
    if (edits.otherLabel) journey.set("B118", edits.otherLabel);
    for (const [k, , vr, mr] of SAVINGS) {
      if (num(sv[k]?.value) !== undefined) journey.set(`${col}${vr}`, num(sv[k].value));
      if (mr && num(sv[k]?.monthly) !== undefined) journey.set(`${col}${mr}`, num(sv[k].monthly));
    }
    // The blueprint's property and gold lines are typed in, not linked to the journey.
    if (num(sv.property?.value) !== undefined) blueprint.set("G68", num(sv.property.value));
    if (num(sv.gold?.value) !== undefined) blueprint.set("G70", num(sv.gold.value));
    for (const [k, , r] of PASSIVE) if (num((edits.passive || {})[k]) !== undefined) journey.set(`${col}${r}`, num(edits.passive[k]));
    for (const [k, , vr, rr] of REDEMPTION) {
      const x = (edits.redemption || {})[k] || {};
      if (num(x.value) !== undefined) journey.set(`${col}${vr}`, num(x.value));
      txt(journey, `${col}${rr}`, x.reason);
    }
    const lines = String(edits.notes || "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 38);
    lines.forEach((l, i) => discussion.set(`B${4 + i}`, l));
  }

  // ---- Public ----------------------------------------------------------------------------
  // data: the /api/review response; edits: the reviewer's saved changes. Returns the workbook as an
  // ArrayBuffer (or Node Buffer).
  // Columns of DETAILED PORTFOLIO the review page can change for a scheme, and the field each sets.
  const DETAIL_FIELDS = { C: "subType", D: "invested", F: "quantity", G: "current_value", K: "xirr", N: "tenure", O: "sip", P: "newSip",
    T: "remarks", U: "suggestions" };

  // Cells typed in on the review page: {sheet name: {A1: value}}. Formula cells and the scheme
  // rows of DETAILED PORTFOLIO (which follow the scheme edits instead) are left alone.
  function applyCells(sheets, cells) {
    for (const [name, refs] of Object.entries(cells || {})) {
      const sh = sheets[name];
      if (!sh || name === "DETAILED PORTFOLIO") continue;
      for (const [ref, v] of Object.entries(refs)) {
        const [c, r] = splitRef(ref);
        const x = sh.rows.get(r)?.cells.get(c);
        if (x && x.includes("<f")) continue;
        sh.set(ref, v === null ? "" : v);
      }
    }
  }

  // Adds cell styles to xl/styles.xml: copies of existing ones with another number format.
  async function cellStyles(zip) {
    let xml = await zip.file("xl/styles.xml").async("string");
    const m = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(xml);
    const xfs = [...m[1].matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((x) => x[0]);
    const start = xfs.length, made = new Map();
    const fmtOf = (id) => Number((/numFmtId="(\d+)"/.exec(xfs[id] || "") || [0, 0])[1]);
    let rupeeFmt = null;
    return {
      // Style `id` with the number format of style `ref` (the Live SIP column's ₹ format).
      rupee(id, ref) {
        if (rupeeFmt === null) rupeeFmt = fmtOf(Number(ref ?? -1)) || 165;
        const k = `${id}|${rupeeFmt}`;
        if (made.has(k)) return made.get(k);
        let x = xfs[Number(id)];
        if (!x) return id;
        x = x.replace(/\s(numFmtId|applyNumberFormat)="[^"]*"/g, "").replace(/^<xf\b/, `<xf numFmtId="${rupeeFmt}" applyNumberFormat="1"`);
        xfs.push(x);
        made.set(k, String(xfs.length - 1));
        return made.get(k);
      },
      save() {
        if (xfs.length === start) return;
        xml = xml.replace(m[0], `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>`);
        zip.file("xl/styles.xml", xml);
      },
    };
  }

  // The filled-in workbook as a JSZip, plus which DETAILED PORTFOLIO row holds which scheme.
  async function assemble(data, template, edits = data.edits || {}) {
    const zip = await JSZip.loadAsync(template);
    const paths = await sheetPaths(zip);
    const read = async (name) => new Sheet(await zip.file(paths[name]).async("string"));
    const write = (name, sh) => zip.file(paths[name], sh.toXml());
    const reviewDate = ISO.test(edits.reviewDate || "") ? edits.reviewDate : data.today;
    const client = { name: data.clientName, id: data.clientId };
    const { now, current, timeline, years, allMf } = prepare(data, edits);

    const cover = await read("1");
    cover.set("D17", client.name.toUpperCase());
    cover.set("Q5", serial(reviewDate));
    write("1", cover);

    const journey = await read("Portfolio Journey");
    const startYear = fillJourney(journey, years, current, reviewDate, allMf);

    const summary = await read("SUMMARY PORTFOLIO");
    fillSummaryPortfolio(summary, client.name.toUpperCase(), timeline);
    write("SUMMARY PORTFOLIO", summary);

    const detailed = await read("DETAILED PORTFOLIO");
    const styleBook = await cellStyles(zip);
    const { schemeRows, groups } = fillDetailed(detailed, client, now.holdings, now.sips, (id, ref) => styleBook.rupee(id, ref));
    styleBook.save();
    write("DETAILED PORTFOLIO", detailed);

    const blueprint = await read("Freedom Blueprint");
    const discussion = await read("Discussion");
    discussion.set("B3", reviewDate.split("-").reverse().join("-"));
    fillEdits({ journey, blueprint, discussion }, edits, colName(6 + Number(reviewDate.slice(0, 4)) - startYear));
    const others = { "1": cover, "Portfolio Journey": journey, "SUMMARY PORTFOLIO": summary, "Freedom Blueprint": blueprint, Discussion: discussion };
    for (const name of Object.keys(edits.cells || {})) {
      if (!others[name] && paths[name] && name !== "DETAILED PORTFOLIO") others[name] = await read(name);
    }
    applyCells(others, edits.cells);
    for (const [name, sh] of Object.entries(others)) write(name, sh);
    return { zip, schemeRows, groups };
  }

  async function build(data, template, { output = "arraybuffer", edits = data.edits || {} } = {}) {
    const { zip } = await assemble(data, template, edits);
    return zip.generateAsync({ type: output, compression: "DEFLATE" });
  }

  const fileName = (name, iso) => `Review Sheet of ${name.replace(/[\\/:*?"<>|]+/g, " ").trim()} as on ${iso.split("-").reverse().join("-")}.xlsx`;

  let templateCache = null;
  async function template() {
    if (!templateCache) {
      const r = await fetch(TEMPLATE_URL);
      if (!r.ok) throw new Error("The review sheet template could not be loaded.");
      templateCache = await r.arrayBuffer();
    }
    return templateCache;
  }

  // Build and download the workbook from data already loaded (and the edits on screen).
  async function exportFile(data, edits) {
    const buffer = await build(data, await template(), { edits });
    const date = ISO.test(edits.reviewDate || "") ? edits.reviewDate : data.today;
    window.download(xlsxBlob(buffer), fileName(data.clientName, date));
  }

  return { build, assemble, template, DETAIL_FIELDS, exportFile, prepare, figures, rowKey, typeOfRow, fileName, Sheet, mfType, subType, num,
    MF_TYPES, SAVINGS, PASSIVE, REDEMPTION, LEVELS, LOANS };
})();
globalThis.Review = Review;
