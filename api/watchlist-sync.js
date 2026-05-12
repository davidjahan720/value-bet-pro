// Vercel Serverless Function - Sync de la watchlist client -> Vercel Blob
// Le cron veille en a besoin pour inclure les equipes etoilees par l'utilisateur.
//
// POST  /api/watchlist-sync  body: { keys: ["Team1|F1", "Team2|SP1", ...] }
// GET   /api/watchlist-sync  -> { keys: [...] }
//
// Pas d'auth : projet perso single-user. Risque accepte : quiconque connaitrait
// le endpoint peut ecraser la liste. Pour la prod multi-user il faudrait CRON_SECRET.

import { put, list } from "@vercel/blob";

const BLOB_PATHNAME = "veille/watchlist.json";

async function loadWatchlist() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const r = await list({ prefix: BLOB_PATHNAME, token });
    const found = r.blobs?.find(b => b.pathname === BLOB_PATHNAME);
    if (!found) return null;
    const fetched = await fetch(found.url);
    if (!fetched.ok) return null;
    return await fetched.json();
  } catch {
    return null;
  }
}

async function saveWatchlist(payload) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN non configure");
  await put(BLOB_PATHNAME, JSON.stringify(payload, null, 2), {
    access: "public",
    contentType: "application/json",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const stored = await loadWatchlist();
      return res.status(200).json(stored || { keys: [], updatedAt: null });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const keys = Array.isArray(body.keys) ? body.keys.filter(k => typeof k === "string" && k.includes("|")) : [];
      const payload = {
        keys: keys.slice(0, 50), // limite raisonnable
        updatedAt: new Date().toISOString(),
      };
      await saveWatchlist(payload);
      return res.status(200).json({ ok: true, count: payload.keys.length });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
