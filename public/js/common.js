// Small helpers shared by the admin panel and the dashboards.
// Shown at the bottom of every page, so it is easy to tell which version a deployment runs.
const APP_VERSION = "2026-10-17.2";
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const tidy = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).join(" ");

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Calls the server API. Sends JSON unless `raw` is given; returns parsed JSON or a Blob.
async function api(method, url, body, raw) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: raw ? { "Content-Type": "application/octet-stream" } : body !== undefined ? { "Content-Type": "application/json" } : {},
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const type = res.headers.get("Content-Type") || "";
  if (!res.ok) {
    let message = res.statusText || "Request failed";
    if (type.includes("json")) { try { message = (await res.json()).error || message; } catch {} }
    else if (res.status === 413) message = "The file is too large to upload.";
    if (res.status === 401 && url !== "/login") window.dispatchEvent(new Event("logged-out"));
    throw new ApiError(res.status, message);
  }
  return type.includes("json") ? res.json() : res.blob();
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

const fmt = {
  money: (v) => (v === null || v === undefined ? "–" : `${v < 0 ? "-" : ""}₹${inr.format(Math.abs(v))}`),
  money2: (v) => (v === null || v === undefined ? "–" : inr2.format(v)),
  qty: (v) => (v === null || v === undefined ? "–" : qtyFmt.format(v)),
  pct: (v) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(2)}%`),
  signCls: (v) => (v > 0 ? "pos" : v < 0 ? "neg" : ""),
  date: (s) => {
    if (!s) return "–";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${m[3]} ${months[+m[2] - 1]} ${m[1]}`;
  },
};

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const xlsxBlob = (buffer) => new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

function reportName(label, kind) {
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  const safe = label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || kind;
  return `${safe}_${kind}_Report_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
}

async function sha256(buffer) {
  if (!crypto.subtle) return null; // only available on https or localhost
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
