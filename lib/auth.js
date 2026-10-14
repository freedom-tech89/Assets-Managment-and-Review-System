// Admin login: one password (ADMIN_PASSWORD) and a signed, HttpOnly session cookie.
import crypto from "node:crypto";

const COOKIE = "ud_session";
const MAX_AGE = 60 * 60 * 12; // 12 hours

export function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.VERCEL) return null; // never run a public deployment with a default password
  return "admin";
}

export const usingDefaultPassword = () => !process.env.ADMIN_PASSWORD && !process.env.VERCEL;

function secret() {
  return process.env.SESSION_SECRET || `ud:${adminPassword() || ""}`;
}

const sign = (value) => crypto.createHmac("sha256", secret()).update(value).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function checkPassword(given) {
  const expected = adminPassword();
  return expected !== null && safeEqual(given || "", expected);
}

export function sessionCookie(secure) {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE;
  const value = `admin.${expires}`;
  return `${COOKIE}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function isLoggedIn(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw || adminPassword() === null) return false;
  const [role, expires, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (role !== "admin" || !sig || Number(expires) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(`${role}.${expires}`));
}
