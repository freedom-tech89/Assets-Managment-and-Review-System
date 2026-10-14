// Vercel serverless function: every /api/* request is routed here (see vercel.json).
import { handle } from "../lib/api.js";

export default function handler(req, res) {
  return handle(req, res);
}
