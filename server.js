// Local server: serves the web page from public/ and the API from lib/api.js.
// Run with `npm start`, then open http://localhost:3000.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./lib/api.js";
import { usingDefaultPassword } from "./lib/auth.js";
import { DATABASE_URL } from "./lib/db.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) return handle(req, res);
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`Upload Details running at http://localhost:${PORT}`);
  console.log(DATABASE_URL ? "Database: PostgreSQL (DATABASE_URL)" : "Database: built-in local database in ./data");
  if (usingDefaultPassword()) console.log('Admin password: "admin" (set ADMIN_PASSWORD to change it)');
});
