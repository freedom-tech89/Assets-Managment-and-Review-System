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

  // Same file again is refused; a new file is stored as version 2 and replaces v1 on the dashboard only
  assert.equal((await api("POST", "/uploads", up({ sha256: "a".repeat(64) }))).status, 409);
  const a2 = await api("POST", "/uploads", up({ sha256: "f".repeat(64), batchId: "b2",
    rows: [h({ security_name: "Fund A", invested: 1000, current_value: 1500, gain_loss: 500, as_of: "2026-10-31" })] }));
  assert.equal(a2.body.version, 2);
  assert.equal(a2.body.isNew, false);
  assert.equal(a2.body.snapshotDate, "2026-10-31");

  let c = (await api("GET", "/dashboard/client?name=medha dongre mala")).body;
  assert.equal(c.holdings.length, 3, "Finowise v2 (1 row) + Motilal + the loan row");
  assert.equal(c.total.current_value, 7500);
  assert.equal(c.total.loans, 50000);
  assert.equal(c.total.live_sips, 2);
  assert.equal(c.total.sip_monthly, 6000);
  assert.equal(c.sips.length, 3);
  assert.equal(c.history.length, 5, "v1 is kept in history");
  assert.equal(c.history.find((x) => x.id === a1.body.id).current, false);
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
  assert.equal(d.total.current_value, 7500 + 1200 + 3000 + 1200 + 10000);
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
  assert.equal(ex.uploads.length, 5);
  assert.ok(!ex.uploads.some((u) => u.id === a1.body.id), "old version not exported");
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

  assert.equal((await api("POST", "/logout")).status, 200);
  assert.equal((await api("GET", "/dashboard")).status, 401);
  console.log("All API tests passed.");
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
