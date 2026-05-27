// Vercel serverless function — cloud sync backed by Supabase.
// Holds the SECRET key server-side; the browser only sends a passcode.
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   SUPABASE_URL    e.g. https://xxxx.supabase.co
//   SUPABASE_SECRET the sb_secret_... key (server-side only, NEVER in client)
//   SYNC_PASSCODE   any password you choose; the app sends it as x-pass header
//
// Table (run once in Supabase SQL editor):
//   create table app_state ( id text primary key, data jsonb not null, updated_at timestamptz default now() );
//
// GET  -> { rev, data }   (your saved blob)
// POST { rev, data } -> upserts the single row id='me'

const ROW_ID = "me";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pass");
  if (req.method === "OPTIONS") return res.status(200).end();

  const URL = process.env.SUPABASE_URL;
  const SECRET = process.env.SUPABASE_SECRET;
  const PASS = process.env.SYNC_PASSCODE;
  if (!URL || !SECRET || !PASS) {
    return res.status(500).json({ error: "Server not configured. Set SUPABASE_URL, SUPABASE_SECRET, SYNC_PASSCODE in Vercel." });
  }

  // passcode gate
  const sent = req.headers["x-pass"];
  if (!sent || sent !== PASS) return res.status(401).json({ error: "Bad or missing passcode." });

  const base = `${URL.replace(/\/$/, "")}/rest/v1/app_state`;
  const sbHeaders = {
    apikey: SECRET,
    Authorization: `Bearer ${SECRET}`,
    "Content-Type": "application/json",
  };

  try {
    if (req.method === "GET") {
      const r = await fetch(`${base}?id=eq.${ROW_ID}&select=data`, { headers: sbHeaders });
      const rows = await r.json().catch(() => []);
      if (!r.ok) return res.status(r.status).json({ error: "Supabase read failed", detail: rows });
      const row = Array.isArray(rows) && rows[0] ? rows[0].data : null;
      return res.status(200).json(row || { rev: 0, data: {} });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const payload = { rev: Number(body.rev) || Date.now(), data: body.data || {} };
      const r = await fetch(`${base}?on_conflict=id`, {
        method: "POST",
        headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ id: ROW_ID, data: payload, updated_at: new Date().toISOString() }]),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: "Supabase write failed", detail });
      }
      return res.status(200).json({ ok: true, rev: payload.rev });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
};
