// HTTP API, shared by the Vercel function (api/index.js) and the local server (server.js).
//
// Every upload is one AUM or SIP file for one platform + product (MF, Stocks, PMS, ...), sent
// either client wise (one client) or platform wise (many clients). Nothing is overwritten: each
// upload is stored as the next dated version, and dashboards read the latest version for each
// client + platform + product (the current_holdings / current_sips views).
import { db, query, PRODUCTS } from "./db.js";
import { checkPassword, clearCookie, isLoggedIn, sessionCookie, usingDefaultPassword, adminPassword } from "./auth.js";

export const MAX_FILE_BYTES = 4 * 1024 * 1024; // Vercel functions accept request bodies up to 4.5 MB
const UNASSIGNED = "Unassigned";
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const LOANS = "LAS"; // loans against securities: shown on their own, never added to AUM
const FORMATS = new Set(["pdf", "xlsx", "xls"]);
const HOLDING_FIELDS = ["client_id", "asset_class", "category", "security_name", "isin", "identifier", "quantity",
  "avg_cost", "invested", "current_price", "current_value", "gain_loss", "return_pct", "xirr", "as_of", "start_date", "end_date", "level"];
const SIP_FIELDS = ["client_id", "asset_class", "security_name", "isin", "identifier", "sip_amount", "monthly_amount",
  "frequency", "sip_day", "start_date", "end_date", "status", "live", "as_of"];
// Asset class to use when a file gives none that can be recognised.
const DEFAULT_ASSET = { MF: "Mutual Fund", Stocks: "Equity", PMS: "PMS", AIF: "AIF", Bonds: "Debt", LAS: "Loan", Other: "Other" };
const NUMERIC = new Set(["quantity", "avg_cost", "invested", "current_price", "current_value", "gain_loss", "return_pct",
  "xirr", "sip_amount", "monthly_amount"]);

const key = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).join(" ").toLowerCase();
const tidy = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).join(" ");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (Buffer.isBuffer(body)) return res.end(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function rawBody(req, limit) {
  // Vercel may have read the body already and exposes it as req.body.
  if (req.body !== undefined && req.body !== null) {
    const b = req.body;
    if (Buffer.isBuffer(b)) return b;
    if (typeof b === "string") return Buffer.from(b);
    if (b instanceof Uint8Array) return Buffer.from(b);
    return Buffer.from(JSON.stringify(b));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const buf = await rawBody(req, 8 * 1024 * 1024);
  try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { throw new HttpError(400, "Invalid JSON."); }
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (gain, inv) => (inv ? (gain / inv) * 100 : null);
function product(p) {
  const found = PRODUCTS.find((x) => x.toLowerCase() === key(p));
  if (!found) throw new HttpError(400, `Unknown category "${p}".`);
  return found;
}

// ---- Uploads ----------------------------------------------------------------------------
function uploadOut(r) {
  return {
    id: r.id, uploadType: r.upload_type, clientName: r.client_name, platform: r.platform, product: r.product,
    kind: r.kind, version: r.version, snapshotDate: r.snapshot_date, batchId: r.batch_id,
    originalName: r.original_name, format: r.file_format, size: r.size_bytes, status: r.status, notes: r.notes,
    rowsCount: r.holdings_count, clientsCount: r.clients_count, uploadedAt: r.uploaded_at_text,
    hasFile: r.has_file, current: r.is_current,
  };
}

const UPLOAD_COLS = `u.id, u.upload_type, u.client_name, u.platform, u.product, u.kind, u.version, u.snapshot_date, u.batch_id,
  u.original_name, u.file_format, u.size_bytes, u.status, u.notes, u.holdings_count, u.clients_count,
  to_char(u.uploaded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS uploaded_at_text,
  (u.file_data IS NOT NULL) AS has_file,
  (EXISTS (SELECT 1 FROM current_holdings c WHERE c.upload_id = u.id)
    OR EXISTS (SELECT 1 FROM current_sips c WHERE c.upload_id = u.id)) AS is_current`;

// Upload history, newest first, optionally narrowed to a client, platform, product or batch.
async function listUploads(params) {
  const where = [], args = [];
  const add = (v, sql) => { args.push(v); where.push(sql(`$${args.length}`)); };
  if (params.get("client")) add(key(params.get("client")), (p) => `(u.client_key = ${p} OR u.id IN
    (SELECT upload_id FROM holdings WHERE client_key = ${p} UNION SELECT upload_id FROM sips WHERE client_key = ${p}))`);
  if (params.get("platform")) add(key(params.get("platform")), (p) => `u.platform_key = ${p}`);
  if (params.get("product")) add(product(params.get("product")), (p) => `u.product = ${p}`);
  if (params.get("batch")) add(params.get("batch"), (p) => `u.batch_id = ${p}`);
  const limit = Math.min(Number(params.get("limit")) || 200, 1000);
  const rows = (await query(`SELECT ${UPLOAD_COLS} FROM uploads u ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY u.id DESC LIMIT ${limit}`, args)).rows;
  return rows.map(uploadOut);
}

// Date the data is "as of": what the caller sent, else the most common date in the rows, else today.
function snapshotDate(given, rows) {
  if (ISO.test(given || "")) return given;
  const counts = {};
  rows.forEach((r) => { if (ISO.test(r.as_of || "")) counts[r.as_of] = (counts[r.as_of] || 0) + 1; });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0];
  return best ? best[0] : todayIst();
}

function cleanRow(src, fields) {
  const r = {};
  fields.forEach((f) => {
    const v = src[f];
    if (f === "live") r[f] = v !== false;
    else if (f === "sip_day") r[f] = v !== null && v !== "" && Number.isInteger(Number(v)) ? Number(v) : null;
    else r[f] = NUMERIC.has(f) ? num(v) : v === null || v === undefined || v === "" ? null : String(v).slice(0, 300);
  });
  return r;
}

function groupRows(list) {
  const m = new Map();
  for (const r of list) { if (!m.has(r.client_key)) m.set(r.client_key, []); m.get(r.client_key).push(r); }
  return m;
}

async function createUpload(body) {
  const uploadType = body.uploadType === "individual" ? "client" : body.uploadType;
  if (!["client", "platform"].includes(uploadType)) throw new HttpError(400, "Choose Client Wise or Platform Wise.");
  const kind = body.kind === "sip" ? "sip" : "aum";
  const prod = product(body.product || "Other");
  const platform = tidy(body.platform);
  const clientName = uploadType === "client" ? tidy(body.clientName) : "";
  if (!platform) throw new HttpError(400, "Choose the investment platform.");
  if (uploadType === "client" && !clientName) throw new HttpError(400, "Enter the client name.");
  const originalName = String(body.originalName || "").split(/[\\/]/).pop().slice(0, 200);
  if (!originalName || !FORMATS.has(body.format)) throw new HttpError(400, "Only Excel (.xlsx, .xls) or PDF files can be uploaded.");
  const size = Number(body.size) || 0;
  if (size > MAX_FILE_BYTES) throw new HttpError(413, `Files must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller.`);
  const input = Array.isArray(body.rows) ? body.rows : Array.isArray(body.holdings) ? body.holdings : [];
  const sha = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : null;
  const batchId = body.batchId ? String(body.batchId).slice(0, 60) : null;

  // The same file for the same client/platform + product + kind is refused; anything else is a new version.
  const scopeSql = uploadType === "client"
    ? "upload_type = 'client' AND client_key = $1 AND platform_key = $2 AND product = $3 AND kind = $4"
    : "upload_type = 'platform' AND client_key = $1 AND platform_key = $2 AND product = $3 AND kind = $4";
  const scopeArgs = [key(clientName), key(platform), prod, kind];
  if (sha) {
    const dup = (await query(`SELECT original_name, version, snapshot_date FROM uploads WHERE ${scopeSql} AND sha256 = $5`,
      [...scopeArgs, sha])).rows[0];
    if (dup) throw new HttpError(409, `Already uploaded as version ${dup.version} ("${dup.original_name}", data as of ${dup.snapshot_date}).`);
  }

  const fields = kind === "sip" ? SIP_FIELDS : HOLDING_FIELDS;
  const table = kind === "sip" ? "sips" : "holdings";
  // PANs tie the same person together across Client Wise and Platform Wise files, and give a name
  // to rows whose file has only the PAN. Only PANs that belong to exactly one client count, from
  // clients with few PANs, so a bulk file once saved under one client can't pull everyone in.
  const panOf = (v) => { const p = String(v || "").replace(/\s+/g, "").toUpperCase(); return PAN.test(p) ? p : null; };
  const pairs = (await query(`SELECT DISTINCT pan, client_key, client_name FROM (
      SELECT coalesce(pan, upper(client_id)) AS pan, client_key, client_name FROM current_holdings
      UNION ALL SELECT coalesce(pan, upper(client_id)), client_key, client_name FROM current_sips) x
    WHERE pan IS NOT NULL AND client_key <> $1`, [key(UNASSIGNED)])).rows.filter((r) => PAN.test(r.pan));
  const perClient = new Map(), perPan = new Map();
  for (const r of pairs) {
    perClient.set(r.client_key, (perClient.get(r.client_key) || new Set()).add(r.pan));
    perPan.set(r.pan, (perPan.get(r.pan) || new Map()).set(r.client_key, r.client_name));
  }
  const known = new Map();
  for (const [p, m] of perPan) if (m.size === 1 && perClient.get([...m.keys()][0]).size <= 3) known.set(p, [...m.values()][0]);
  const inFile = new Map(); // PAN -> name, for files that name the client on only some rows
  for (const h of input) { const p = panOf(h.client_id); if (p && tidy(h.client_name) && !inFile.has(p)) inFile.set(p, tidy(h.client_name)); }
  const whoIs = (h) => { const p = panOf(h.client_id); return tidy(h.client_name) || (p && (inFile.get(p) || known.get(p))) || ""; };

  let source = input.slice(0, 20000);
  let clientLabel = clientName;
  if (uploadType === "client") {
    // A file holding several clients keeps only this client's rows.
    const people = new Set(source.map((h) => key(whoIs(h))).filter(Boolean));
    if (people.size > 1) {
      const pans = new Set([...known].filter(([, n]) => key(n) === key(clientName)).map(([p]) => p));
      source = source.filter((h) => key(whoIs(h)) === key(clientName) || pans.has(panOf(h.client_id)));
      if (!source.length) throw new HttpError(400, `This file holds ${people.size} clients and none of them is ${clientName}. Upload it Platform Wise instead.`);
    }
    // The client already has a name under this PAN: keep using it.
    const pans = [...new Set(source.map((h) => panOf(h.client_id)).filter(Boolean))];
    if (pans.length === 1 && known.get(pans[0])) clientLabel = known.get(pans[0]);
  }
  // A client is name + PAN: the same name under a different PAN is someone else, kept apart as
  // "Name (PAN)". A row without a PAN takes the client's PAN when the client has just one.
  const onlyPan = (k) => { const ps = perClient.get(k); return ps && ps.size === 1 ? [...ps][0] : null; };
  // The same name with different PANs in one file is different people too.
  const filePans = new Map();
  if (uploadType === "platform") {
    for (const h of source) {
      const k = key(whoIs(h));
      if (k) filePans.set(k, (filePans.get(k) || new Set()).add(panOf(h.client_id) || ""));
    }
  }
  let rows = source.map((h) => {
    let client = uploadType === "client" ? clientLabel : whoIs(h) || UNASSIGNED;
    let pan = panOf(h.client_id);
    const theirs = perClient.get(key(client));
    if (pan && client !== UNASSIGNED && ((filePans.get(key(client))?.size || 0) > 1 || (theirs && theirs.size && !theirs.has(pan)))) {
      client = `${client} (${pan})`;
    }
    if (!pan && client !== UNASSIGNED) pan = onlyPan(key(client));
    const r = { client_name: client, client_key: key(client), pan, platform, platform_key: key(platform), product: prod, ...cleanRow(h, fields) };
    // A PMS, AIF or bond file is never a mutual fund, whatever the scheme name suggests.
    if (!r.asset_class || r.asset_class === "Unclassified" || (prod !== "MF" && r.asset_class === "Mutual Fund")
      || prod === LOANS) r.asset_class = DEFAULT_ASSET[prod];
    return r;
  });

  // A client whose rows match what the dashboard already shows for this platform and category is
  // left as it is; only clients whose data changed get the new rows.
  const keys = [...new Set(rows.map((r) => r.client_key))];
  const unchanged = new Set();
  if (keys.length) {
    const cur = (await query(`SELECT client_key, ${fields.join(", ")} FROM current_${table}
      WHERE platform_key = $1 AND product = $2 AND client_key = ANY($3)`, [key(platform), prod, keys])).rows;
    const sig = (list) => list.map((r) => JSON.stringify(fields.filter((f) => f !== "as_of")
      .map((f) => (typeof r[f] === "number" ? Math.round(r[f] * 100) / 100 : r[f] ?? null)))).sort().join("\n");
    const before = groupRows(cur), after = groupRows(rows);
    for (const k of keys) if (before.has(k) && sig(before.get(k)) === sig(after.get(k))) unchanged.add(k);
  }
  const unchangedClients = unchanged.size;
  rows = rows.filter((r) => !unchanged.has(r.client_key));
  if (!rows.length && input.length) {
    return { id: null, unchanged: true, unchangedClients, rowsCount: 0, clientsCount: 0,
      message: "Nothing changed: the dashboard already has this data." };
  }
  const clientsCount = new Set(rows.filter((r) => r.client_name !== UNASSIGNED).map((r) => r.client_key)).size;
  const snap = snapshotDate(body.snapshotDate, rows);

  const conn = await db();
  return conn.transaction(async (tx) => {
    const prev = (await tx.query(`SELECT COALESCE(MAX(version), 0)::int AS v FROM uploads WHERE ${scopeSql}`, scopeArgs)).rows[0].v;
    const up = (await tx.query(
      `INSERT INTO uploads (upload_type, client_name, client_key, platform, platform_key, product, kind, version, snapshot_date,
         batch_id, original_name, file_format, file_type, size_bytes, sha256, status, notes, holdings_count, clients_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [uploadType, clientName, key(clientName), platform, key(platform), prod, kind, prev + 1, snap, batchId,
        originalName, body.format, String(body.fileType || "application/octet-stream").slice(0, 100), size, sha,
        String(body.status || "Processed").slice(0, 40), String(body.notes || "").slice(0, 1000), rows.length, clientsCount])).rows[0];
    const cols = ["upload_id", "client_name", "client_key", "pan", "platform", "platform_key", "product", ...fields];
    for (let i = 0; i < rows.length; i += 200) {
      const values = [], params = [];
      rows.slice(i, i + 200).forEach((r) => {
        const vals = [up.id, r.client_name, r.client_key, r.pan, r.platform, r.platform_key, r.product, ...fields.map((f) => r[f])];
        values.push(`(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`);
      });
      await tx.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")}`, params);
    }
    // Rows saved earlier as Unassigned now belong to the client this file names for their PAN.
    const named = new Map();
    for (const r of rows) { if (r.pan && r.client_key !== key(UNASSIGNED)) named.set(r.pan, r); }
    for (const [p, r] of named) {
      for (const t of ["holdings", "sips"]) {
        await tx.query(`UPDATE ${t} SET client_name = $1, client_key = $2, pan = $4
          WHERE client_key = $3 AND (pan = $4 OR upper(client_id) = $4)`, [r.client_name, r.client_key, key(UNASSIGNED), p]);
        // Earlier rows of this client saved without a PAN now carry it.
        await tx.query(`UPDATE ${t} SET pan = $2 WHERE client_key = $1 AND pan IS NULL`, [r.client_key, p]);
      }
    }
    return { id: up.id, version: prev + 1, isNew: prev === 0, snapshotDate: snap, rowsCount: rows.length, clientsCount, unchangedClients };
  });
}

// ---- Platforms (the rows of the upload matrix) ------------------------------------------
async function platforms() {
  return (await query(`SELECT id, name, product FROM platforms ORDER BY sort_order, id`)).rows;
}

async function addPlatform(body) {
  const name = tidy(body.name).slice(0, 80);
  const prod = product(body.product);
  if (!name) throw new HttpError(400, "Enter the platform name.");
  const r = await query(`INSERT INTO platforms (name, name_key, product, sort_order)
    VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platforms)) ON CONFLICT DO NOTHING RETURNING id`,
  [name, key(name), prod]);
  if (!r.rows.length) throw new HttpError(409, `${name} is already listed under ${prod}.`);
  return { id: r.rows[0].id };
}

// ---- Dashboards -------------------------------------------------------------------------
const SUMS = `COUNT(*)::int AS holdings, COALESCE(SUM(invested),0) AS invested, COALESCE(SUM(current_value),0) AS current_value,
  COALESCE(SUM(gain_loss),0) AS gain_loss, MAX(as_of) AS as_of,
  SUM(xirr * current_value) / NULLIF(SUM(CASE WHEN xirr IS NOT NULL THEN current_value END), 0) AS xirr`;
const SIP_SUMS = `COUNT(*)::int AS sips, (COUNT(*) FILTER (WHERE live))::int AS live_sips,
  COALESCE(SUM(monthly_amount) FILTER (WHERE live), 0) AS sip_monthly`;
const IS_LOAN = `product = '${LOANS}'`;
const NOT_LOAN = `product <> '${LOANS}'`;
const BOTH = `(SELECT upload_id, client_key, client_name, client_id, platform, platform_key, product FROM current_holdings
  UNION ALL SELECT upload_id, client_key, client_name, client_id, platform, platform_key, product FROM current_sips) x`;
const EMPTY = { holdings: 0, invested: 0, current_value: 0, gain_loss: 0, as_of: null, xirr: null, return_pct: null,
  sips: 0, live_sips: 0, sip_monthly: 0, loan_value: 0 };

const withReturn = (r) => ({ ...r, return_pct: pct(r.gain_loss, r.invested) });

// WHERE clause from a scope ({client_key, platform_key, product}) plus extra conditions.
function where(scope, extra = []) {
  const parts = [...extra], args = [];
  for (const [col, v] of Object.entries(scope)) {
    if (v === undefined || v === null || v === "") continue;
    args.push(v);
    parts.push(`${col} = $${args.length}`);
  }
  return { sql: parts.length ? "WHERE " + parts.join(" AND ") : "", args };
}

async function select(cols, from, scope, extra, by) {
  const w = where(scope, extra);
  return (await query(`SELECT ${by ? by.join(", ") + ", " : ""}${cols} FROM ${from} ${w.sql}${by ? " GROUP BY " + by.join(", ") : ""}`, w.args)).rows;
}

// Holdings, loans and SIPs of a scope, summed per group (e.g. per platform). With splitLoans,
// LAS rows go to loan_value instead of the AUM sums.
async function grouped(scope, by, splitLoans = true) {
  const base = await select(`MIN(platform) AS platform, MIN(client_name) AS client_name, MAX(client_id) AS client_id,
    COUNT(DISTINCT client_key)::int AS clients, COUNT(DISTINCT platform_key)::int AS platform_count,
    string_agg(DISTINCT product, ',') AS products, string_agg(DISTINCT platform, ', ') AS platform_names`, BOTH, scope, [], by);
  const h = await select(SUMS, "current_holdings", scope, splitLoans ? [NOT_LOAN] : [], by);
  const l = splitLoans ? await select("COALESCE(SUM(current_value),0) AS loan_value", "current_holdings", scope, [IS_LOAN], by) : [];
  const s = await select(SIP_SUMS, "current_sips", scope, [], by);
  const id = (r) => by.map((c) => r[c]).join("|");
  const m = new Map(base.map((r) => [id(r), { ...EMPTY, ...r, products: (r.products || "").split(",").filter(Boolean) }]));
  for (const r of [...h.map(withReturn), ...l, ...s]) Object.assign(m.get(id(r)) || {}, r);
  return [...m.values()].sort((a, b) => b.current_value - a.current_value || b.sip_monthly - a.sip_monthly || b.loan_value - a.loan_value);
}

async function overview(scope) {
  const [tot] = await select(SUMS, "current_holdings", scope, [NOT_LOAN]);
  const [loans] = await select("COUNT(*)::int AS n, COALESCE(SUM(current_value),0) AS v", "current_holdings", scope, [IS_LOAN]);
  const [sip] = await select(SIP_SUMS, "current_sips", scope, []);
  const [cnt] = await select(`COUNT(DISTINCT client_key)::int AS clients, COUNT(DISTINCT platform_key)::int AS platforms`, BOTH, scope, []);
  const [files] = await select(`COUNT(DISTINCT upload_id)::int AS n`, `(SELECT upload_id, client_key, platform_key, product FROM holdings
    UNION SELECT upload_id, client_key, platform_key, product FROM sips) y`, scope, []);
  const products = (await grouped(scope, ["product"], false))
    .map((p) => (p.product === LOANS ? { ...p, loan_value: p.current_value } : p))
    .sort((a, b) => PRODUCTS.indexOf(a.product) - PRODUCTS.indexOf(b.product));
  const assets = (await select(SUMS, "current_holdings", scope, [NOT_LOAN], ["COALESCE(asset_class,'Unclassified')"]))
    .map((r) => withReturn({ ...r, name: r.coalesce })).sort((a, b) => b.current_value - a.current_value);
  return {
    total: { ...withReturn(tot), ...sip, clients: cnt.clients, platforms: cnt.platforms, files: files.n, loans: loans.v, loan_rows: loans.n },
    products, platforms: await grouped(scope, ["platform_key"]), assets,
  };
}

async function recentBatches(limit = 8) {
  const rows = (await query(`SELECT COALESCE(batch_id, 'u' || id) AS batch, MIN(upload_type) AS upload_type,
      MAX(client_name) AS client_name, string_agg(DISTINCT platform, ', ') AS platforms, string_agg(DISTINCT product, ',') AS products,
      COUNT(*)::int AS files, (COUNT(*) FILTER (WHERE version = 1))::int AS new_files,
      mode() WITHIN GROUP (ORDER BY snapshot_date) AS snapshot_date,
      to_char(MAX(uploaded_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS uploaded_at, SUM(holdings_count)::int AS rows
    FROM uploads GROUP BY 1 ORDER BY MAX(id) DESC LIMIT ${limit}`)).rows;
  return rows.map((r) => ({ ...r, products: (r.products || "").split(",").filter(Boolean) }));
}

async function dashboard() {
  return { ...(await overview({})), recent: await recentBatches(), clients: await grouped({}, ["client_key"]) };
}

// Dashboard for one platform, one product (category), or both.
async function scopeDashboard(params) {
  const scope = {};
  if (params.get("platform")) scope.platform_key = key(params.get("platform"));
  if (params.get("product")) scope.product = product(params.get("product"));
  if (!Object.keys(scope).length) throw new HttpError(400, "platform or product is required");
  const o = await overview(scope);
  if (!o.total.clients) throw new HttpError(404, "No data uploaded here yet.");
  const name = scope.platform_key
    ? (await query(`SELECT platform FROM uploads WHERE platform_key = $1 ORDER BY id DESC LIMIT 1`, [scope.platform_key])).rows[0]
    : null;
  const history = await listUploads(new URLSearchParams(Object.entries({
    platform: params.get("platform") || "", product: scope.product || "", limit: "100" }).filter(([, v]) => v)));
  return { ...o, platformName: name ? name.platform : null, product: scope.product || null,
    clients: await grouped(scope, ["client_key"]), history };
}

// Prefer a PAN, then any ID from an investment (not loan) file.
function clientIdOf(rows) {
  const ids = rows.filter((r) => r.client_id).sort((a, b) => Number(a.product === LOANS) - Number(b.product === LOANS)).map((r) => r.client_id);
  return ids.find((id) => /^[A-Z]{5}\d{4}[A-Z]$/i.test(id)) || ids[0] || null;
}

async function clientDashboard(name) {
  const ck = key(name);
  const holdings = (await query(`SELECT h.*, u.original_name, u.version, u.snapshot_date
    FROM current_holdings h JOIN uploads u ON u.id = h.upload_id WHERE h.client_key = $1
    ORDER BY h.product, h.platform, h.asset_class, h.security_name`, [ck])).rows;
  const sips = (await query(`SELECT s.*, u.original_name, u.version, u.snapshot_date
    FROM current_sips s JOIN uploads u ON u.id = s.upload_id WHERE s.client_key = $1
    ORDER BY s.live DESC, s.product, s.platform, s.security_name`, [ck])).rows;
  if (!holdings.length && !sips.length) throw new HttpError(404, "No data for this client yet.");
  const scope = { client_key: ck };
  const o = await overview(scope);
  const first = holdings[0] || sips[0];

  // Platform + product rows, each with the version and date currently shown.
  const pp = await grouped(scope, ["platform_key", "product"], false);
  const versions = (await query(`SELECT x.platform_key, x.product, MAX(u.version) AS version, MAX(u.snapshot_date) AS snapshot_date
    FROM ${BOTH} JOIN uploads u ON u.id = x.upload_id WHERE x.client_key = $1 GROUP BY 1, 2`, [ck])).rows;
  pp.forEach((r) => Object.assign(r, versions.find((v) => v.platform_key === r.platform_key && v.product === r.product) || {}));

  // Every upload that ever held this client's data, with this client's figures in it.
  const history = (await query(`SELECT u.id, u.upload_type, u.platform, u.product, u.kind, u.version, u.snapshot_date, u.original_name,
      to_char(u.uploaded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS uploaded_at, x.rows, x.value, x.monthly,
      (EXISTS (SELECT 1 FROM current_holdings c WHERE c.upload_id = u.id AND c.client_key = $1)
        OR EXISTS (SELECT 1 FROM current_sips c WHERE c.upload_id = u.id AND c.client_key = $1)) AS current
    FROM uploads u JOIN (
      SELECT upload_id, COUNT(*)::int AS rows, COALESCE(SUM(current_value),0) AS value, NULL::float8 AS monthly
        FROM holdings WHERE client_key = $1 GROUP BY upload_id
      UNION ALL
      SELECT upload_id, COUNT(*)::int, NULL::float8, COALESCE(SUM(monthly_amount) FILTER (WHERE live),0)
        FROM sips WHERE client_key = $1 GROUP BY upload_id
    ) x ON x.upload_id = u.id ORDER BY u.id DESC`, [ck])).rows;

  const strip = (r, fields) => ({ id: r.id, client_name: r.client_name, platform: r.platform, product: r.product,
    ...Object.fromEntries(fields.map((f) => [f, r[f]])), source_file: r.original_name, version: r.version, snapshot_date: r.snapshot_date });
  return {
    ...o, clientName: first.client_name, clientId: clientIdOf([...holdings, ...sips]),
    platformProducts: pp, history,
    holdings: holdings.map((h) => strip(h, HOLDING_FIELDS)), sips: sips.map((s) => strip(s, SIP_FIELDS)),
  };
}

// Current holdings and SIPs of a client, platform or product (or every file of one batch),
// grouped by the file they came from, in the shape the Excel report builder expects.
async function exportData(params) {
  let ids, scope = {};
  if (params.get("batch")) {
    ids = (await query(`SELECT id FROM uploads WHERE batch_id = $1`, [params.get("batch")])).rows.map((r) => r.id);
  } else {
    if (params.get("client")) scope.client_key = key(params.get("client"));
    if (params.get("platform")) scope.platform_key = key(params.get("platform"));
    if (params.get("product")) scope.product = product(params.get("product"));
    if (!Object.keys(scope).length) throw new HttpError(400, "client, platform, product or batch is required");
    ids = [...new Set((await select("upload_id", BOTH, scope, [])).map((r) => r.upload_id))];
  }
  if (!ids.length) throw new HttpError(404, "No data found.");
  const w = where(scope);
  const args = [...w.args, ids];
  const sql = `${w.sql ? w.sql + " AND" : "WHERE"} upload_id = ANY($${args.length}::int[])`;
  // A batch export is those files as uploaded. Anything else is what the dashboard shows: only the
  // latest rows per client, so a client sent again in a newer file is not counted twice.
  const cur = params.get("batch") ? "" : "current_";
  const hs = (await query(`SELECT * FROM ${cur}holdings ${sql} ORDER BY id`, args)).rows;
  const ss = (await query(`SELECT * FROM ${cur}sips ${sql} ORDER BY id`, args)).rows;
  const ups = (await query(`SELECT ${UPLOAD_COLS} FROM uploads u WHERE u.id = ANY($1::int[]) ORDER BY u.product, u.platform, u.id`, [ids]))
    .rows.map(uploadOut);
  const pick = (r, fields) => ({ client_name: r.client_name, pan: r.pan, platform: r.platform, product: r.product,
    ...Object.fromEntries(fields.map((f) => [f, r[f]])) });
  ups.forEach((u) => {
    u.holdings = hs.filter((h) => h.upload_id === u.id).map((h) => pick(h, HOLDING_FIELDS));
    u.sips = ss.filter((s) => s.upload_id === u.id).map((s) => pick(s, SIP_FIELDS));
  });
  return { uploads: ups };
}

// Everything the Client Review Sheet needs for one client: every upload that ever held the
// client's data (all versions, so the sheet can show the portfolio over time), with the client's
// holdings and SIPs in each. public/js/review.js works out the figures.
async function reviewData(name) {
  const ck = key(name);
  if (!ck) throw new HttpError(400, "client is required");
  const hs = (await query(`SELECT upload_id, client_name, client_id, platform, platform_key, product, asset_class, category,
      security_name, isin, identifier, quantity, invested, current_value, return_pct, xirr, as_of, level
    FROM holdings WHERE client_key = $1 ORDER BY id`, [ck])).rows;
  const ss = (await query(`SELECT upload_id, client_name, client_id, platform, platform_key, product, security_name, isin,
      identifier, sip_amount, monthly_amount, frequency, status, live
    FROM sips WHERE client_key = $1 ORDER BY id`, [ck])).rows;
  if (!hs.length && !ss.length) throw new HttpError(404, "No data for this client yet.");
  const ids = [...new Set([...hs, ...ss].map((r) => r.upload_id))];
  const uploads = (await query(`SELECT id, kind, platform, platform_key, product, version,
      COALESCE(snapshot_date, to_char(uploaded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')) AS snapshot_date
    FROM uploads WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
  const latest = [...hs, ...ss].sort((a, b) => b.upload_id - a.upload_id)[0];
  const saved = (await query("SELECT data, updated_at FROM review_edits WHERE client_key = $1", [ck])).rows[0];
  let edits = {};
  try { edits = saved ? JSON.parse(saved.data) : {}; } catch { edits = {}; }
  return { clientName: latest.client_name, clientId: clientIdOf([...hs, ...ss]), today: todayIst(), uploads, holdings: hs, sips: ss,
    edits, editsSavedAt: saved?.updated_at || null };
}

// Reviewer changes from the Review Report page. Stored apart from the uploads, which stay as uploaded.
async function saveReviewEdits(name, body) {
  const ck = key(name);
  if (!ck) throw new HttpError(400, "client is required");
  const edits = body?.edits;
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) throw new HttpError(400, "edits must be an object");
  const data = JSON.stringify(edits);
  if (data.length > 1024 * 1024) throw new HttpError(413, "Too many changes to save.");
  const { rows } = await query(`INSERT INTO review_edits (client_key, data, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (client_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING updated_at`, [ck, data]);
  return { ok: true, savedAt: rows[0].updated_at };
}

async function resetReviewEdits(name) {
  const ck = key(name);
  if (!ck) throw new HttpError(400, "client is required");
  await query("DELETE FROM review_edits WHERE client_key = $1", [ck]);
  return { ok: true };
}

// ---- SIPs ----------------------------------------------------------------------------
const sameScheme = `(($2::text IS NOT NULL AND isin = $2) OR ($3::text IS NOT NULL AND identifier = $3)
  OR lower(security_name) = lower($4))`;

// Every current SIP (optionally only live ones), for the SIP list page.
async function sipList(params) {
  const scope = {};
  if (params.get("client")) scope.client_key = key(params.get("client"));
  if (params.get("platform")) scope.platform_key = key(params.get("platform"));
  if (params.get("product")) scope.product = product(params.get("product"));
  const w = where(scope, params.get("live") === "0" ? [] : ["live"]);
  const rows = (await query(`SELECT s.id, s.client_name, s.platform, s.product, s.security_name, s.isin, s.identifier, s.sip_amount,
      s.monthly_amount, s.frequency, s.sip_day, s.start_date, s.end_date, s.status, s.live, u.snapshot_date, u.version
    FROM current_sips s JOIN uploads u ON u.id = s.upload_id ${w.sql.replace(/\b(client_key|platform_key|product|live)\b/g, "s.$1")}
    ORDER BY s.monthly_amount DESC NULLS LAST, s.client_name`, w.args)).rows;
  return rows;
}

const addMonths = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
};
const STEP_MONTHS = { Monthly: 1, Quarterly: 3, "Half Yearly": 6, Yearly: 12 };

// Installments paid so far, installments left and the next due date, worked out from the
// start/end dates and the frequency. Estimates: the files do not list actual debits.
function schedule(s, today = todayIst()) {
  const step = STEP_MONTHS[s.frequency];
  if (!step || !ISO.test(s.start_date || "")) return null;
  let paid = 0, next = null, cur = s.start_date;
  const end = ISO.test(s.end_date || "") ? s.end_date : null;
  for (let i = 0; i < 1200; i++) {
    if (end && cur > end) break;
    if (cur > today) { next = cur; break; }
    paid++;
    cur = addMonths(s.start_date, step * (i + 1));
  }
  let total = null;
  if (end) { total = 0; for (let i = 0; i < 1200 && addMonths(s.start_date, step * i) <= end; i++) total++; }
  return { paid, total, remaining: total === null ? null : Math.max(total - paid, 0), next_due: s.live ? next : null,
    invested_estimate: s.sip_amount ? paid * s.sip_amount : null };
}

async function sipDetail(id) {
  const s = (await query(`SELECT s.*, u.original_name, u.version, u.snapshot_date, u.upload_type,
      to_char(u.uploaded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS uploaded_at
    FROM sips s JOIN uploads u ON u.id = s.upload_id WHERE s.id = $1`, [id])).rows[0];
  if (!s) throw new HttpError(404, "SIP not found.");
  const args = [s.client_key, s.isin, s.identifier, s.security_name || ""];
  // The same SIP in every uploaded version of this platform + category, newest first.
  const history = (await query(`SELECT x.id, x.sip_amount, x.monthly_amount, x.frequency, x.status, x.live, x.end_date,
      u.version, u.snapshot_date, u.original_name, to_char(u.uploaded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS uploaded_at,
      EXISTS (SELECT 1 FROM current_sips c WHERE c.id = x.id) AS current
    FROM sips x JOIN uploads u ON u.id = x.upload_id
    WHERE x.client_key = $1 AND x.platform_key = $5 AND x.product = $6 AND ${sameScheme.replace(/\b(isin|identifier|security_name)\b/g, "x.$1")}
    ORDER BY u.id DESC`, [...args, s.platform_key, s.product])).rows;
  // What the client holds in this scheme today (from AUM files of any platform).
  const holdings = (await query(`SELECT platform, product, security_name, isin, identifier, quantity, invested, current_value,
      gain_loss, return_pct, xirr, as_of FROM current_holdings WHERE client_key = $1 AND ${sameScheme}
    ORDER BY current_value DESC NULLS LAST`, args)).rows;
  const others = (await query(`SELECT id, platform, product, security_name, sip_amount, frequency, monthly_amount, status, live
    FROM current_sips WHERE client_key = $1 AND id <> $2 ORDER BY live DESC, monthly_amount DESC NULLS LAST`, [s.client_key, s.id])).rows;
  const ids = s.client_id ? [] : (await query(`SELECT client_id, product FROM current_holdings WHERE client_key = $1 AND client_id IS NOT NULL
    UNION ALL SELECT client_id, product FROM current_sips WHERE client_key = $1 AND client_id IS NOT NULL`, [s.client_key])).rows;
  const out = { id: s.id, client_name: s.client_name, client_id: s.client_id || clientIdOf(ids), platform: s.platform, product: s.product,
    source_file: s.original_name, upload_id: s.upload_id, version: s.version, snapshot_date: s.snapshot_date, uploaded_at: s.uploaded_at,
    upload_type: s.upload_type, current: history.some((h) => h.id === s.id && h.current) };
  SIP_FIELDS.forEach((f) => { out[f] = s[f]; });
  return { sip: out, schedule: schedule(s), history, holdings, others };
}

async function meta() {
  const clients = (await query(`SELECT MIN(client_name) AS name FROM (
      SELECT client_key, client_name FROM holdings UNION ALL SELECT client_key, client_name FROM sips
      UNION ALL SELECT client_key, client_name FROM uploads WHERE upload_type = 'client') x
    WHERE client_name <> $1 AND client_name <> '' GROUP BY client_key ORDER BY 1`, [UNASSIGNED])).rows.map((r) => r.name);
  return { products: PRODUCTS, platforms: await platforms(), clients };
}

// ---- Router -----------------------------------------------------------------------------
export async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  // On Vercel every /api/* request is rewritten to /api/index, with the original path in __path.
  const rewritten = url.searchParams.get("__path");
  url.searchParams.delete("__path");
  const path = rewritten !== null ? `/${rewritten}` : url.pathname.replace(/^\/api/, "");
  const route = path.replace(/\/+$/, "") || "/";
  const method = req.method;
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https");
  try {
    if (route === "/session" && method === "GET") {
      return send(res, 200, { loggedIn: isLoggedIn(req), defaultPassword: usingDefaultPassword(), configured: adminPassword() !== null });
    }
    if (route === "/login" && method === "POST") {
      const { password } = await jsonBody(req);
      if (adminPassword() === null) throw new HttpError(503, "ADMIN_PASSWORD is not set for this deployment.");
      if (!checkPassword(password)) {
        await new Promise((r) => setTimeout(r, 600)); // slow down password guessing
        throw new HttpError(401, "Incorrect password.");
      }
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(secure) });
    }
    if (route === "/logout" && method === "POST") return send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });

    if (!isLoggedIn(req)) throw new HttpError(401, "Please log in.");

    if ((route === "/meta" || route === "/lists") && method === "GET") return send(res, 200, await meta());
    if (route === "/platforms" && method === "GET") return send(res, 200, await platforms());
    if (route === "/platforms" && method === "POST") return send(res, 201, await addPlatform(await jsonBody(req)));
    const pm = /^\/platforms\/(\d+)$/.exec(route);
    if (pm && method === "DELETE") {
      const r = await query(`DELETE FROM platforms WHERE id = $1 RETURNING id`, [Number(pm[1])]);
      if (!r.rows.length) throw new HttpError(404, "Platform not found.");
      return send(res, 200, { deleted: Number(pm[1]) });
    }

    if (route === "/uploads" && method === "GET") return send(res, 200, await listUploads(url.searchParams));
    if (route === "/uploads" && method === "POST") return send(res, 201, await createUpload(await jsonBody(req)));

    const m = /^\/uploads\/(\d+)(\/file)?$/.exec(route);
    if (m) {
      const id = Number(m[1]);
      if (m[2] && method === "PUT") {
        const data = await rawBody(req, MAX_FILE_BYTES + 1);
        if (data.length > MAX_FILE_BYTES) throw new HttpError(413, "The file is too large.");
        const r = await query(`UPDATE uploads SET file_data = $1 WHERE id = $2 AND file_data IS NULL RETURNING id`, [data, id]);
        if (!r.rows.length) throw new HttpError(404, "Upload not found.");
        return send(res, 200, { ok: true });
      }
      if (m[2] && method === "GET") {
        const r = (await query(`SELECT original_name, file_type, file_data FROM uploads WHERE id = $1`, [id])).rows[0];
        if (!r || !r.file_data) throw new HttpError(404, "File not found.");
        const name = r.original_name.replace(/[^\w.\- ]+/g, "_");
        return send(res, 200, Buffer.from(r.file_data), {
          "Content-Type": r.file_type, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store",
        });
      }
      if (!m[2] && method === "DELETE") {
        const r = await query(`DELETE FROM uploads WHERE id = $1 RETURNING id`, [id]);
        if (!r.rows.length) throw new HttpError(404, "Upload not found.");
        return send(res, 200, { deleted: id });
      }
    }

    if (route === "/export" && method === "GET") return send(res, 200, await exportData(url.searchParams));
    if (route === "/dashboard" && method === "GET") return send(res, 200, await dashboard());
    if (route === "/dashboard/scope" && method === "GET") return send(res, 200, await scopeDashboard(url.searchParams));
    if (route === "/sips" && method === "GET") return send(res, 200, await sipList(url.searchParams));
    const sm = /^\/sips\/(\d+)$/.exec(route);
    if (sm && method === "GET") return send(res, 200, await sipDetail(Number(sm[1])));
    if (route === "/review" && method === "GET") return send(res, 200, await reviewData(url.searchParams.get("client")));
    if (route === "/review/edits" && method === "PUT") {
      return send(res, 200, await saveReviewEdits(url.searchParams.get("client"), await jsonBody(req)));
    }
    // Admin Panel "Reset all data": every upload with its holdings and SIPs, and every review
    // change. The platform list stays. Needs {confirm: "RESET"} so it can't fire by accident.
    if (route === "/reset" && method === "POST") {
      const { confirm } = await jsonBody(req);
      if (confirm !== "RESET") throw new HttpError(400, 'Type RESET to confirm.');
      const n = (await query("SELECT COUNT(*)::int AS n FROM uploads")).rows[0].n;
      await query("DELETE FROM review_edits");
      await query("DELETE FROM uploads");
      return send(res, 200, { ok: true, uploadsDeleted: n });
    }
    if (route === "/review/edits" && method === "DELETE") return send(res, 200, await resetReviewEdits(url.searchParams.get("client")));
    if (route === "/dashboard/client" && method === "GET") return send(res, 200, await clientDashboard(url.searchParams.get("name")));

    throw new HttpError(404, "Not found.");
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (/DATABASE_URL/.test(e.message)) return send(res, 503, { error: e.message });
    console.error(e);
    return send(res, 500, { error: "Something went wrong on the server." + (process.env.VERCEL ? "" : ` (${e.message})`) });
  }
}
