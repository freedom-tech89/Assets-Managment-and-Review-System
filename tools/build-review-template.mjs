// Builds public/templates/client-review.xlsx from a filled-in Finowise client review sheet.
//
//   node tools/build-review-template.mjs "Review Sheet of <client> as on <date>.xlsx"
//
// It keeps every sheet, style, formula, chart and logo, and removes the client's data: values
// the app fills in, personal details, notes, cached formula results, chart caches, links to other
// workbooks and unused text. Run it again if the review sheet's layout changes; public/js/review.js
// reads the template's rows, so check that its row numbers still match.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Load the browser scripts: JSZip (UMD) and the review sheet code.
const script = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const mod = { exports: {} };
new Function("module", "exports", script("public/lib/jszip.min.js"))(mod, mod.exports);
const JSZip = mod.exports;
const { Sheet } = new Function("JSZip", `${script("public/js/review.js")}\nreturn Review;`)(JSZip);

const src = process.argv[2];
const out = process.argv[3] || path.join(ROOT, "public/templates/client-review.xlsx");
if (!src) { console.error("Usage: node tools/build-review-template.mjs <review sheet.xlsx> [out.xlsx]"); process.exit(1); }
const zip = await JSZip.loadAsync(fs.readFileSync(src));
const text = (p) => zip.file(p).async("string");

// Workbook: no links to other files, no saved path, recalculate everything when opened.
let wb = await text("xl/workbook.xml");
wb = wb.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, (m) => (m.includes("absPath") ? "" : m))
  .replace(/<externalReferences>[\s\S]*?<\/externalReferences>/, "")
  .replace(/<workbookPr\b([^>]*?)\s*updateLinks="[^"]*"/, "<workbookPr$1")
  .replace(/<calcPr\b[^>]*\/>/, '<calcPr calcId="191028" fullCalcOnLoad="1"/>');
zip.file("xl/workbook.xml", wb);
let rels = await text("xl/_rels/workbook.xml.rels");
rels = rels.replace(/<Relationship\b[^>]*(externalLink|calcChain)[^>]*\/>/g, "");
zip.file("xl/_rels/workbook.xml.rels", rels);
let types = await text("[Content_Types].xml");
types = types.replace(/<Override\b[^>]*(externalLink|calcChain)[^>]*\/>/g, "");
zip.file("[Content_Types].xml", types);
zip.remove("xl/calcChain.xml");
zip.remove("xl/externalLinks");
for (const f of Object.keys(zip.files)) if (f.startsWith("xl/externalLinks/")) zip.remove(f);

// Sheet name -> path.
const names = {};
for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
  const id = /r:id="([^"]+)"/.exec(m[0])[1];
  const t = new RegExp(`Id="${id}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${id}"`).exec(rels);
  names[/name="([^"]+)"/.exec(m[0])[1]] = `xl/${t[1] || t[2]}`;
}

const sheets = {};
for (const [name, p] of Object.entries(names)) sheets[name] = new Sheet(await text(p));
const S = (n) => sheets[n];

// Cover.
S("1").set("D17", "CLIENT NAME");
S("1").clear("Q5");

// Portfolio Journey: every value the app fills, plus the hand-entered savings and income rows.
const J = S("Portfolio Journey");
J.clear("G2");
for (const [r1, r2] of [[6, 13], [16, 23], [26, 33], [36, 43], [46, 53], [66, 67], [71, 88], [91, 92], [96, 119], [122, 123], [131, 140]]) {
  J.clearArea("F", "T", r1, r2);
}
J.set("B118", "Other Investments");

// SUMMARY PORTFOLIO and DETAILED PORTFOLIO: the app rewrites every row from row 3. Keep the cells
// (for their styles) and drop the values.
for (const n of ["SUMMARY PORTFOLIO", "DETAILED PORTFOLIO"]) S(n).clearArea("A", "ZZ", 3, 10000);

// Freedom Blueprint: personal details and the chosen level.
const B = S("Freedom Blueprint");
for (const ref of ["G8", "I8", "M8", "C11", "I11", "K11", "M11", "M160"]) B.clear(ref);
B.set("G11", { f: 'IF(C11="","",DATEDIF(C11,TODAY(),"Y"))' });

// Minutes of the meeting.
S("Discussion").clearArea("B", "L", 3, 200);
S("Discussion").set("A3", "DATE:");

// Drop cached formula results everywhere, so no figure of the source client remains.
for (const [name, sh] of Object.entries(sheets)) {
  for (const row of sh.rows.values()) {
    for (const [c, x] of row.cells) {
      if (!x.includes("<f")) continue;
      row.cells.set(c, x.replace(/<v>[^<]*<\/v>/, "").replace(/\s+t="(str|e|b|n)"/, ""));
    }
  }
  zip.file(names[name], sh.toXml());
}

// Charts: no cached series values.
for (const f of Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f))) {
  zip.file(f, (await text(f)).replace(/<c:(numCache|strCache)>[\s\S]*?<\/c:\1>/g, ""));
}

// Shared strings no cell uses any more (the client's name, schemes, e-mail...) become empty.
const used = new Set();
for (const p of Object.values(names)) {
  for (const m of (await text(p)).matchAll(/<c\b[^>]*\bt="s"[^>]*>\s*<v>(\d+)<\/v>/g)) used.add(Number(m[1]));
}
let ss = await text("xl/sharedStrings.xml");
let i = -1;
ss = ss.replace(/<si>[\s\S]*?<\/si>/g, (m) => (used.has(++i) ? m : "<si><t></t></si>"));
zip.file("xl/sharedStrings.xml", ss);

let core = await text("docProps/core.xml");
core = core.replace(/<dc:creator>[^<]*<\/dc:creator>/, "<dc:creator>Finowise</dc:creator>")
  .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy>Finowise</cp:lastModifiedBy>");
zip.file("docProps/core.xml", core);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`Wrote ${out}`);
