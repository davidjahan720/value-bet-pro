// Vercel Serverless Function - Lecture du store de veille
// Public (pas d'auth) : renvoie le JSON courant depuis Vercel Blob
// Recalcule la decision a la volee (au cas ou des events ont expire depuis la derniere ecriture)

import { list } from "@vercel/blob";
import { computeDecision } from "./decision-matrix.js";

const BLOB_PATHNAME = "veille/latest.json";

export default async function handler(req, res) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return res.status(200).json({
        lastUpdate: null,
        teams: {},
        warning: "BLOB_READ_WRITE_TOKEN non configure - veille indisponible",
      });
    }

    const r = await list({ prefix: BLOB_PATHNAME, token });
    const found = r.blobs?.find(b => b.pathname === BLOB_PATHNAME);
    if (!found) {
      return res.status(200).json({
        lastUpdate: null,
        teams: {},
        warning: "Aucune veille generee pour le moment - en attente du premier cron",
      });
    }

    const fetched = await fetch(found.url);
    if (!fetched.ok) {
      return res.status(500).json({ error: `Blob fetch failed ${fetched.status}` });
    }
    const store = await fetched.json();

    // Recalcule live des decisions (au cas ou des events ont expire depuis l'ecriture)
    const nowIso = new Date().toISOString();
    for (const [k, t] of Object.entries(store.teams || {})) {
      const d = computeDecision(t.events || [], nowIso);
      t.score = d.score;
      t.decision = d.decision;
      t.stake_recommended_eur = d.stake_recommended_eur;
      t.color = d.color;
      t.label = d.label;
      t.activeEventsCount = d.activeEvents.length;
      t.activeEvents = d.activeEvents;
    }

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(store);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
