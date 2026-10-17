// API test: starts the local server on a spare port against a fresh database and checks
// login, AUM + SIP uploads, versioning (new versions never overwrite old ones), duplicate
// detection, dashboards, export and delete.
// Run: npm test   (uses DATABASE_URL if set, otherwise a temporary built-in database)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ud-test-"));

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: "test-pass", UPLOAD_DETAILS_DATA: dataDir },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => d.toString().includes("running") && resolve()));

let cookie = "";
async function api(method, url, body, raw) {
  const res = await fetch(BASE + url, {
    method, headers: { cookie, ...(raw ? {} : { "content-type": "application/json" }) },
    body: raw ? body : body && JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const h = (o) => ({ client_id: null, asset_class: "Equity", category: null, security_name: "X", isin: null, identifier: null,
  quantity: 10, avg_cost: 100, invested: 1000, current_price: 120, current_value: 1200, gain_loss: 200, return_pct: 20,
  xirr: null, as_of: "2026-09-30", ...o });

const sip = (o) => ({ client_id: null, asset_class: "Equity", security_name: "Fund A", isin: null, identifier: null,
  sip_amount: 5000, monthly_amount: 5000, frequency: "Monthly", sip_day: 5, start_date: "2025-01-05", end_date: null,
  status: "Active", live: true, as_of: "2026-09-30", ...o });
const up = (o) => ({ uploadType: "client", clientName: "Medha Dongre Mala", platform: "Finowise", product: "MF", kind: "aum",
  originalName: "f.xlsx", format: "xlsx", size: 5, batchId: "b1", rows: [], ...o });

try {
  assert.equal((await api("GET", "/meta")).status, 401, "API is locked before login");
  assert.equal((await api("POST", "/login", { password: "nope" })).status, 401);
  assert.equal((await api("POST", "/login", { password: "test-pass" })).status, 200);

  const meta = (await api("GET", "/meta")).body;
  assert.equal(meta.platforms.length, 15, "platform matrix is seeded from the workflow sheet");
  assert.deepEqual(meta.products, ["MF", "Stocks", "PMS", "AIF", "Bonds", "LAS", "Other"]);

  // Client wise: AUM + SIP for MF on Finowise, AUM for Stocks on Motilal Oswal, a loan on Volt Money
  const a1 = await api("POST", "/uploads", up({ sha256: "a".repeat(64),
    rows: [h({ security_name: "Fund A", xirr: 12 }), h({ security_name: "Fund B", invested: 2000, current_value: 1800, gain_loss: -200 })] }));
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.version, 1);
  assert.equal(a1.body.isNew, true);
  assert.equal(a1.body.snapshotDate, "2026-09-30", "date taken from the file");
  assert.equal((await api("PUT", `/uploads/${a1.body.id}/file`, Buffer.from("hello"), true)).status, 200);
  assert.equal((await api("GET", `/uploads/${a1.body.id}/file`)).body.toString(), "hello");
  const s1 = await api("POST", "/uploads", up({ kind: "sip", sha256: "c".repeat(64),
    rows: [sip({}), sip({ security_name: "Fund B", sip_amount: 3000, frequency: "Quarterly", monthly_amount: 1000 }),
      sip({ security_name: "Old", status: "Ceased", live: false })] }));
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  assert.equal((await api("POST", "/uploads", up({ platform: "Motilal Oswal", product: "Stocks", sha256: "d".repeat(64),
    rows: [h({ security_name: "INFY", invested: 5000, current_value: 6000, gain_loss: 1000 })] }))).status, 201);
  assert.equal((await api("POST", "/uploads", up({ platform: "Volt Money", product: "LAS", sha256: "e".repeat(64),
    rows: [h({ security_name: "Loan", invested: null, current_value: 50000, gain_loss: null })] }))).status, 201);

  // Same file again is refused; a new file is stored as version 2. Its folios update the same
  // folios from v1; folios v2 doesn't list (Fund B) stay as they were.
  assert.equal((await api("POST", "/uploads", up({ sha256: "a".repeat(64) }))).status, 409);
  const a2 = await api("POST", "/uploads", up({ sha256: "f".repeat(64), batchId: "b2",
    rows: [h({ security_name: "Fund A", invested: 1000, current_value: 1500, gain_loss: 500, as_of: "2026-10-31" })] }));
  assert.equal(a2.body.version, 2);
  assert.equal(a2.body.isNew, false);
  assert.equal(a2.body.snapshotDate, "2026-10-31");

  let c = (await api("GET", "/dashboard/client?name=medha dongre mala")).body;
  assert.equal(c.holdings.length, 4, "Fund A from v2, Fund B from v1, Motilal and the loan row");
  assert.equal(c.total.current_value, 1500 + 1800 + 6000);
  assert.equal(c.total.loans, 50000);
  assert.equal(c.total.live_sips, 2);
  assert.equal(c.total.sip_monthly, 6000);
  assert.equal(c.sips.length, 3);
  assert.equal(c.history.length, 5, "v1 is kept in history");
  assert.equal(c.history.find((x) => x.id === a1.body.id).current, true, "v1 still holds Fund B");
  assert.equal(c.platformProducts.length, 3);

  // SIP details: schedule, the matching holding, and other SIPs of the client
  const fundA = c.sips.find((x) => x.security_name === "Fund A");
  const sd = (await api("GET", `/sips/${fundA.id}`)).body;
  assert.equal(sd.sip.sip_amount, 5000);
  assert.equal(sd.sip.client_name, "Medha Dongre Mala");
  assert.equal(sd.holdings.length, 1, "Fund A is held in the Finowise v2 AUM file");
  assert.equal(sd.history.length, 1);
  assert.ok(sd.schedule.paid >= 20, "monthly since Jan 2025");
  assert.equal(sd.schedule.total, null, "no end date");
  assert.equal(sd.others.length, 2);
  assert.equal((await api("GET", "/sips/999999")).status, 404);
  assert.equal((await api("GET", "/sips")).body.length, 2, "live SIPs only");
  assert.equal((await api("GET", "/sips?live=0&client=medha dongre mala")).body.length, 3);

  // Platform wise: one NJ MF file with two clients and one unassigned row
  const p1 = await api("POST", "/uploads", { uploadType: "platform", platform: "NJ", product: "MF", kind: "aum", originalName: "nj.xlsx",
    format: "xlsx", size: 5, sha256: "b".repeat(64), batchId: "b3",
    rows: [h({ client_name: "Medha Dongre Mala" }), h({ client_name: "Anil Shah", current_value: 3000 }), h({ client_name: "" })] });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.body.clientsCount, 2);
  const nj2 = await api("POST", "/uploads", { uploadType: "platform", platform: "NJ", product: "PMS", kind: "aum", originalName: "njp.xlsx",
    format: "xlsx", size: 5, sha256: "b".repeat(64), rows: [h({ client_name: "Anil Shah", current_value: 10000 })] });
  assert.equal(nj2.status, 201, "same file under another category is a separate upload");

  const d = (await api("GET", "/dashboard")).body;
  assert.equal(d.total.clients, 3, "Medha, Anil, Unassigned");
  assert.equal(d.total.current_value, 9300 + 1200 + 3000 + 1200 + 10000);
  assert.equal(d.total.loans, 50000);
  assert.deepEqual(d.products.map((p) => p.product), ["MF", "Stocks", "PMS", "LAS"]);
  assert.equal(d.products.find((p) => p.product === "LAS").loan_value, 50000);
  assert.deepEqual(d.platforms.find((p) => p.platform === "NJ").products.sort(), ["MF", "PMS"]);
  assert.ok(d.recent.length >= 3);

  const nj = (await api("GET", "/dashboard/scope?platform=nj")).body;
  assert.equal(nj.clients.length, 3);
  assert.equal(nj.total.current_value, 1200 + 3000 + 1200 + 10000);
  const mf = (await api("GET", "/dashboard/scope?product=MF")).body;
  assert.equal(mf.platforms.length, 2);
  assert.equal(mf.total.sip_monthly, 6000);
  assert.equal((await api("GET", "/dashboard/scope?product=AIF")).status, 404);

  const hist = (await api("GET", "/uploads?client=Medha Dongre Mala")).body;
  assert.equal(hist.length, 6, "client wise uploads plus the NJ platform file that names Medha");

  // Export gives current data only, grouped by source file
  const ex = (await api("GET", "/export?client=Medha Dongre Mala")).body;
  assert.equal(ex.uploads.length, 6);
  assert.deepEqual(ex.uploads.find((u) => u.id === a1.body.id).holdings.map((x) => x.security_name), ["Fund B"],
    "from v1 only the folio v2 doesn't update");
  assert.equal(ex.uploads.find((u) => u.kind === "sip").sips.length, 3);
  assert.equal(ex.uploads.find((u) => u.platform === "NJ").holdings.length, 1, "only Medha's row from the NJ bulk file");
  assert.equal((await api("GET", "/export?batch=b1")).body.uploads.length, 4);

  // Client Review Sheet: the endpoint returns every version, and the template is filled in
  const rv = (await api("GET", "/review?client=Medha Dongre Mala")).body;
  assert.equal(rv.clientName, "Medha Dongre Mala");
  assert.ok(rv.uploads.some((u) => u.id === a1.body.id), "older versions included for the journey over time");
  assert.equal(rv.holdings.filter((x) => x.platform === "NJ").length, 1, "only Medha's rows from the NJ bulk file");
  assert.equal((await api("GET", "/review?client=Nobody")).status, 404);
  const script = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const mod = { exports: {} };
  new Function("module", "exports", script("public/lib/jszip.min.js"))(mod, mod.exports);
  const Review = new Function("JSZip", `${script("public/js/review.js")}\nreturn Review;`)(mod.exports);
  const book = await Review.build(rv, fs.readFileSync(path.join(ROOT, "public/templates/client-review.xlsx")), { output: "nodebuffer" });
  const zip = await mod.exports.loadAsync(book);
  assert.ok((await zip.file("xl/worksheets/sheet1.xml").async("string")).includes("MEDHA DONGRE MALA"), "cover has the client name");
  const detailed = await zip.file("xl/worksheets/sheet6.xml").async("string");
  assert.ok(detailed.includes("Fund A") && detailed.includes("TOTAL PORTFOLIO OF MEDHA DONGRE MALA"), "scheme-wise sheet filled");
  // Reviewer's changes: saved apart from the uploads, applied to the exported sheet, and resettable
  const rvFundA = Review.prepare(rv).raw.holdings.find((x) => x.security_name === "Fund A");
  const keyA = Review.rowKey(rvFundA);
  const edits = { personal: { mobile: "9800011122" }, notes: "Move ₹5,000 to debt",
    schemes: { [keyA]: { current_value: 777777, remarks: "Checked with RM" } } };
  assert.equal((await api("PUT", "/review/edits?client=Medha Dongre Mala", { edits })).status, 200);
  assert.equal((await api("PUT", "/review/edits?client=Medha Dongre Mala", { edits: "x" })).status, 400);
  const rv2 = (await api("GET", "/review?client=Medha Dongre Mala")).body;
  assert.deepEqual(rv2.edits, edits);
  assert.deepEqual(rv2.holdings, rv.holdings, "uploaded data unchanged");
  assert.equal(Review.prepare(rv2, rv2.edits).current.value - Review.prepare(rv2, {}).current.value, 777777 - rvFundA.current_value);
  const book2 = await mod.exports.loadAsync(await Review.build(rv2, fs.readFileSync(path.join(ROOT, "public/templates/client-review.xlsx")), { output: "nodebuffer" }));
  const all2 = (await Promise.all(Object.keys(book2.files).filter((f) => f.startsWith("xl/worksheets/sheet")).map((f) => book2.file(f).async("string")))).join("");
  for (const v of ["777777", "Checked with RM", "9800011122", "Move ₹5,000 to debt"]) assert.ok(all2.includes(v), `export has ${v}`);
  // Cells typed on the sheet view go into the export; formula cells are left alone
  const tpl = fs.readFileSync(path.join(ROOT, "public/templates/client-review.xlsx"));
  const { zip: z3, schemeRows } = await Review.assemble(rv2, tpl, { ...edits, cells: { "Freedom Blueprint": { I8: "rohan@example.com", G11: 99 } } });
  const bp = await z3.file("xl/worksheets/sheet7.xml").async("string");
  assert.ok(bp.includes("rohan@example.com"), "typed cell exported");
  assert.ok(/<c r="G11"[^>]*><f>/.test(bp), "formula cell kept");
  assert.ok([...schemeRows.values()].includes(keyA), "scheme rows mapped for the sheet view");
  assert.equal((await api("DELETE", "/review/edits?client=Medha Dongre Mala")).status, 200);
  assert.deepEqual((await api("GET", "/review?client=Medha Dongre Mala")).body.edits, {});

  assert.equal(Review.mfType("SBI Balanced Advantage Fund", null), "Hybrid");
  assert.equal(Review.mfType("ICICI Prudential Corporate Bond Fund", null), "Debt");
  assert.equal(Review.mfType("Kotak Gold Fund", null), "Others");
  assert.equal(Review.mfType("HDFC Mid-Cap Opportunities Fund", null), "Equity");

  // Platforms can be added to the matrix and removed
  const np = await api("POST", "/platforms", { name: "Zerodha", product: "Stocks" });
  assert.equal(np.status, 201);
  assert.equal((await api("POST", "/platforms", { name: "zerodha", product: "Stocks" })).status, 409);
  assert.equal((await api("DELETE", `/platforms/${np.body.id}`)).status, 200);

  // Deleting v2 brings v1 back as current
  assert.equal((await api("DELETE", `/uploads/${a2.body.id}`)).status, 200);
  c = (await api("GET", "/dashboard/client?name=Medha Dongre Mala")).body;
  assert.equal(c.total.current_value, 3000 + 6000 + 1200);

  // Reset all data needs the word RESET, then empties everything but the platform list
  assert.equal((await api("POST", "/reset", { confirm: "yes" })).status, 400);
  assert.equal((await api("POST", "/reset", { confirm: "RESET" })).status, 200);
  assert.equal((await api("GET", "/dashboard")).body.clients.length, 0);
  assert.ok((await api("GET", "/platforms")).body.length > 0, "platforms kept");

  // Same data Platform Wise and Client Wise: one client, never doubled, PAN joins the two
  const bulk = (o) => up({ uploadType: "platform", clientName: "", platform: "NJ", originalName: "nj.xlsx", ...o });
  const rahul = h({ client_name: "RAHUL MISHRA", client_id: "ABCDE1234F", security_name: "Fund R", invested: 1000, current_value: 1500,
    start_date: "2024-04-01" });
  const priya = h({ client_name: "Priya Shah", client_id: "PQRSX6789K", security_name: "Fund P", invested: 500, current_value: 400 });
  const noName = h({ client_id: "LMNOP4321Z", security_name: "Fund U", invested: 100, current_value: 100 });
  const b1 = await api("POST", "/uploads", bulk({ sha256: "1".repeat(64), rows: [rahul, priya, noName] }));
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  // Client Wise with the same bulk file: only Rahul's row is kept, and it matches, so nothing changes
  const c1 = await api("POST", "/uploads", up({ clientName: "Rahul Mishra", platform: "NJ", sha256: "2".repeat(64), rows: [rahul, priya, noName] }));
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.body.unchanged, true, "same data is not saved again");
  // Client Wise with a new value for Rahul: the new value wins, nothing doubles
  const c2 = await api("POST", "/uploads", up({ clientName: "Rahul Mishra", platform: "NJ", sha256: "3".repeat(64),
    rows: [{ ...rahul, current_value: 1700 }, priya] }));
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  assert.equal(c2.body.rowsCount, 1, "other clients' rows in the file are left out");
  let dd = (await api("GET", "/dashboard")).body;
  const rr = dd.clients.find((x) => /rahul/i.test(x.client_name));
  assert.equal(rr.holdings, 1);
  assert.equal(rr.current_value, 1700);
  assert.equal(dd.clients.filter((x) => /rahul/i.test(x.client_name)).length, 1, "one Rahul, whatever the spelling");
  // Platform Wise again with the old file: Priya unchanged, Rahul back to 1500
  const b2 = await api("POST", "/uploads", bulk({ sha256: "4".repeat(64), rows: [rahul, priya, noName] }));
  assert.equal(b2.status, 201, JSON.stringify(b2.body));
  assert.ok(b2.body.unchangedClients >= 1, JSON.stringify(b2.body));
  // A file that names the PAN later claims the Unassigned row
  const b3 = await api("POST", "/uploads", bulk({ platform: "Anand Rathi", sha256: "5".repeat(64),
    rows: [h({ client_name: "Kiran Rao", client_id: "LMNOP4321Z", security_name: "Fund K" })] }));
  assert.equal(b3.status, 201);
  dd = (await api("GET", "/dashboard")).body;
  assert.ok(!dd.clients.some((x) => x.client_name === "Unassigned"), "Unassigned row joined Kiran by PAN");
  const njEx = (await api("GET", "/export?platform=NJ")).body;
  const exRows = njEx.uploads.flatMap((u) => u.holdings);
  assert.equal(exRows.filter((x) => x.security_name === "Fund R").length, 1, "export counts each holding once");
  assert.equal(exRows.find((x) => x.security_name === "Fund R").start_date, "2024-04-01");
  // A Client Wise file whose clients are all someone else is refused
  const c3 = await api("POST", "/uploads", up({ clientName: "Nobody Here", platform: "NJ", sha256: "6".repeat(64), rows: [rahul, priya] }));
  assert.equal(c3.status, 400);

  // Folio by folio: Platform Wise then Client Wise for the same client + PAN updates matching
  // folios, adds new ones and keeps the rest; the same name with another PAN is someone else
  const sunil = (o) => h({ client_name: "Sunil Rao", client_id: "SUNIL1234R", isin: null, ...o });
  const f1 = await api("POST", "/uploads", bulk({ platform: "Finowise", sha256: "7".repeat(64), rows: [
    sunil({ identifier: "F-1", security_name: "Alpha Fund", current_value: 1000 }),
    sunil({ identifier: "F-2", security_name: "Beta Fund", current_value: 2000 })] }));
  assert.equal(f1.status, 201, JSON.stringify(f1.body));
  const f2 = await api("POST", "/uploads", up({ clientName: "SUNIL RAO", platform: "Finowise", sha256: "8".repeat(64), rows: [
    h({ identifier: "F-1", security_name: "Alpha Fund", current_value: 1100 }),
    h({ identifier: "F-3", security_name: "Gamma Fund", current_value: 300 })] }));
  assert.equal(f2.status, 201, JSON.stringify(f2.body));
  const sc = (await api("GET", "/dashboard/client?name=Sunil Rao")).body;
  assert.deepEqual(sc.holdings.map((x) => [x.identifier, x.current_value]).sort(), [["F-1", 1100], ["F-2", 2000], ["F-3", 300]]);
  const sx = (await api("GET", "/export?client=Sunil Rao")).body.uploads.flatMap((u) => u.holdings);
  assert.ok(sx.every((x) => x.pan === "SUNIL1234R"), "rows without a PAN take the client's PAN");
  const other = await api("POST", "/uploads", bulk({ platform: "NJ", sha256: "9".repeat(64), rows: [
    h({ client_name: "Sunil Rao", client_id: "OTHER9876Q", identifier: "N-1", security_name: "Delta Fund" })] }));
  assert.equal(other.status, 201);
  assert.ok((await api("GET", "/dashboard")).body.clients.some((x) => x.client_name === "Sunil Rao (OTHER9876Q)"), "name + PAN is the client");

  // Investor-wise AUM report (one total per investor) Platform Wise, then the investor's
  // scheme-wise statement Client Wise: the detail replaces the total, never adds to it
  const total = (name, pan, inv, cur) => h({ client_name: name, client_id: pan, security_name: "All schemes (investor total)",
    level: "summary", invested: inv, current_value: cur, quantity: null, asset_class: null });
  const aum = await api("POST", "/uploads", bulk({ platform: "Freedomlifex", sha256: "10".repeat(32), rows: [
    total("MEENA IYER", "MEENA1234M", 1000, 1500), total("Ravi Nair", "RAVIN5678R", 500, 600)] }));
  assert.equal(aum.status, 201, JSON.stringify(aum.body));
  let mi = (await api("GET", "/dashboard/client?name=Meena Iyer")).body;
  assert.equal(mi.total.current_value, 1500, "the investor total stands in until there is detail");
  const st = await api("POST", "/uploads", up({ clientName: "Meena Iyer", platform: "Freedomlifex", sha256: "11".repeat(32), rows: [
    h({ client_name: "MEENA IYER", client_id: "MEENA1234M", identifier: "M-1", security_name: "One Fund", current_value: 900 }),
    h({ client_name: "MEENA IYER", client_id: "MEENA1234M", identifier: "M-2", security_name: "Two Fund", current_value: 650 })] }));
  assert.equal(st.status, 201, JSON.stringify(st.body));
  mi = (await api("GET", "/dashboard/client?name=Meena Iyer")).body;
  assert.equal(mi.total.current_value, 1550, "scheme detail replaces the investor total");
  assert.equal(mi.holdings.length, 2);
  assert.equal((await api("GET", "/dashboard/client?name=Ravi Nair")).body.total.current_value, 600, "other investors keep their totals");

  assert.equal((await api("POST", "/logout")).status, 200);
  assert.equal((await api("GET", "/dashboard")).status, 401);
  console.log("All API tests passed.");
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
