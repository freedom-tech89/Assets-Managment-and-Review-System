// Pull holdings (AUM files) or SIP registrations (SIP files) out of investment reports
// (Excel or PDF) into one standard row shape per kind.
//
// Platforms label their columns differently ("Units" vs "Qty", "Market Value" vs "Current
// Value", ...). Every table found in a file is scanned for a header row whose cells match the
// synonyms below; rows under that header become standard holdings.
(function () {
  const AUM_FIELDS = [
    "client_name", "client_id", "asset_class", "category", "security_name", "isin", "identifier", "quantity", "avg_cost",
    "invested", "current_price", "current_value", "gain_loss", "return_pct", "xirr", "as_of", "start_date", "end_date", "level",
  ];

  const CLIENT_SYNONYMS = {
    client_name: ["client name", "client", "investor name", "investor", "customer name", "customer",
      "account holder", "account holder name", "holder name", "first holder", "first holder name",
      "applicant name", "name of investor", "name of client", "beneficiary name"],
    client_id: ["client id", "client code", "ucc", "account no", "account number", "pan", "pan no",
      "investor id", "customer id", "dp id", "bo id", "demat account"],
  };

  const AUM_SYNONYMS = {
    client_name: ["client name", "client", "investor name", "investor", "customer name", "customer",
      "account holder", "account holder name", "holder name", "first holder", "first holder name",
      "applicant name", "name of investor", "name of client", "beneficiary name"],
    client_id: ["client id", "client code", "ucc", "account no", "account number", "pan", "pan no",
      "investor id", "customer id", "dp id", "bo id", "demat account"],
    category: ["asset class", "asset type", "category", "sub category", "instrument type", "type",
      "product", "product type", "product category"],
    security_name: ["security name", "security", "scheme name", "scheme", "fund name", "fund",
      "stock name", "stock", "instrument", "scrip name", "scrip", "company name", "company",
      "holding", "holdings", "description", "particulars", "name", "asset name", "investment", "strategy",
      "strategy name", "portfolio name", "bond name"],
    isin: ["isin", "isin code", "isin no"],
    identifier: ["symbol", "ticker", "scrip code", "trading symbol", "folio no", "folio number",
      "folio", "code"],
    quantity: ["quantity", "qty", "units", "balance units", "no of shares", "shares", "holding qty",
      "available qty", "closing units", "unit balance", "quantity available"],
    avg_cost: ["avg cost", "average cost", "avg price", "average price", "buy price", "purchase price",
      "cost price", "avg nav", "average nav", "purchase nav", "avg buy price", "average buy price", "avg cost price"],
    invested: ["invested amount", "invested value", "invested", "investment amount", "investment value",
      "amount invested", "cost value", "total cost", "purchase value", "buy value", "book value",
      "cost of acquisition", "cost", "inv cost", "investment cost", "purchase cost"],
    current_price: ["current price", "ltp", "market price", "current nav", "nav", "last price", "cmp",
      "close price", "closing price", "price", "closing nav", "latest nav", "latest price"],
    current_value: ["current value", "market value", "present value", "valuation", "current amount",
      "closing value", "mkt value", "value", "current market value", "market val", "total value",
      "closing balance", "curr value", "cur value", "outstanding", "outstanding amount", "loan outstanding",
      "principal outstanding", "loan amount", "nav value"],
    gain_loss: ["gain loss", "gain", "p l", "pnl", "unrealised p l", "unrealized p l", "unrealised gain",
      "unrealized gain", "profit loss", "returns", "absolute return", "notional gain", "net gain",
      "overall gain"],
    return_pct: ["gain %", "return %", "returns %", "p l %", "pnl %", "change %", "% change",
      "abs return %", "absolute return %", "net chg %", "% gain", "abs ret %"],
    xirr: ["xirr", "xirr %", "cagr", "cagr %", "annualised return", "annualized return", "irr"],
    as_of: ["as on", "as of", "valuation date", "nav date", "date", "price date"],
    start_date: ["start date", "investment date", "invested date", "inv date", "date of investment", "purchase date",
      "buy date", "first purchase date", "first investment date", "allotment date", "open date", "inception date"],
    end_date: ["end date", "maturity date", "maturity", "redemption date", "close date", "closing date", "expiry date",
      "lock in date", "lock in end date", "exit date"],
  };

  // Columns that look like a known field but mean something else.
  const AUM_IGNORE = new Set(["realised gain", "realized gain", "realised p l", "realized p l", "realised gain loss",
    "dividend", "dividend amount", "sch wgt %", "weight %", "weightage %", "avg days", "holding days",
    "sip date"]);

  const AUM_NUMERIC = new Set(["quantity", "avg_cost", "invested", "current_price", "current_value", "gain_loss", "return_pct", "xirr"]);

  // ---- SIP files: one row per SIP registration ------------------------------------------
  const SIP_FIELDS = ["client_name", "client_id", "asset_class", "security_name", "isin", "identifier", "sip_amount",
    "frequency", "sip_day", "start_date", "end_date", "status", "as_of"];

  const SIP_SYNONYMS = {
    ...CLIENT_SYNONYMS,
    security_name: ["scheme name", "scheme", "fund name", "fund", "security name", "security", "instrument",
      "product name", "particulars", "name", "stock name", "strategy", "strategy name", "plan name"],
    isin: ["isin", "isin code", "isin no"],
    identifier: ["folio no", "folio number", "folio", "sip reg no", "sip registration no", "registration no",
      "reg no", "sip id", "sip no", "umrn", "mandate id"],
    sip_amount: ["sip amount", "amount", "installment amount", "instalment amount", "sip installment",
      "sip instalment", "monthly sip", "sip value", "sip amt", "installment amt", "investment amount", "sip"],
    frequency: ["frequency", "sip frequency", "freq", "periodicity", "installment frequency"],
    sip_day: ["sip date", "sip day", "installment day", "instalment day", "debit date", "deduction date",
      "sip debit day", "installment date", "debit day", "ecs date", "ecs day"],
    start_date: ["start date", "sip start date", "from date", "registration date", "reg date", "start", "sip start"],
    end_date: ["end date", "sip end date", "to date", "end", "expiry date", "sip end", "cease date"],
    status: ["status", "sip status", "state", "registration status"],
    as_of: ["as on", "as of", "report date"],
  };
  const SIP_NUMERIC = new Set(["sip_amount"]);
  const SIP_IGNORE = new Set(["no of installments", "installments", "total installments", "pending installments",
    "installments paid", "units", "nav", "current value", "market value"]);

  const MONTHLY_FACTOR = { daily: 21, weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3,
    "half yearly": 1 / 6, yearly: 1 / 12, annual: 1 / 12 };

  function normFrequency(f) {
    const s = String(f || "").toLowerCase();
    if (!s) return "Monthly";
    if (/daily|day/.test(s)) return "Daily";
    if (/fortnight|bi-?week/.test(s)) return "Fortnightly";
    if (/week/.test(s)) return "Weekly";
    if (/quarter/.test(s)) return "Quarterly";
    if (/half|semi/.test(s)) return "Half Yearly";
    if (/year|annual/.test(s)) return "Yearly";
    return "Monthly";
  }

  const todayIso = () => new Date().toISOString().slice(0, 10);

  function completeSip(rec) {
    rec.frequency = normFrequency(rec.frequency);
    if (rec.sip_day !== null && rec.sip_day !== undefined) {
      const d = /^\d{4}-\d{2}-(\d{2})/.exec(String(rec.sip_day));
      const n = d ? Number(d[1]) : parseNumber(rec.sip_day);
      rec.sip_day = n && n >= 1 && n <= 31 ? Math.round(n) : null;
    }
    const st = String(rec.status || "").toLowerCase();
    if (/cease|cancel|stop|inactive|terminat|closed|expired|reject|fail|pause|discontinu|matured/.test(st)) rec.live = false;
    else if (/active|live|registered|running|approved|success|ongoing|confirmed/.test(st)) rec.live = true;
    else rec.live = !(rec.end_date && /^\d{4}-\d{2}-\d{2}$/.test(rec.end_date) && rec.end_date < todayIso());
    if (!rec.status) rec.status = rec.live ? "Active" : "Ended";
    rec.monthly_amount = rec.sip_amount !== null ? round(rec.sip_amount * (MONTHLY_FACTOR[rec.frequency.toLowerCase()] ?? 1), 2) : null;
    rec.asset_class = inferAssetClass(rec.security_name, rec.isin, rec.identifier, null);
    if (!rec.security_name) rec.security_name = rec.identifier || rec.isin;
    return rec;
  }

  const PROFILES = {
    aum: {
      fields: null, synonyms: null, ignore: null, numeric: null, dates: new Set(["as_of", "start_date", "end_date"]),
      nameFields: ["security_name", "identifier", "isin"], amountFields: ["quantity", "current_value", "invested", "current_price"],
      requiredAny: ["quantity", "current_value", "invested"], special: true, complete: null,
    },
    sip: {
      fields: SIP_FIELDS, synonyms: SIP_SYNONYMS, ignore: SIP_IGNORE, numeric: SIP_NUMERIC,
      dates: new Set(["as_of", "start_date", "end_date"]),
      nameFields: ["security_name", "identifier", "isin"], amountFields: ["sip_amount"],
      requiredAny: ["sip_amount"], special: false, complete: completeSip,
    },
  };
  let P = PROFILES.aum; // the kind of file currently being read
  const TOTAL_ROW = /^(grand\s+)?(sub\s*)?total\b|^net\s+total|^overall/i;
  // Bulk files often name the client in a heading line above each client's holdings,
  // e.g. "Investor: Ravi Kumar   PAN: ABCDE1234F".
  const CLIENT_HEADING = /^(?:client|investor|customer|account\s+holder|holder)(?:\s*name)?\s*[:\-–]\s*(.+?)(?:\s+(?:pan|client\s*(?:id|code)|ucc)(?:\s*no)?\s*[:\-–]\s*([A-Z0-9]+))?\s*$/i;
  // A statement that heads the page with the investor and PAN, e.g. "NAME: RAVI KUMAR (ABCDE1234F)".
  const NAME_PAN = /^(?:(?:client|investor|customer)?\s*name\s*[:\-–]\s*)?([A-Za-z][A-Za-z .'&-]{1,80}?)\s*\(\s*([A-Z]{5}[0-9]{4}[A-Z])\s*\)\s*$/;
  // Section titles after the holdings table: what follows is not current holdings.
  const SECTION_END = /\b(transactions?|txn|trxn|realised|realized|redeemed|redemptions?|past|closed|sold|switch(es)?|capital gains?|dividend history|stp|swp|cash ?flows?|sip details|sip summary|systematic)\b/i;
  const TXN_HEADER = /\b(transaction|txn|trxn|tran(s)? type|purchase type|redemption|switch in|switch out)\b/;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function norm(text) {
    let s = String(text ?? "").toLowerCase().replace(/&/g, " ").replace(/\//g, " ").replace(/\n/g, " ");
    s = s.includes("%") ? s.replace(/[()]/g, " ") : s.replace(/\(.*?\)/g, " ");
    s = s.replace(/[^a-z0-9% ]+/g, " ").replace(/\b(pct|percent|percentage)\b/g, "%");
    return s.split(/\s+/).filter(Boolean).join(" ");
  }

  function matchField(header) {
    const h = norm(header);
    if (!h || h.length > 60 || P.ignore.has(h)) return null;
    if (P.special) {
      if (/\b(xirr|cagr)\b/.test(h)) return "xirr";
      if (h.includes("%") && /gain|return|ret|rtn|p l|pnl|chg|change/.test(h) && !/annuali[sz]ed/.test(h)) return "return_pct";
    }
    let best = null, bestScore = 0;
    for (const [field, syns] of Object.entries(P.synonyms)) {
      for (const syn of syns) {
        let score;
        if (h === syn) score = 100 + syn.length;
        else if (new RegExp(`(^|\\s)${esc(syn)}(\\s|$)`).test(h)) score = syn.length;
        else continue;
        if (score > bestScore) { best = field; bestScore = score; }
      }
    }
    if (P.special && best === "return_pct" && !h.includes("%") && !h.includes("xirr")) best = "gain_loss";
    return best;
  }

  function parseNumber(value) {
    if (value === null || value === undefined || typeof value === "boolean") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    let s = String(value).trim();
    if (!s || ["-", "--", "—", "NA", "N/A", "nil"].includes(s)) return null;
    const negative = (s.startsWith("(") && s.endsWith(")")) || (s.endsWith("-") && s.length > 1);
    // "17.85 (16-10-2026)": a value with its date beside it.
    s = s.replace(/\(\s*\d{1,2}[-/.][A-Za-z0-9]{1,9}[-/.]\d{2,4}\s*\)/g, " ").trim();
    s = s.replace(/\b(rs|inr|usd|cr|dr)\b\.?/gi, "").replace(/−/g, "-").replace(/[^\d.\-eE]/g, "");
    if (!s || s === "-" || s === ".") return null;
    const num = Number(s);
    if (!Number.isFinite(num)) return null;
    return negative ? -Math.abs(num) : num;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, "0");

  function parseDate(value) {
    if (value instanceof Date && !isNaN(value)) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const s = String(value ?? "").trim();
    if (!s) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})[-/ ]([A-Za-z]{3,9}|\d{1,2})[-/ ](\d{2,4})$/.exec(s);
    if (m) {
      const mon = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2].slice(0, 3).toLowerCase()];
      let year = Number(m[3]);
      if (year < 100) year += 2000;
      if (mon) return `${year}-${pad(mon)}-${pad(Number(m[1]))}`;
    }
    return s;
  }

  // Map every holding onto one standard set of asset classes, whatever the platform calls it.
  function inferAssetClass(name, isin, symbol, category) {
    const n = `${name || ""} ${symbol || ""}`.toLowerCase();
    const i = (isin || "").toUpperCase();
    const sym = (symbol || "").toUpperCase();
    const c = (category || "").toLowerCase();
    if (/\bsgb|sovereign gold|gold bond/.test(n)) return "Gold";
    if (/\betf\b|bees\b/.test(n) || c.includes("etf")) return "ETF";
    if (/^INF[A-Z0-9]{9}$/.test(i) || /\b(fund|scheme|growth|idcw|dividend plan|direct plan|regular plan)\b/.test(n)) return "Mutual Fund";
    if (/\b(bond|debenture|ncd|g-sec|gsec|t-bill|treasury)\b/.test(n)) return "Debt";
    if (/\b(fd|fixed deposit)\b/.test(n) || /fixed deposit|\bfd\b/.test(c)) return "Fixed Deposit";
    if (/\bpms\b|portfolio management/.test(c)) return "PMS";
    if (/\baif\b|alternative investment/.test(c)) return "AIF";
    if (/insurance|ulip/.test(c) || /\bulip\b/.test(n)) return "Insurance";
    if (/\bnps\b|national pension/.test(c + " " + n)) return "NPS";
    if (/bond|debt|debenture|ncd/.test(c) && !c.includes("fund")) return "Debt";
    if (/\b(equity|stock|share)s?\b/.test(c) && !c.includes("fund") && !c.includes("mutual")) return "Equity";
    if (c.includes("mutual") || c.includes("fund")) return "Mutual Fund";
    if (/^INE[A-Z0-9]{9}$/.test(i) || /^[A-Z&-]{2,20}$/.test(sym || "-")) return "Equity";
    return category ? category.trim().replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Unclassified";
  }

  // Return {index, mapping: {col: field}} for the most convincing header row, or null.
  function findHeader(rows, maxScan = P.special ? 40 : 400) {
    // Holdings headers sit near the top; a statement's SIP table can come after its holdings.
    let best = null;
    rows.slice(0, maxScan).forEach((row, idx) => {
      const mapping = {}, used = new Set();
      row.forEach((cell, col) => {
        const field = matchField(cell);
        if (field && !used.has(field)) { mapping[col] = field; used.add(field); }
      });
      const hasName = P.nameFields.some((f) => used.has(f));
      const hasAmount = P.amountFields.some((f) => used.has(f));
      if (hasName && hasAmount && Object.keys(mapping).length >= 2 &&
          (!best || Object.keys(mapping).length > Object.keys(best.mapping).length)) {
        best = { index: idx, mapping };
      }
    });
    return best;
  }

  const blank = (c) => c === null || c === undefined || String(c).trim() === "";
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

  // Look for a client heading in a row; updates ctx and returns true if the row is one.
  function readHeading(row, ctx) {
    const cells = row.filter((c) => !blank(c)).map((c) => String(c).trim());
    const m = CLIENT_HEADING.exec(cells.join(" ")) || (cells.length && NAME_PAN.exec(cells[0].split(/\n/)[0].trim()));
    if (!m) return false;
    ctx.client = m[1].trim();
    ctx.clientId = m[2] || null;
    return true;
  }

  function scanHeadings(rows, ctx) {
    rows.forEach((r) => readHeading(r, ctx));
  }

  function rowsToHoldings(rows, mapping, start, ctx = {}) {
    const holdings = [];
    for (const row of rows.slice(start)) {
      // Blank rows are skipped rather than ending the table: bulk files often leave gaps
      // between one client's block and the next.
      if (row.every(blank)) continue;
      if (readHeading(row, ctx)) continue;
      const texts = row.filter((c) => !blank(c));
      // A section title ("Transaction Details", "Redeemed Schemes", ...) ends the holdings.
      if (texts.length <= 2 && texts.every((c) => typeof c === "string" && parseNumber(c) === null) && SECTION_END.test(texts.join(" "))) break;
      // Another header row: a table of transactions ends the holdings; anything else starts a
      // new table with its own columns.
      const fieldCells = row.filter((c) => typeof c === "string" && matchField(c)).length;
      if (fieldCells >= 3 && !row.some((c) => !blank(c) && !(c instanceof Date) && parseNumber(c) !== null)) {
        if (row.some((c) => typeof c === "string" && TXN_HEADER.test(norm(c)))) break;
        const next = findHeader([row]);
        if (next) { mapping = summaryMapping(row, next.mapping); continue; }
        break;
      }
      const rec = Object.fromEntries(P.fields.map((f) => [f, null]));
      for (const [col, field] of Object.entries(mapping)) {
        const val = row[col];
        if (blank(val)) continue;
        if (P.numeric.has(field)) rec[field] = parseNumber(val);
        else if (P.dates.has(field) || (field === "sip_day" && val instanceof Date)) rec[field] = parseDate(val);
        else rec[field] = String(val).split(/\s+/).filter(Boolean).join(" ");
      }
      if (mapping.summary) {
        // "Grand Total:" can sit in any column of an investor-wise report.
        if (!rec.client_name || row.some((c) => typeof c === "string" && TOTAL_ROW.test(c.trim()))) continue;
        rec.level = "summary"; rec.security_name = SUMMARY_LABEL;
      }
      const label = rec.security_name || rec.identifier || rec.isin || "";
      if (!label || TOTAL_ROW.test(label) || P.synonyms.security_name.includes(norm(label))) continue;
      if (!P.requiredAny.some((f) => rec[f] !== null)) continue;
      if (!rec.client_name && ctx.client) {
        rec.client_name = ctx.client;
        rec.client_id = rec.client_id || ctx.clientId;
      }
      holdings.push(P.complete(rec));
    }
    return holdings;
  }

  // An investor-wise AUM report has one row per investor (Name, PAN, Inv. Cost, Current Value)
  // and no schemes: its "Name" column is the investor, and each row is that investor's total.
  const SUMMARY_LABEL = "All schemes (investor total)";
  function summaryMapping(row, mapping) {
    if (P !== PROFILES.aum) return mapping;
    const fields = Object.values(mapping);
    const nameCol = Object.keys(mapping).find((c) => mapping[c] === "security_name");
    const head = nameCol !== undefined ? norm(row[nameCol]) : "";
    const investorWise = nameCol !== undefined && fields.includes("client_id") && !fields.includes("client_name")
      && /^(name|investor|investor name|client|client name|customer name)$/.test(head)
      && !["isin", "identifier", "quantity"].some((f) => fields.includes(f));
    if (!investorWise) return mapping;
    const m = { ...mapping, [nameCol]: "client_name" };
    Object.defineProperty(m, "summary", { value: true });
    return m;
  }

  // Fill fields that can be derived from the others.
  function complete(rec) {
    const q = rec.quantity;
    if (rec.invested === null && q !== null && rec.avg_cost !== null) rec.invested = round(q * rec.avg_cost, 2);
    if (rec.current_value === null && q !== null && rec.current_price !== null) rec.current_value = round(q * rec.current_price, 2);
    if (rec.avg_cost === null && q && rec.invested !== null) rec.avg_cost = round(rec.invested / q, 4);
    if (rec.current_price === null && q && rec.current_value !== null) rec.current_price = round(rec.current_value / q, 4);
    if (rec.gain_loss === null && rec.current_value !== null && rec.invested !== null) rec.gain_loss = round(rec.current_value - rec.invested, 2);
    if (rec.return_pct === null && rec.gain_loss !== null && rec.invested) rec.return_pct = round(rec.gain_loss / rec.invested * 100, 2);
    rec.asset_class = inferAssetClass(rec.security_name, rec.isin, rec.identifier, rec.category);
    if (!rec.security_name) rec.security_name = rec.identifier || rec.isin;
    return rec;
  }

  // Tables in document order. A table with no header continues the previous one.
  function tablesToHoldings(tables) {
    let holdings = [], last = null;
    const ctx = {};
    for (const rows of tables) {
      if (!rows.length) continue;
      const found = findHeader(rows);
      // A sheet without a header of its own (a classification sheet, a summary) is not holdings.
      if (!found) continue;
      last = summaryMapping(rows[found.index], found.mapping);
      scanHeadings(rows.slice(0, found.index), ctx);
      holdings = holdings.concat(rowsToHoldings(rows, last, found.index + 1, ctx));
    }
    return holdings;
  }

  function reportDate(texts) {
    const re = /(?:as\s+on|as\s+of|as\s+at|statement\s+date|valuation\s+date|report\s+date|holding\s+date)[:\s]*(\d{1,2}[-/ ][A-Za-z0-9]{2,9}[-/ ]\d{2,4}|\d{4}-\d{2}-\d{2})/i;
    for (const t of texts) {
      const m = re.exec(t);
      if (m) return parseDate(m[1]);
    }
    return null;
  }

  function applyReportDate(holdings, date) {
    if (date) holdings.forEach((h) => { h.as_of = h.as_of || date; });
  }

  // ---- Excel ------------------------------------------------------------------------------
  function extractExcel(buffer) {
    const wb = XLSX.read(buffer, { type: "array", cellDates: true });
    const tables = [], headerText = [], notes = [];
    for (const name of wb.SheetNames) {
      // A sheet of transactions repeats each scheme above its purchases; it is not holdings.
      if (/transaction|txn/i.test(name)) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      tables.push(rows);
      rows.slice(0, 15).forEach((r) => headerText.push(r.filter((c) => !blank(c)).join(" ")));
    }
    const holdings = tablesToHoldings(tables);
    applyReportDate(holdings, reportDate(headerText));
    if (wb.SheetNames.length > 1) notes.push(`${wb.SheetNames.length} sheets scanned`);
    return { holdings, notes };
  }

  // ---- PDF --------------------------------------------------------------------------------
  // PDFs have no real tables, only positioned text. Words are grouped into lines by their
  // vertical position, and into cells where the horizontal gap between words is large.
  function pageLines(items) {
    const words = items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 8 }));
    words.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const w of words) {
      const line = lines.find((l) => Math.abs(l.y - w.y) <= Math.max(2, w.h * 0.4));
      if (line) line.words.push(w);
      else lines.push({ y: w.y, words: [w] });
    }
    return lines.map((l) => {
      l.words.sort((a, b) => a.x - b.x);
      const cells = [];
      for (const w of l.words) {
        const prev = cells[cells.length - 1];
        const gap = prev ? w.x - prev.x1 : Infinity;
        if (prev && gap < w.h * 0.9) {
          prev.text += (gap > w.h * 0.15 ? " " : "") + w.text;
          prev.x1 = w.x + w.w;
        } else {
          cells.push({ text: w.text, x0: w.x, x1: w.x + w.w });
        }
      }
      cells.forEach((c) => { c.text = c.text.trim(); });
      return cells;
    });
  }

  // Put each cell of a line under the header column it overlaps most (or sits closest to).
  function alignToColumns(cells, columns) {
    const row = new Array(columns.length).fill(null);
    for (const c of cells) {
      let bestCol = -1, bestScore = -Infinity;
      columns.forEach((col, i) => {
        const overlap = Math.min(c.x1, col.x1) - Math.max(c.x0, col.x0);
        const dist = Math.abs((c.x0 + c.x1) / 2 - (col.x0 + col.x1) / 2);
        const score = overlap > 0 ? 1000 + overlap : -dist;
        if (score > bestScore) { bestScore = score; bestCol = i; }
      });
      row[bestCol] = row[bestCol] === null ? c.text : `${row[bestCol]} ${c.text}`;
    }
    return row;
  }

  async function extractPdf(buffer, password) {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer), password: password || undefined });
    const pdf = await loadingTask.promise;
    const notes = [], texts = [];
    let columns = null, mapping = null, holdings = [];
    const ctx = {};
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const lines = pageLines(content.items);
      texts.push(lines.map((cells) => cells.map((c) => c.text).join(" ")).join("\n"));
      // Line by line, so a new header (e.g. repeated for each client) re-sets the columns
      // and a client heading applies to the lines after it.
      for (const cells of lines) {
        const raw = cells.map((c) => c.text);
        const header = findHeader([raw]);
        if (header) {
          columns = cells;
          mapping = header.mapping;
        } else if (!readHeading(raw, ctx) && columns) {
          holdings = holdings.concat(rowsToHoldings([alignToColumns(cells, columns)], mapping, 0, ctx));
        }
      }
    }
    if (!texts.some((t) => t.trim())) notes.push("PDF has no text layer (scanned image); holdings could not be read");
    applyReportDate(holdings, reportDate(texts.slice(0, 2)));
    return { holdings, notes };
  }

  Object.assign(PROFILES.aum, { fields: AUM_FIELDS, synonyms: AUM_SYNONYMS, ignore: AUM_IGNORE, numeric: AUM_NUMERIC, complete });

  // kind: "aum" (holdings) or "sip" (SIP registrations). Returns { holdings, notes }; for SIP
  // files the rows are SIP records.
  async function extract(buffer, format, password, kind = "aum") {
    P = PROFILES[kind] || PROFILES.aum;
    return format === "pdf" ? extractPdf(buffer, password) : extractExcel(buffer);
  }

  const matchFieldFor = (header, kind = "aum") => { P = PROFILES[kind]; return matchField(header); };

  window.Extract = { extract, matchField: matchFieldFor, parseNumber };
})();
