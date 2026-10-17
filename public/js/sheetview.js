// Shows an .xlsx workbook in the page the way Excel does: the same sheets, column widths, row
// heights, fonts, fills, borders, merged cells, number formats, pictures and bar charts, with the
// formulas worked out in the browser. Used by the Review Report page (public/js/reviewpage.js) to
// show the client review sheet before it is exported.
//
// Only what the review workbook needs is supported: the usual operators, cell and range
// references across sheets, shared formulas, and the functions in FUNCS below.
const SheetView = (() => {
  const EMU = 9525; // EMUs per pixel
  const HEAD_W = 42, HEAD_H = 20; // row-number column and column-letter row, px
  const MAX_ROWS = 700, MAX_COLS = 120;

  const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colName = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const refOf = (r, c) => `${colName(c)}${r}`;
  const parseRef = (ref) => { const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref); return m ? { c: colNum(m[1]), r: Number(m[2]) } : null; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const kids = (el, name) => (el ? [...el.children].filter((x) => x.localName === name) : []);
  const kid = (el, name) => (el ? [...el.children].find((x) => x.localName === name) : undefined);
  const deep = (el, name) => (el ? [...el.getElementsByTagNameNS("*", name)] : []);
  const attr = (el, name) => (el ? el.getAttribute(name) : null);
  const key = (r, c) => r * 20000 + c;

  // ---- Colours -------------------------------------------------------------------------------
  const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00",
    "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF",
    "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000",
    "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99", "3366FF", "33CCCC", "99CC00",
    "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333"];

  function hsl(hex) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
    }
    return [h, s, l];
  }
  function hex([h, s, l]) {
    const f = (n) => {
      const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, "0");
    };
    return `${f(0)}${f(8)}${f(4)}`.toUpperCase();
  }
  function tint(c, t) {
    if (!t) return c;
    const [h, s, l] = hsl(c);
    return hex([h, s, t < 0 ? l * (1 + t) : l * (1 - t) + t]);
  }
  // DrawingML lumMod / lumOff.
  function lum(c, mod = 1, off = 0) {
    if (mod === 1 && !off) return c;
    const [h, s, l] = hsl(c);
    return hex([h, s, Math.max(0, Math.min(1, l * mod + off))]);
  }

  // ---- Number formats ------------------------------------------------------------------------
  const BUILTIN = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
    14: "dd-mm-yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
    22: "dd-mm-yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
    41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
    45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
  };
  const COLORS = { red: "#FF0000", blue: "#0000FF", green: "#00A000", black: "#000000", white: "#FFFFFF", yellow: "#FFFF00", magenta: "#FF00FF", cyan: "#00FFFF" };
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const fromSerial = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  const toSerial = (d) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;

  function sections(code) {
    const out = [];
    let cur = "", q = false, br = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === "\\" && !q) { cur += ch + (code[i + 1] ?? ""); i++; continue; }
      if (ch === '"') q = !q;
      else if (!q && ch === "[") br = true;
      else if (!q && ch === "]") br = false;
      if (ch === ";" && !q && !br) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  // Splits a section into tokens: {lit} for text shown as is, {fill} for the * repeat character,
  // {skip} for _ spacing, and the rest as format characters.
  function lex(sec) {
    const out = [];
    for (let i = 0; i < sec.length; i++) {
      const ch = sec[i];
      if (ch === '"') { const j = sec.indexOf('"', i + 1); out.push({ lit: sec.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? sec.length : j; }
      else if (ch === "\\") { out.push({ lit: sec[i + 1] ?? "" }); i++; }
      else if (ch === "_") { out.push({ lit: " " }); i++; }
      else if (ch === "*") { out.push({ fill: true }); i++; }
      else if (ch === "[") {
        const j = sec.indexOf("]", i);
        const inner = sec.slice(i + 1, j);
        const cur = /^\$([^-\]]*)/.exec(inner);
        if (cur) out.push({ lit: cur[1] });
        else if (COLORS[inner.toLowerCase()]) out.push({ color: COLORS[inner.toLowerCase()] });
        else if (/^(h+|m+|s+)$/i.test(inner)) out.push({ ch: inner.toLowerCase(), elapsed: true });
        i = j;
      } else out.push({ ch });
    }
    return out;
  }

  const isDateFormat = (toks) => toks.some((t) => t.ch && /[dmyhs]/i.test(t.ch)) && !toks.some((t) => t.ch && /[0#?]/.test(t.ch));

  function groupDigits(s, indian) {
    if (!indian) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (s.length <= 3) return s;
    return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  }

  function formatNumberPart(v, pattern) {
    const percent = (pattern.match(/%/g) || []).length;
    const p = pattern.replace(/%/g, "");
    const dot = p.indexOf(".");
    const intPat = dot < 0 ? p : p.slice(0, dot), decPat = dot < 0 ? "" : p.slice(dot + 1);
    // Commas after the last digit placeholder scale by 1000.
    const trailing = (/(,+)$/.exec(intPat) || ["", ""])[1].length;
    const ip = intPat.slice(0, intPat.length - trailing);
    let x = Math.abs(v) * 100 ** percent / 1000 ** trailing;
    const decs = (decPat.match(/[0#?]/g) || []).length;
    const minDecs = (decPat.match(/0/g) || []).length;
    let [i, d = ""] = x.toFixed(decs).split(".");
    if (decs > minDecs) d = d.replace(new RegExp(`0{1,${decs - minDecs}}$`), "");
    const minInt = (ip.match(/0/g) || []).length;
    if (i === "0" && !minInt) i = "";
    i = i.padStart(minInt, "0");
    if (ip.includes(",")) i = groupDigits(i, /#,##,##0|,##,/.test(ip));
    const qInt = (ip.match(/\?/g) || []).length;
    if (qInt && i.length < qInt) i = i.padStart(qInt, " ");
    const qDec = (decPat.match(/\?/g) || []).length;
    if (qDec && d.length < decs) d = d.padEnd(decs, " ");
    return (dot >= 0 && (d || decPat.includes("0") || qDec) ? `${i}.${d}` : i) + "%".repeat(percent);
  }

  function formatDate(v, toks) {
    // Serial 0 is Excel's "0 January 1900".
    const d = v < 1 ? new Date(Date.UTC(1900, 0, 0, 0, 0, Math.round(v * 86400))) : fromSerial(v);
    if (v < 1) d.zeroDay = true;
    const hasAmPm = toks.some((t) => t.ch === "A" || t.ch === "a");
    // Join consecutive format characters into runs like "yyyy", "mmm", "dd".
    const runs = [];
    for (const t of toks) {
      if (t.ch && /[dmyhsDMYHS]/.test(t.ch) && runs.length && runs[runs.length - 1].ch && runs[runs.length - 1].ch[0].toLowerCase() === t.ch.toLowerCase()) {
        runs[runs.length - 1].ch += t.ch;
      } else runs.push({ ...t });
    }
    let out = "";
    for (let i = 0; i < runs.length; i++) {
      const t = runs[i];
      if (t.lit !== undefined) { out += t.lit; continue; }
      if (!t.ch) continue;
      const k = t.ch.toLowerCase();
      if (k[0] === "y") { const y = d.zeroDay ? 1900 : d.getUTCFullYear(); out += k.length <= 2 ? String(y).slice(-2) : y; }
      else if (k[0] === "d") out += k.length === 1 ? d.getUTCDate() : k.length === 2 ? String(d.getUTCDate()).padStart(2, "0") : k.length === 3 ? DAYS[d.getUTCDay()].slice(0, 3) : DAYS[d.getUTCDay()];
      else if (k[0] === "m") {
        const prev = runs.slice(0, i).reverse().find((x) => x.ch && /[a-z]/i.test(x.ch));
        const next = runs.slice(i + 1).find((x) => x.ch && /[a-z]/i.test(x.ch));
        const minutes = k.length <= 2 && ((prev && /^h/i.test(prev.ch)) || (next && /^s/i.test(next.ch)));
        if (minutes) out += k.length === 1 ? d.getUTCMinutes() : String(d.getUTCMinutes()).padStart(2, "0");
        else out += k.length === 1 ? d.getUTCMonth() + 1 : k.length === 2 ? String(d.getUTCMonth() + 1).padStart(2, "0") : k.length === 3 ? MONTHS[d.getUTCMonth()].slice(0, 3) : k.length === 5 ? MONTHS[d.getUTCMonth()][0] : MONTHS[d.getUTCMonth()];
      } else if (k[0] === "h") {
        let h = d.getUTCHours();
        if (hasAmPm) h = h % 12 || 12;
        out += k.length === 1 ? h : String(h).padStart(2, "0");
      } else if (k[0] === "s") out += k.length === 1 ? d.getUTCSeconds() : String(d.getUTCSeconds()).padStart(2, "0");
      else if (k === "a" && runs[i + 1]?.ch === "M") { /* AM/PM */
        out += d.getUTCHours() < 12 ? "AM" : "PM";
        i += 4;
      } else out += t.ch;
    }
    return out;
  }

  function general(v) {
    if (typeof v !== "number") return String(v);
    if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-9 || a >= 1e11)) return v.toExponential(5).replace(/\.?0+e/, "E").replace("e", "E");
    return String(Number(v.toPrecision(10)));
  }

  // Returns {text, color, left} where left is the part before a * fill (accounting formats put
  // the currency sign at the left edge of the cell).
  function format(v, code) {
    if (v === null || v === undefined) return { text: "" };
    if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE" };
    if (typeof v === "object" && v.e) return { text: v.e };
    if (!code || /^general$/i.test(code)) return { text: general(v) };
    const secs = sections(code);
    let sec, val = v;
    if (typeof v === "string") {
      sec = secs.length >= 4 ? secs[3] : secs.find((s) => s.includes("@"));
      if (sec === undefined) return { text: v };
    } else if (v > 0 || (v === 0 && secs.length < 3)) sec = secs[0];
    else if (v < 0) { sec = secs.length > 1 ? secs[1] : secs[0]; if (secs.length > 1) val = -v; }
    else sec = secs[2];
    const toks = lex(sec);
    if (/^general$/i.test(toks.filter((t) => t.ch).map((t) => t.ch).join(""))) return { text: general(val) };
    const color = toks.find((t) => t.color)?.color;
    const date = typeof val === "number" && isDateFormat(toks);
    let left = null, out = "";
    if (date) out = formatDate(val, toks);
    else {
      // Literal text, then the run of number characters, then more literal text.
      let pattern = "", done = false;
      for (const t of toks) {
        if (t.fill) { left = out; out = ""; continue; }
        if (t.lit !== undefined) { if (pattern && !done) { out += "\u0000"; done = true; } out += t.lit; continue; }
        if (!t.ch) continue;
        if (t.ch === "@") { out += typeof val === "string" ? val : general(val); continue; }
        if (typeof val === "number" && /[0#?.,%]/.test(t.ch) && !done) { if (!pattern) out += "\u0001"; pattern += t.ch; continue; }
        if (t.ch === "%" && typeof val === "number") { pattern += "%"; continue; }
        if (pattern && !done) { out += "\u0000"; done = true; }
        out += t.ch === " " ? " " : t.ch;
      }
      if (typeof val === "number") {
        const num = pattern ? formatNumberPart(val, pattern) : "";
        const neg = v < 0 && secs.length === 1 ? "-" : "";
        out = out.includes("\u0001") ? out.replace("\u0001", neg + num) : neg + out + num;
        out = out.replace(/\u0000/g, "");
      }
    }
    return { text: out, color, left };
  }

  // ---- Formulas ------------------------------------------------------------------------------
  class XErr { constructor(e) { this.e = e; } }
  const ERR = (e) => { throw new XErr(e); };

  function tokenize(f) {
    const out = [];
    let i = 0;
    while (i < f.length) {
      const rest = f.slice(i);
      const ch = f[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        let j = i + 1, s = "";
        while (j < f.length) { if (f[j] === '"') { if (f[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += f[j++]; }
        out.push({ t: "str", v: s }); i = j + 1; continue;
      }
      let m = /^#(REF!|N\/A|NAME\?|DIV\/0!|VALUE!|NUM!|NULL!)/.exec(rest);
      if (m) { out.push({ t: "err", v: m[0] }); i += m[0].length; continue; }
      const sm = /^(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!/.exec(rest);
      const after = sm ? rest.slice(sm[0].length) : rest;
      const rm = /^(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![\w(!])/.exec(after);
      if (rm && (sm || !/^\d/.test(rm[1]))) {
        out.push({ t: "ref", sheet: sm ? (sm[1] !== undefined ? sm[1].replace(/''/g, "'") : sm[2]) : null, v: rm[1].replace(/\$/g, "") });
        i += (sm ? sm[0].length : 0) + rm[1].length; continue;
      }
      if (sm && /^#REF!/.test(after)) { out.push({ t: "err", v: "#REF!" }); i += sm[0].length + 5; continue; }
      m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest);
      if (m) { out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
      m = /^([A-Za-z_][\w.]*)\s*\(/.exec(rest);
      if (m) { out.push({ t: "fn", v: m[1].toUpperCase().replace(/^_XLFN\./, "") }); i += m[0].length; continue; }
      m = /^[A-Za-z_][\w.]*/.exec(rest);
      if (m) { const u = m[0].toUpperCase(); out.push(u === "TRUE" || u === "FALSE" ? { t: "bool", v: u === "TRUE" } : { t: "name", v: m[0] }); i += m[0].length; continue; }
      m = /^(<>|<=|>=|[-+*/^&=<>%(),:;{}])/.exec(rest);
      if (m) { out.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
      throw new Error(`Cannot read formula: ${f}`);
    }
    return out;
  }

  // Moves the relative references of a shared formula from its first cell to another.
  function shift(f, dr, dc) {
    let out = "", i = 0;
    const re = /(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(!])/y;
    while (i < f.length) {
      const ch = f[i];
      if (ch === '"' || ch === "'") {
        const j = f.indexOf(ch, i + 1);
        out += f.slice(i, j < 0 ? undefined : j + 1); i = j < 0 ? f.length : j + 1; continue;
      }
      if (/[A-Z$]/.test(ch) && !/[\w.]/.test(f[i - 1] || "")) {
        re.lastIndex = i;
        const m = re.exec(f);
        if (m) {
          const c = m[1] ? colNum(m[2]) : colNum(m[2]) + dc, r = m[3] ? Number(m[4]) : Number(m[4]) + dr;
          out += `${m[1]}${colName(c)}${m[3]}${r}`; i += m[0].length; continue;
        }
      }
      out += ch; i++;
    }
    return out;
  }

  function parse(f) {
    const toks = tokenize(f);
    let p = 0;
    const peek = () => toks[p], next = () => toks[p++];
    const isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
    const bin = (sub, ops) => () => {
      let a = sub();
      while (toks[p] && toks[p].t === "op" && ops.includes(toks[p].v)) { const op = next().v; a = { k: "bin", op, a, b: sub() }; }
      return a;
    };
    const primary = () => {
      const t = next();
      if (!t) throw new Error("Unexpected end of formula");
      if (t.t === "num") return { k: "num", v: t.v };
      if (t.t === "str") return { k: "str", v: t.v };
      if (t.t === "bool") return { k: "bool", v: t.v };
      if (t.t === "err") return { k: "err", v: t.v };
      if (t.t === "name") return { k: "name", v: t.v };
      if (t.t === "ref") {
        let node = { k: "ref", sheet: t.sheet, v: t.v };
        if (isOp(":") && toks[p + 1]?.t === "ref") { next(); node = { k: "ref", sheet: t.sheet, v: `${t.v}:${next().v}` }; }
        return node;
      }
      if (t.t === "fn") {
        const args = [];
        if (isOp(")")) { next(); return { k: "fn", name: t.v, args }; }
        for (;;) {
          if (isOp(",") || isOp(")")) args.push({ k: "missing" }); else args.push(expr());
          const sep = next();
          if (!sep || sep.v === ")") break;
          if (sep.v !== "," && sep.v !== ";") throw new Error("Bad function arguments");
        }
        return { k: "fn", name: t.v, args };
      }
      if (t.t === "op" && t.v === "(") { const e = expr(); next(); return e; }
      if (t.t === "op" && t.v === "{") { // array constant: keep the first value
        const e = expr();
        while (p < toks.length && !(toks[p].t === "op" && toks[p].v === "}")) p++;
        p++;
        return e;
      }
      throw new Error(`Unexpected ${t.v} in formula`);
    };
    const postfix = () => { let a = primary(); while (isOp("%")) { next(); a = { k: "pct", a }; } return a; };
    const unary = () => {
      if (isOp("-")) { next(); return { k: "neg", a: unary() }; }
      if (isOp("+")) { next(); return unary(); }
      return postfix();
    };
    const power = bin(unary, ["^"]);
    const mult = bin(power, ["*", "/"]);
    const add = bin(mult, ["+", "-"]);
    const concat = bin(add, ["&"]);
    const expr = bin(concat, ["=", "<>", "<", ">", "<=", ">="]);
    const tree = expr();
    if (p < toks.length) throw new Error(`Unexpected ${peek().v} in formula`);
    return tree;
  }

  const isRange = (v) => v && typeof v === "object" && v.range;
  const isErr = (v) => v instanceof XErr || (v && typeof v === "object" && v.e);

  function num(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (isErr(v)) ERR(v.e);
    // Text that reads as a number counts as one, as in Excel: "1,000", "₹ 500", "7%", "0% ".
    let t = String(v).replace(/[,₹$\s]/g, "");
    let scale = 1;
    if (t.endsWith("%")) { t = t.slice(0, -1); scale = 100; }
    const n = t === "" ? NaN : Number(t);
    return Number.isFinite(n) ? n / scale : ERR("#VALUE!");
  }
  const str = (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? general(v) : isErr(v) ? ERR(v.e) : String(v));
  const bool = (v) => (typeof v === "string" ? (/^true$/i.test(v) ? true : /^false$/i.test(v) ? false : ERR("#VALUE!")) : num(v) !== 0);

  function compare(a, b) {
    const rank = (v) => (v === null || v === undefined ? -1 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
    if (a === null || a === undefined) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
    if (b === null || b === undefined) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (typeof a === "string") { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function datedif(s, e, unit) {
    const a = fromSerial(Math.floor(s)), b = fromSerial(Math.floor(e));
    if (a > b) ERR("#NUM!");
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
    switch (unit.toUpperCase()) {
      case "Y": return Math.floor(months / 12);
      case "M": return months;
      case "D": return Math.floor(e) - Math.floor(s);
      case "YM": return months % 12;
      case "MD": { const d = b.getUTCDate() - a.getUTCDate(); return d >= 0 ? d : new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate() + d; }
      case "YD": { let x = new Date(Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())); if (x > b) x = new Date(Date.UTC(b.getUTCFullYear() - 1, a.getUTCMonth(), a.getUTCDate())); return Math.round((b - x) / 86400000); }
      default: return ERR("#NUM!");
    }
  }

  const roundTo = (x, d, mode) => {
    const f = 10 ** d, y = Math.abs(x) * f;
    const r = mode === "up" ? Math.ceil(y - 1e-9) : mode === "down" ? Math.floor(y + 1e-9) : Math.round(y + 1e-9);
    return Math.sign(x) * r / f;
  };

  // Functions get their arguments unevaluated (so IF and IFERROR only work out what they need).
  const FUNCS = {
    SUM: (c, a) => c.nums(a).reduce((x, y) => x + y, 0),
    MIN: (c, a) => { const n = c.nums(a); return n.length ? Math.min(...n) : 0; },
    MAX: (c, a) => { const n = c.nums(a); return n.length ? Math.max(...n) : 0; },
    AVERAGE: (c, a) => { const n = c.nums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : ERR("#DIV/0!"); },
    COUNT: (c, a) => c.nums(a).length,
    COUNTA: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).filter((v) => v !== null && v !== "").length,
    IF: (c, a) => (bool(c.val(a[0])) ? (a[1] ? c.ev(a[1]) : true) : a[2] && a[2].k !== "missing" ? c.ev(a[2]) : false),
    IFERROR: (c, a) => { try { const v = c.val(a[0]); if (isErr(v)) throw v; return v; } catch (e) { if (e instanceof XErr) return c.val(a[1]); throw e; } },
    IFNA: (c, a) => { try { return c.val(a[0]); } catch (e) { if (e instanceof XErr && e.e === "#N/A") return c.val(a[1]); throw e; } },
    AND: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).every((v) => v === null || bool(v)),
    OR: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).some((v) => v !== null && bool(v)),
    NOT: (c, a) => !bool(c.val(a[0])),
    ABS: (c, a) => Math.abs(c.n(a[0])),
    INT: (c, a) => Math.floor(c.n(a[0])),
    MOD: (c, a) => { const x = c.n(a[0]), y = c.n(a[1]); return y ? x - y * Math.floor(x / y) : ERR("#DIV/0!"); },
    ROUND: (c, a) => roundTo(c.n(a[0]), a[1] ? c.n(a[1]) : 0),
    ROUNDUP: (c, a) => roundTo(c.n(a[0]), a[1] ? c.n(a[1]) : 0, "up"),
    ROUNDDOWN: (c, a) => roundTo(c.n(a[0]), a[1] ? c.n(a[1]) : 0, "down"),
    POWER: (c, a) => c.n(a[0]) ** c.n(a[1]),
    TODAY: () => { const d = new Date(); return toSerial(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); },
    YEAR: (c, a) => fromSerial(c.n(a[0])).getUTCFullYear(),
    MONTH: (c, a) => fromSerial(c.n(a[0])).getUTCMonth() + 1,
    DAY: (c, a) => fromSerial(c.n(a[0])).getUTCDate(),
    DATE: (c, a) => toSerial(new Date(Date.UTC(c.n(a[0]), c.n(a[1]) - 1, c.n(a[2])))),
    DATEDIF: (c, a) => datedif(c.n(a[0]), c.n(a[1]), str(c.val(a[2]))),
    TEXT: (c, a) => { const v = c.val(a[0]); return format(v === null ? 0 : v, str(c.val(a[1]))).text; },
    CONCATENATE: (c, a) => a.map((x) => str(c.val(x))).join(""),
    CONCAT: (c, a) => a.flatMap((x) => c.flat(c.ev(x))).map(str).join(""),
    LEN: (c, a) => str(c.val(a[0])).length,
    UPPER: (c, a) => str(c.val(a[0])).toUpperCase(),
    TRIM: (c, a) => str(c.val(a[0])).trim().replace(/\s+/g, " "),
    FV: (c, a) => {
      const [r, n, pmt, pv = 0, type = 0] = a.map((x) => (x.k === "missing" ? 0 : c.n(x)));
      return r === 0 ? -(pv + pmt * n) : -(pv * (1 + r) ** n + pmt * (1 + r * type) * ((1 + r) ** n - 1) / r);
    },
    PV: (c, a) => {
      const [r, n, pmt, fv = 0, type = 0] = a.map((x) => (x.k === "missing" ? 0 : c.n(x)));
      return r === 0 ? -(fv + pmt * n) : -(fv + pmt * (1 + r * type) * ((1 + r) ** n - 1) / r) / (1 + r) ** n;
    },
    PMT: (c, a) => {
      const [r, n, pv, fv = 0, type = 0] = a.map((x) => (x.k === "missing" ? 0 : c.n(x)));
      if (!n) return ERR("#NUM!");
      return r === 0 ? -(pv + fv) / n : -(r * (fv + pv * (1 + r) ** n)) / ((1 + r * type) * ((1 + r) ** n - 1));
    },
    MATCH: (c, a) => {
      const look = c.val(a[0]);
      const list = c.flat(c.ev(a[1]));
      const type = a[2] && a[2].k !== "missing" ? c.n(a[2]) : 1;
      if (type === 0) {
        const i = list.findIndex((v) => v !== null && compare(v, look) === 0 && typeof v === typeof look);
        return i < 0 ? ERR("#N/A") : i + 1;
      }
      let found = -1;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v === null || typeof v !== typeof look) continue;
        const cmp = compare(v, look);
        if (type > 0 ? cmp <= 0 : cmp >= 0) found = i; else break;
      }
      return found < 0 ? ERR("#N/A") : found + 1;
    },
    INDEX: (c, a) => {
      const r = c.ev(a[0]);
      if (!isRange(r)) return r;
      let row = a[1] && a[1].k !== "missing" ? c.n(a[1]) : 0;
      let col = a[2] && a[2].k !== "missing" ? c.n(a[2]) : 0;
      if (a.length < 3 && r.r1 === r.r2) { col = row; row = 1; }
      if (!row && r.r1 === r.r2) row = 1;
      if (!col && r.c1 === r.c2) col = 1;
      if (row < 0 || col < 0 || row > r.r2 - r.r1 + 1 || col > r.c2 - r.c1 + 1) return ERR("#REF!");
      if (!row || !col) return { range: true, sheet: r.sheet, r1: row ? r.r1 + row - 1 : r.r1, r2: row ? r.r1 + row - 1 : r.r2, c1: col ? r.c1 + col - 1 : r.c1, c2: col ? r.c1 + col - 1 : r.c2 };
      return c.cell(r.sheet, r.r1 + row - 1, r.c1 + col - 1);
    },
    VLOOKUP: (c, a) => {
      const look = c.val(a[0]), r = c.ev(a[1]), col = c.n(a[2]);
      const exact = a[3] && a[3].k !== "missing" && !bool(c.val(a[3]));
      let hit = -1;
      for (let row = r.r1; row <= r.r2; row++) {
        const v = c.cell(r.sheet, row, r.c1);
        if (v === null) continue;
        const cmp = compare(v, look);
        if (exact) { if (cmp === 0) { hit = row; break; } } else if (cmp <= 0) hit = row; else break;
      }
      return hit < 0 ? ERR("#N/A") : c.cell(r.sheet, hit, r.c1 + col - 1);
    },
    SUMIF: (c, a) => {
      const r = c.ev(a[0]), crit = c.val(a[1]), s = a[2] ? c.ev(a[2]) : r;
      const test = criteria(crit);
      let t = 0;
      for (let i = 0; i <= r.r2 - r.r1; i++) for (let j = 0; j <= r.c2 - r.c1; j++) {
        if (test(c.cell(r.sheet, r.r1 + i, r.c1 + j))) { const v = c.cell(s.sheet, s.r1 + i, s.c1 + j); if (typeof v === "number") t += v; }
      }
      return t;
    },
    COUNTIF: (c, a) => { const test = criteria(c.val(a[1])); return c.flat(c.ev(a[0])).filter(test).length; },
  };

  function criteria(crit) {
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(typeof crit === "string" ? crit : "");
    if (typeof crit !== "string") return (v) => compare(v, crit) === 0;
    const op = m[1] || "=", rhs = m[2] !== "" && Number.isFinite(Number(m[2])) ? Number(m[2]) : m[2];
    return (v) => {
      const cmp = compare(v, rhs);
      return { "=": cmp === 0, "<>": cmp !== 0, "<": cmp < 0, ">": cmp > 0, "<=": cmp <= 0, ">=": cmp >= 0 }[op];
    };
  }

  // Evaluation context for one workbook.
  class Calc {
    constructor(wb) { this.wb = wb; this.memo = new Map(); this.busy = new Set(); this.trees = new Map(); this.here = null; }

    cell(sheetName, r, c) {
      const sh = this.wb.sheet(sheetName);
      if (!sh) return ERR("#REF!");
      const x = sh.cells.get(key(r, c));
      if (!x) return null;
      if (!x.f) return x.v;
      const k = `${sheetName}!${key(r, c)}`;
      if (this.memo.has(k)) { const v = this.memo.get(k); if (isErr(v)) throw new XErr(v.e); return v; }
      if (this.busy.has(k)) return 0; // circular reference
      this.busy.add(k);
      const was = this.here;
      this.here = { sheet: sheetName, r, c };
      let v;
      try {
        if (!this.trees.has(x.f)) this.trees.set(x.f, parse(x.f));
        v = this.val(this.trees.get(x.f));
        if (typeof v === "number" && !Number.isFinite(v)) v = { e: "#NUM!" };
      } catch (e) {
        v = e instanceof XErr ? { e: e.e } : { e: "#NAME?" };
      } finally {
        this.here = was;
        this.busy.delete(k);
      }
      this.memo.set(k, v);
      if (isErr(v)) throw new XErr(v.e);
      return v;
    }

    // Value of a cell for display: errors as {e}.
    value(sheetName, r, c) {
      try { return this.cell(sheetName, r, c); } catch (e) { return e instanceof XErr ? { e: e.e } : { e: "#NAME?" }; }
    }

    range(node) {
      const sheet = node.sheet || this.here.sheet;
      const [a, b = a] = node.v.split(":");
      const sh = this.wb.sheet(sheet);
      if (!sh) ERR("#REF!");
      const end = (s, isStart) => {
        if (/^[A-Z]+$/.test(s)) return { c: colNum(s), r: isStart ? 1 : sh.maxRow };
        if (/^\d+$/.test(s)) return { c: isStart ? 1 : sh.maxCol, r: Number(s) };
        return parseRef(s);
      };
      const p = end(a, true), q = end(b, false);
      return { range: true, sheet, r1: Math.min(p.r, q.r), r2: Math.max(p.r, q.r), c1: Math.min(p.c, q.c), c2: Math.max(p.c, q.c) };
    }

    flat(v) {
      if (!isRange(v)) return [v];
      const out = [];
      for (let r = v.r1; r <= v.r2; r++) for (let c = v.c1; c <= v.c2; c++) out.push(this.cell(v.sheet, r, c));
      return out;
    }

    nums(args) {
      const out = [];
      for (const a of args) {
        if (a.k === "missing") continue;
        const v = this.ev(a);
        if (isRange(v)) { for (const x of this.flat(v)) if (typeof x === "number") out.push(x); else if (isErr(x)) ERR(x.e); }
        else out.push(num(v));
      }
      return out;
    }

    n(node) { return num(this.val(node)); }

    // Scalar value (a range gives the cell in the formula's own row or column).
    val(node) {
      const v = this.ev(node);
      if (!isRange(v)) return v;
      if (v.r1 === v.r2 && v.c1 === v.c2) return this.cell(v.sheet, v.r1, v.c1);
      const h = this.here;
      if (v.c1 === v.c2 && h && h.r >= v.r1 && h.r <= v.r2) return this.cell(v.sheet, h.r, v.c1);
      if (v.r1 === v.r2 && h && h.c >= v.c1 && h.c <= v.c2) return this.cell(v.sheet, v.r1, h.c);
      return ERR("#VALUE!");
    }

    ev(node) {
      switch (node.k) {
        case "num": case "str": case "bool": return node.v;
        case "missing": return null;
        case "err": return ERR(node.v);
        case "name": return ERR("#NAME?");
        case "ref": return this.range(node);
        case "neg": return -this.n(node.a);
        case "pct": return this.n(node.a) / 100;
        case "fn": { const f = FUNCS[node.name]; return f ? f(this, node.args) : ERR("#NAME?"); }
        case "bin": {
          const a = this.val(node.a), b = this.val(node.b);
          switch (node.op) {
            case "+": return num(a) + num(b);
            case "-": return num(a) - num(b);
            case "*": return num(a) * num(b);
            case "/": { const d = num(b); return d === 0 ? ERR("#DIV/0!") : num(a) / d; }
            case "^": return num(a) ** num(b);
            case "&": return str(a) + str(b);
            case "=": return compare(a, b) === 0;
            case "<>": return compare(a, b) !== 0;
            case "<": return compare(a, b) < 0;
            case ">": return compare(a, b) > 0;
            case "<=": return compare(a, b) <= 0;
            case ">=": return compare(a, b) >= 0;
          }
        }
      }
      return ERR("#VALUE!");
    }
  }

  // ---- Reading the workbook -------------------------------------------------------------------
  const resolvePath = (base, target) => {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const p of target.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
    return parts.join("/");
  };
  const relsPath = (p) => p.replace(/([^/]+)$/, "_rels/$1.rels");

  async function readRels(zip, part) {
    const f = zip.file(relsPath(part));
    const out = {};
    if (!f) return out;
    for (const r of deep(parseXml(await f.async("string")), "Relationship")) {
      out[attr(r, "Id")] = { target: attr(r, "TargetMode") === "External" ? attr(r, "Target") : resolvePath(part, attr(r, "Target")), type: attr(r, "Type") };
    }
    return out;
  }

  class Workbook {
    static async load(zip) {
      const wb = new Workbook();
      wb.zip = zip;
      const text = async (p) => (zip.file(p) ? zip.file(p).async("string") : null);
      const book = parseXml(await text("xl/workbook.xml"));
      const rels = await readRels(zip, "xl/workbook.xml");
      wb.activeTab = Number(attr(deep(book, "workbookView")[0], "activeTab") || 0);
      wb.sheets = deep(book, "sheet").map((s) => ({
        name: attr(s, "name"), hidden: !!attr(s, "state") && attr(s, "state") !== "visible",
        path: rels[s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")].target,
      }));
      // Theme colours, in the order cell styles number them.
      const themeRel = Object.values(rels).find((r) => /theme$/.test(r.type));
      wb.theme = [];
      if (themeRel) {
        const cs = deep(parseXml(await text(themeRel.target)), "clrScheme")[0];
        const c = (n) => { const e = kid(cs, n); const x = e && e.firstElementChild; return x ? (attr(x, "lastClr") || attr(x, "val") || "000000").toUpperCase() : "000000"; };
        wb.scheme = { dk1: c("dk1"), lt1: c("lt1"), dk2: c("dk2"), lt2: c("lt2"), accent1: c("accent1"), accent2: c("accent2"), accent3: c("accent3"),
          accent4: c("accent4"), accent5: c("accent5"), accent6: c("accent6"), hlink: c("hlink"), folHlink: c("folHlink") };
        const s = wb.scheme;
        wb.theme = [s.lt1, s.dk1, s.lt2, s.dk2, s.accent1, s.accent2, s.accent3, s.accent4, s.accent5, s.accent6, s.hlink, s.folHlink];
        Object.assign(wb.scheme, { tx1: s.dk1, bg1: s.lt1, tx2: s.dk2, bg2: s.lt2 });
      }
      const ssRel = Object.values(rels).find((r) => /sharedStrings$/.test(r.type));
      wb.strings = ssRel && zip.file(ssRel.target)
        ? deep(parseXml(await text(ssRel.target)), "si").map((si) => deep(si, "t").filter((t) => t.parentElement.localName !== "rPh").map((t) => t.textContent).join(""))
        : [];
      const stRel = Object.values(rels).find((r) => /styles$/.test(r.type));
      wb.styles = wb.readStyles(parseXml(await text(stRel.target)));
      wb.xml = {};
      for (const s of wb.sheets) wb.xml[s.name] = await text(s.path);
      wb.parsed = new Map();
      wb.calc = new Calc(wb);
      wb.drawings = {};
      for (const s of wb.sheets.filter((x) => !x.hidden)) wb.drawings[s.name] = await wb.readDrawing(s);
      return wb;
    }

    color(el) {
      if (!el || attr(el, "auto") === "1") return null;
      let c = null;
      if (attr(el, "rgb")) c = attr(el, "rgb").slice(-6).toUpperCase();
      else if (attr(el, "theme") !== null) c = this.theme[Number(attr(el, "theme"))] || null;
      else if (attr(el, "indexed") !== null) { const i = Number(attr(el, "indexed")); c = i === 64 ? "000000" : i === 65 ? "FFFFFF" : INDEXED[i] || null; }
      if (!c) return null;
      return tint(c, Number(attr(el, "tint") || 0));
    }

    readStyles(doc) {
      const fmts = new Map(deep(doc, "numFmt").map((n) => [Number(attr(n, "numFmtId")), attr(n, "formatCode")]));
      const root = doc.documentElement;
      const fonts = kids(kid(root, "fonts"), "font").map((f) => {
        const on = (n) => { const e = kid(f, n); return !!e && attr(e, "val") !== "0" && attr(e, "val") !== "false"; };
        return { b: on("b"), i: on("i"), u: !!kid(f, "u") && attr(kid(f, "u"), "val") !== "none", s: on("strike"),
          sz: Number(attr(kid(f, "sz"), "val") || 11), name: attr(kid(f, "name"), "val") || "Calibri", color: this.color(kid(f, "color")) };
      });
      const fills = kids(kid(root, "fills"), "fill").map((f) => {
        const p = kid(f, "patternFill");
        if (p) {
          const type = attr(p, "patternType");
          if (!type || type === "none") return null;
          return type === "solid" ? this.color(kid(p, "fgColor")) || this.color(kid(p, "bgColor")) : this.color(kid(p, "fgColor")) || this.color(kid(p, "bgColor"));
        }
        const g = kid(f, "gradientFill");
        return g ? this.color(kid(deep(g, "stop")[0], "color")) : null;
      });
      const borders = kids(kid(root, "borders"), "border").map((b) => {
        const side = (n) => { const e = kid(b, n); const st = attr(e, "style"); return st && st !== "none" ? { style: st, color: this.color(kid(e, "color")) || "000000" } : null; };
        return { left: side("left") || side("start"), right: side("right") || side("end"), top: side("top"), bottom: side("bottom") };
      });
      const xfs = kids(kid(root, "cellXfs"), "xf").map((x) => {
        const al = kid(x, "alignment");
        const id = Number(attr(x, "numFmtId") || 0);
        return {
          fmt: fmts.get(id) ?? BUILTIN[id] ?? "General", font: fonts[Number(attr(x, "fontId") || 0)] || fonts[0],
          fill: fills[Number(attr(x, "fillId") || 0)] || null, border: borders[Number(attr(x, "borderId") || 0)] || {},
          h: attr(al, "horizontal") || "general", v: attr(al, "vertical") || "bottom", wrap: attr(al, "wrapText") === "1" || attr(al, "wrapText") === "true",
          indent: Number(attr(al, "indent") || 0), rotate: Number(attr(al, "textRotation") || 0), shrink: attr(al, "shrinkToFit") === "1",
        };
      });
      return { xfs, fonts };
    }

    sheet(name) {
      if (this.parsed.has(name)) return this.parsed.get(name);
      const xmlText = this.xml[name];
      if (!xmlText) return null;
      const sh = this.readSheet(name, parseXml(xmlText));
      this.parsed.set(name, sh);
      return sh;
    }

    readSheet(name, doc) {
      const root = doc.documentElement;
      const fmtPr = kid(root, "sheetFormatPr");
      const sh = {
        name, cols: new Map(), rows: new Map(), cells: new Map(), merges: [],
        defaultW: Number(attr(fmtPr, "defaultColWidth") || (Number(attr(fmtPr, "baseColWidth") || 8) + 0.71)),
        defaultH: Number(attr(fmtPr, "defaultRowHeight") || 15), maxRow: 1, maxCol: 1,
      };
      const view = deep(root, "sheetView")[0];
      sh.grid = attr(view, "showGridLines") !== "0";
      sh.zoom = Number(attr(view, "zoomScale") || 100) / 100;
      for (const c of deep(kid(root, "cols"), "col")) {
        for (let i = Number(attr(c, "min")); i <= Math.min(Number(attr(c, "max")), 300); i++) {
          sh.cols.set(i, { w: attr(c, "width") !== null ? Number(attr(c, "width")) : null, hidden: attr(c, "hidden") === "1", s: attr(c, "style") !== null ? Number(attr(c, "style")) : null });
        }
      }
      const shared = {};
      for (const row of kids(kid(root, "sheetData"), "row")) {
        const r = Number(attr(row, "r"));
        sh.rows.set(r, { ht: attr(row, "ht") !== null ? Number(attr(row, "ht")) : null, hidden: attr(row, "hidden") === "1",
          s: attr(row, "customFormat") === "1" ? Number(attr(row, "s") || 0) : null });
        for (const c of kids(row, "c")) {
          const p = parseRef(attr(c, "r"));
          const t = attr(c, "t");
          const vEl = kid(c, "v"), fEl = kid(c, "f");
          let v = null;
          if (t === "s") v = this.strings[Number(vEl?.textContent)] ?? "";
          else if (t === "inlineStr") v = deep(c, "t").map((x) => x.textContent).join("");
          else if (t === "str") v = vEl ? vEl.textContent : "";
          else if (t === "b") v = vEl ? vEl.textContent === "1" : null;
          else if (t === "e") v = vEl ? { e: vEl.textContent } : null;
          else if (vEl) v = Number(vEl.textContent);
          let f = null;
          if (fEl) {
            const ft = attr(fEl, "t");
            if (ft === "shared") {
              const si = attr(fEl, "si");
              if (fEl.textContent) { shared[si] = { f: fEl.textContent, r: p.r, c: p.c }; f = fEl.textContent; }
              else if (shared[si]) f = shift(shared[si].f, p.r - shared[si].r, p.c - shared[si].c);
            } else f = fEl.textContent || null;
          }
          sh.cells.set(key(p.r, p.c), { r: p.r, c: p.c, s: attr(c, "s") !== null ? Number(attr(c, "s")) : null, v, f });
          if (v !== null || f) { sh.maxRow = Math.max(sh.maxRow, p.r); sh.maxCol = Math.max(sh.maxCol, p.c); }
        }
      }
      for (const m of deep(kid(root, "mergeCells"), "mergeCell")) {
        const [a, b] = attr(m, "ref").split(":").map(parseRef);
        if (a && b) sh.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
      }
      return sh;
    }

    async readDrawing(s) {
      const rels = await readRels(this.zip, s.path);
      const doc = parseXml(this.xml[s.name]);
      const dEl = deep(doc, "drawing")[0];
      if (!dEl) return [];
      const rid = dEl.getAttribute("r:id") || dEl.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const path = rels[rid]?.target;
      if (!path || !this.zip.file(path)) return [];
      const drels = await readRels(this.zip, path);
      const dd = parseXml(await this.zip.file(path).async("string"));
      const out = [];
      for (const a of [...dd.documentElement.children]) {
        const pos = (el) => el && { c: Number(deep(el, "col")[0].textContent), co: Number(deep(el, "colOff")[0].textContent) / EMU,
          r: Number(deep(el, "row")[0].textContent), ro: Number(deep(el, "rowOff")[0].textContent) / EMU };
        const ext = kid(a, "ext");
        const item = { from: pos(kid(a, "from")), to: pos(kid(a, "to")),
          w: ext ? Number(attr(ext, "cx")) / EMU : null, h: ext ? Number(attr(ext, "cy")) / EMU : null };
        if (a.localName === "absoluteAnchor") {
          const p = kid(a, "pos");
          item.abs = { x: Number(attr(p, "x")) / EMU, y: Number(attr(p, "y")) / EMU };
        }
        const blip = deep(a, "blip")[0];
        const chart = deep(a, "chart")[0];
        if (blip) {
          const id = blip.getAttribute("r:embed") || blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
          const media = drels[id]?.target;
          if (!media || !this.zip.file(media)) continue;
          const type = /\.png$/i.test(media) ? "image/png" : /\.gif$/i.test(media) ? "image/gif" : /\.svg$/i.test(media) ? "image/svg+xml" : "image/jpeg";
          item.img = URL.createObjectURL(new Blob([await this.zip.file(media).async("arraybuffer")], { type }));
        } else if (chart) {
          const id = chart.getAttribute("r:id") || chart.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
          const cp = drels[id]?.target;
          if (!cp || !this.zip.file(cp)) continue;
          item.chart = parseXml(await this.zip.file(cp).async("string"));
        } else continue;
        out.push(item);
      }
      return out;
    }

    xf(sh, r, c) {
      const cell = sh.cells.get(key(r, c));
      const s = cell && cell.s !== null ? cell.s : sh.rows.get(r)?.s ?? sh.cols.get(c)?.s ?? 0;
      return { id: s, ...this.styles.xfs[s] };
    }

    value(name, r, c) { return this.calc.value(name, r, c); }
    raw(name, r, c) { return this.sheet(name)?.cells.get(key(r, c)) || null; }
  }

  // ---- Drawing the sheet ---------------------------------------------------------------------
  const colPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);
  const rowPx = (pt) => Math.round((pt * 96) / 72);

  const BORDER = {
    thin: "1px solid", hair: "1px solid", dotted: "1px dotted", dashed: "1px dashed", dashDot: "1px dashed", dashDotDot: "1px dashed",
    medium: "2px solid", mediumDashed: "2px dashed", mediumDashDot: "2px dashed", mediumDashDotDot: "2px dashed", slantDashDot: "2px dashed",
    thick: "3px solid", double: "3px double",
  };
  // Modern look (opts.modern): the sheet's content and colours, drawn like a web dashboard
  // rather than Excel: the app's font, soft grey lines, lighter pastel fills, no grid headings.
  const luma = (hex) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const mix = (hex, to, t) => [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + parseInt(to.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("").toUpperCase();
  const softFill = (hex) => (luma(hex) > 0.5 ? mix(hex, "FFFFFF", 0.6) : mix(hex, "1F3864", 0.15));
  const softLine = (hex) => (luma(hex) < 0.35 ? "D3DAE6" : mix(hex, "FFFFFF", 0.3));
  const MODERN_FONT = 'Inter,"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif';
  // In the dashboard look, thin column lines go away and thin row lines turn hairline grey.
  const borderCss = (b, modern, vertical) => {
    if (!b) return null;
    if (!modern) return `${BORDER[b.style] || "1px solid"} #${b.color}`;
    const heavy = /thick|double|medium/.test(b.style);
    if (vertical && !heavy) return "none";
    return heavy ? `2px solid #${softLine(b.color)}` : "1px solid #E7EBF2";
  };

  function fontCss(font, modern) {
    const fam = String(font.name).replace(/["\\]/g, "");
    if (modern) {
      return `font-family:${MODERN_FONT};font-size:${Math.max(8, font.sz - 1)}pt;${font.b ? "font-weight:600;" : ""}${font.i ? "font-style:italic;" : ""}`
        + `${font.u ? "text-decoration:underline;" : ""}${font.color ? `color:#${font.color === "000000" ? "1D2433" : font.color};` : "color:#1D2433;"}`;
    }
    return `font-family:"${fam}",Calibri,Arial,sans-serif;font-size:${font.sz}pt;${font.b ? "font-weight:700;" : ""}${font.i ? "font-style:italic;" : ""}`
      + `${font.u || font.s ? `text-decoration:${font.u ? "underline" : ""} ${font.s ? "line-through" : ""};` : ""}${font.color ? `color:#${font.color};` : ""}`;
  }

  // Lays out a sheet: visible columns and rows with their pixel sizes, and how far the sheet goes.
  // opts.showHidden: show columns and rows the sheet hides; opts.hideRows: rows to leave out;
  // opts.rows / opts.cols: Sets of the only rows / columns to show; opts.colW: {column: min px}.
  function layout(wb, name, opts = {}) {
    const sh = wb.sheet(name);
    let maxR = sh.maxRow, maxC = sh.maxCol;
    for (const x of sh.cells.values()) {
      if (x.s === null) continue;
      const st = wb.styles.xfs[x.s];
      if (st && (st.fill || st.border.left || st.border.right || st.border.top || st.border.bottom)) { maxR = Math.max(maxR, x.r); maxC = Math.max(maxC, x.c); }
    }
    for (const m of sh.merges) { maxR = Math.max(maxR, m.r2); maxC = Math.max(maxC, m.c2); }
    for (const d of wb.drawings[name] || []) if (d.to) { maxR = Math.max(maxR, d.to.r + 1); maxC = Math.max(maxC, d.to.c + 1); }
    maxR = Math.min(maxR + 3, MAX_ROWS);
    maxC = Math.min(maxC + 2, MAX_COLS);
    const cols = [], colX = [0];
    for (let c = 1; c <= maxC; c++) {
      const info = sh.cols.get(c);
      const w = (info?.hidden && !opts.showHidden) || (opts.cols && !opts.cols.has(c)) ? 0 : Math.max(colPx(info?.w || sh.defaultW), opts.colW?.[c] || 0);
      if (w) cols.push({ c, w });
      colX[c] = colX[c - 1] + w;
    }
    const rows = [], rowY = [0];
    for (let r = 1; r <= maxR; r++) {
      const info = sh.rows.get(r);
      const h = (info?.hidden && !opts.showHidden) || opts.hideRows?.has(r) || (opts.rows && !opts.rows.has(r)) ? 0 : rowPx(info?.ht || sh.defaultH);
      if (h) rows.push({ r, h });
      rowY[r] = rowY[r - 1] + h;
    }
    return { sh, cols, rows, colX, rowY, maxR, maxC };
  }

  // HTML for one sheet. opts: {zoom, showHidden, hideRows, isEdited(r, c), isEditable(r, c),
  // decorate(r, c) -> {cls, before} to add a class and HTML before a cell's text, text(r, c) -> text
  // to show instead of the cell's, rows, cols, colW (see layout)}.
  function render(wb, name, host, opts = {}) {
    const L = layout(wb, name, opts);
    const modern = !!opts.modern;
    const HW = modern ? 0 : HEAD_W, HH = modern ? 0 : HEAD_H;
    const bcss = (b, vertical) => borderCss(b, modern, vertical);
    const { sh, cols, rows } = L;
    const visibleCol = new Set(cols.map((x) => x.c)), visibleRow = new Set(rows.map((x) => x.r));
    const covered = new Set(), mergeAt = new Map();
    for (const m of sh.merges) {
      mergeAt.set(key(m.r1, m.c1), m);
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(key(r, c));
    }
    const mergeOf = (r, c) => { for (const m of sh.merges) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m; return null; };
    const xfAt = (r, c) => { const m = mergeOf(r, c); return wb.xf(sh, m ? m.r1 : r, m ? m.c1 : c); };
    const fillAt = (r, c) => (r < 1 || c < 1 ? null : xfAt(r, c).fill);
    const own = (r, c, side) => wb.xf(sh, r, c).border[side];
    const edge = (r, c, side) => {
      const opp = { right: ["left", 0, 1], bottom: ["top", 1, 0], left: ["right", 0, -1], top: ["bottom", -1, 0] }[side];
      return own(r, c, side) || (r + opp[1] >= 1 && c + opp[2] >= 1 ? own(r + opp[1], c + opp[2], opp[0]) : null);
    };
    const grid = (a, b) => (sh.grid && !a && !b && !modern ? "1px solid #e1e3e6" : "none");
    const width = cols.reduce((a, x) => a + x.w, 0) + HW;
    const empty = (r, c) => { const x = sh.cells.get(key(r, c)); return !x || ((x.v === null || x.v === "") && !x.f); };

    let html = `<table class="xl-grid${modern ? " xl-modern" : ""}" style="width:${width}px"><colgroup>${modern ? "" : `<col style="width:${HEAD_W}px">`}${cols.map((x) => `<col style="width:${x.w}px">`).join("")}</colgroup>`;
    html += modern ? "<tbody>" : `<thead><tr><th class="xl-corner"></th>${cols.map((x) => `<th class="xl-ch" data-c="${x.c}">${colName(x.c)}</th>`).join("")}</tr></thead><tbody>`;
    const firstCol = cols[0]?.c, firstRow = rows[0]?.r;
    for (const { r, h } of rows) {
      html += `<tr style="height:${h}px">${modern ? "" : `<th class="xl-rh" data-r="${r}">${r}</th>`}`;
      for (const { c } of cols) {
        if (covered.has(key(r, c))) continue;
        const m = mergeAt.get(key(r, c));
        let cs = 1, rs = 1, hgt = h, r2 = r, c2 = c;
        if (m) {
          r2 = m.r2; c2 = m.c2;
          cs = 0; for (let x = m.c1; x <= m.c2; x++) if (visibleCol.has(x)) cs++;
          rs = 0; hgt = 0; for (let y = m.r1; y <= m.r2; y++) if (visibleRow.has(y)) { rs++; hgt += L.rowY[y] - L.rowY[y - 1]; }
          if (!cs || !rs) continue;
        }
        const st = wb.xf(sh, r, c);
        const v = wb.value(name, r, c);
        const over = opts.text ? opts.text(r, c) : undefined;
        const fmt = over !== undefined ? { text: over } : format(v, st.fmt);
        const fill = st.fill;
        const right = bcss(edge(r, c2, "right"), true) || grid(fill, fillAt(r, c2 + 1));
        const bottom = bcss(edge(r2, c, "bottom")) || grid(fill, fillAt(r2 + 1, c));
        let style = `border-right:${right};border-bottom:${bottom};`;
        if (c === firstCol) style += `border-left:${bcss(own(r, c, "left"), true) || "none"};`;
        if (r === firstRow) style += `border-top:${bcss(own(r, c, "top")) || "none"};`;
        if (fill) style += `background:#${modern ? softFill(fill) : fill};`;
        if (fmt.color) style += `color:${fmt.color};`;
        let hAlign = st.h;
        if (hAlign === "general") hAlign = typeof v === "number" ? "right" : typeof v === "boolean" || (v && v.e) ? "center" : "left";
        if (hAlign === "centerContinuous" || hAlign === "distributed") hAlign = "center";
        if (hAlign === "fill" || hAlign === "justify") hAlign = "left";
        const vAlign = { top: "flex-start", center: "center", bottom: "flex-end", justify: "center", distributed: "center" }[st.v] || "flex-end";
        // Text runs into empty cells on its right, as in Excel.
        let spill = false;
        if (!st.wrap && typeof v === "string" && v && !m && hAlign !== "right") spill = empty(r, c + 1);
        const cls = [`xl-x${st.id}`];
        const deco = opts.decorate ? opts.decorate(r, c) : null;
        if (deco?.cls) cls.push(deco.cls);
        if (opts.isEdited && opts.isEdited(r, c)) cls.push("xl-edited");
        if (opts.isEditable && !opts.isEditable(r, c)) cls.push("xl-ro");
        const span = `${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}`;
        const content = fmt.left !== null && fmt.left !== undefined
          ? `<span class="xl-l">${esc(fmt.left)}</span><span>${esc(fmt.text)}</span>`
          : esc(fmt.text);
        const inner = `display:flex;align-items:${vAlign};justify-content:${fmt.left != null ? "space-between" : hAlign === "center" ? "center" : hAlign === "right" ? "flex-end" : "flex-start"};`
          + `text-align:${hAlign};height:${hgt - 1}px;${st.indent ? `padding-${hAlign === "right" ? "right" : "left"}:${st.indent * 9}px;` : ""}`
          + `${st.wrap ? "white-space:pre-wrap;" : ""}${spill ? "overflow:visible;" : ""}${st.rotate === 90 || st.rotate === 180 ? "writing-mode:vertical-rl;transform:rotate(180deg);" : st.rotate === 255 ? "writing-mode:vertical-rl;" : ""}`;
        const tip = modern && typeof v === "string" && v.length > 12 && !spill && !st.wrap ? ` title="${esc(v)}"` : "";
        html += `<td class="${cls.join(" ")}" data-r="${r}" data-c="${c}"${span}${tip} style="${style}"><div class="xl-c" style="${inner}">${deco?.before || ""}${content}</div></td>`;
      }
      html += "</tr>";
    }
    html += "</tbody></table>";

    // Pictures and charts over the cells.
    const colGone = (c) => L.colX[c] === L.colX[c - 1], rowGone = (r) => L.rowY[r] === L.rowY[r - 1];
    const at = (p) => ({ x: HW + L.colX[Math.min(p.c, L.maxC)] + (colGone(p.c + 1) ? 0 : p.co), y: HH + L.rowY[Math.min(p.r, L.maxR)] + (rowGone(p.r + 1) ? 0 : p.ro) });
    let draw = "";
    for (const d of wb.drawings[name] || []) {
      if (opts.rows && (d.abs || !opts.rows.has(d.from.r + 1))) continue;
      let x, y, w, hh;
      if (d.abs) { x = HW + d.abs.x; y = HH + d.abs.y; w = d.w; hh = d.h; }
      else {
        const a = at(d.from);
        x = a.x; y = a.y;
        if (d.to) { const b = at(d.to); w = b.x - a.x; hh = b.y - a.y; } else { w = d.w; hh = d.h; }
      }
      if (!w || !hh) continue;
      const box = `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
      if (d.img) draw += `<img class="xl-pic" src="${d.img}" alt="" style="${box}">`;
      else if (d.chart) draw += `<div class="xl-chart" style="${box}">${chartSvg(wb, d.chart, w, hh)}</div>`;
    }

    // Styles for the cells' fonts, one class per cell style used.
    const used = new Set();
    for (const m of html.matchAll(/xl-x(\d+)/g)) used.add(Number(m[1]));
    const css = [...used].map((i) => `.xl-x${i}{${fontCss(wb.styles.xfs[i]?.font || wb.styles.fonts[0], modern)}}`).join("");
    host.innerHTML = `<style>${css}</style><div class="xl-sheet" style="zoom:${opts.zoom || 1}">${html}<div class="xl-draw">${draw}</div></div>`;
    return L;
  }

  // ---- Charts --------------------------------------------------------------------------------
  function drawColor(wb, el) {
    if (!el) return null;
    const c = kid(el, "srgbClr") || kid(el, "schemeClr") || kid(el, "sysClr") || kid(el, "prstClr");
    if (!c) return null;
    let v = c.localName === "srgbClr" ? attr(c, "val") : c.localName === "sysClr" ? attr(c, "lastClr") || "000000"
      : c.localName === "schemeClr" ? wb.scheme?.[attr(c, "val")] || "000000" : { black: "000000", white: "FFFFFF" }[attr(c, "val")] || "000000";
    const mod = kid(c, "lumMod"), off = kid(c, "lumOff"), shade = kid(c, "shade"), tnt = kid(c, "tint");
    v = lum(v, mod ? Number(attr(mod, "val")) / 100000 : 1, off ? Number(attr(off, "val")) / 100000 : 0);
    if (shade) v = lum(v, Number(attr(shade, "val")) / 100000);
    if (tnt) { const t = Number(attr(tnt, "val")) / 100000; v = tint(v, 1 - t); }
    return `#${v}`;
  }
  const fillOf = (wb, spPr) => {
    if (!spPr) return undefined;
    if (kid(spPr, "noFill")) return "none";
    if (kid(spPr, "solidFill")) return drawColor(wb, kid(spPr, "solidFill"));
    const g = kid(spPr, "gradFill");
    if (g) { const stops = deep(g, "gs"); return drawColor(wb, stops[Math.floor(stops.length / 2)] || stops[0]); }
    return undefined;
  };

  function niceStep(max) {
    if (max <= 0) return 1;
    const raw = max / 5, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  function chartSvg(wb, doc, W, H, light = false) {
    const space = doc.documentElement;
    const chart = kid(space, "chart");
    const plot = kid(chart, "plotArea");
    const bar = deep(plot, "barChart")[0];
    const bg = light ? "#FFFFFF" : fillOf(wb, kid(space, "spPr")) || "#FFFFFF";
    const dark = (() => { const m = /^#(..)(..)(..)$/.exec(bg || ""); if (!m) return false; const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16)); return 0.299 * r + 0.587 * g + 0.114 * b < 128; })();
    const ink = dark ? "#D9D9D9" : "#595959";
    const title = deep(kid(chart, "title"), "t").map((t) => t.textContent).join("");
    const refVals = (ref) => {
      const f = deep(ref, "f")[0];
      if (!f) return deep(ref, "v").map((v) => (Number.isFinite(Number(v.textContent)) ? Number(v.textContent) : v.textContent));
      try { return wb.calc.flat(wb.calc.range(parse(f.textContent))); } catch { return []; }
    };
    const series = bar ? kids(bar, "ser").map((s, i) => ({
      name: deep(kid(s, "tx"), "v")[0]?.textContent || "", cats: refVals(kid(s, "cat")), vals: refVals(kid(s, "val")).map((v) => (typeof v === "number" ? v : 0)),
      color: ((c) => (light && c && /^#([0-9A-F]{2})\1\1$/i.test(c) ? "#0f766e" : c))(fillOf(wb, kid(s, "spPr"))) || `#${wb.scheme?.[`accent${(i % 6) + 1}`] || "4472C4"}`,
    })) : [];
    const valAx = deep(plot, "valAx")[0];
    const axFmt = attr(kid(valAx, "numFmt"), "formatCode") || "General";
    const cats = series[0]?.cats || [];
    const n = Math.max(cats.length, ...series.map((s) => s.vals.length), 1);
    const max = Math.max(0, ...series.flatMap((s) => s.vals));
    const step = niceStep(max), top = Math.max(step, Math.ceil(max / step) * step);
    const label = (v) => format(v, axFmt === "General" ? "#,##0" : axFmt).text.trim();
    const padL = Math.min(90, 14 + 7 * Math.max(...[0, top].map((v) => label(v).length))), padT = title ? 34 : 12, padB = 26, padR = 12;
    const pw = Math.max(10, W - padL - padR), ph = Math.max(10, H - padT - padB);
    const bw = (pw / n) * 0.62 / Math.max(series.length, 1);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="${light ? MODERN_FONT.replace(/"/g, "'") : "Calibri,Arial,sans-serif"}">`;
    svg += `<rect width="${W}" height="${H}" fill="${bg === "none" ? "transparent" : bg}"/>`;
    if (title) svg += `<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="700" fill="${ink}">${esc(title)}</text>`;
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = padT + ph - (v / top) * ph;
      svg += `<line x1="${padL}" x2="${padL + pw}" y1="${y}" y2="${y}" stroke="${dark ? "#555" : "#D9D9D9"}" stroke-width="0.75"/>`;
      svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="${ink}">${esc(label(v))}</text>`;
    }
    for (let i = 0; i < n; i++) {
      const cx = padL + (pw / n) * (i + 0.5);
      series.forEach((s, j) => {
        const v = s.vals[i] || 0;
        const hh = (Math.max(0, v) / top) * ph;
        const x = cx - (bw * series.length) / 2 + j * bw;
        if (hh > 0) svg += `<rect x="${x}" y="${padT + ph - hh}" width="${bw}" height="${hh}" fill="${s.color}"><title>${esc(String(cats[i] ?? ""))}: ${esc(label(v))}</title></rect>`;
      });
      const c = cats[i];
      if (c !== undefined && c !== null) svg += `<text x="${cx}" y="${padT + ph + 16}" text-anchor="middle" font-size="10" fill="${ink}">${esc(typeof c === "number" ? general(c) : c)}</text>`;
    }
    return svg + "</svg>";
  }

  return { load: (zip) => Workbook.load(zip), render, chart: chartSvg, format, parse, colName, colNum, refOf, parseRef, toSerial, fromSerial, HEAD_W, HEAD_H };
})();
globalThis.SheetView = SheetView;
