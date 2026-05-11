// Vercel Serverless Function - Cron quotidien de veille evenementielle
// Schedule : "0 7 * * *" (07h00 UTC chaque jour)
// Protege par CRON_SECRET (Vercel envoie automatiquement Authorization: Bearer <secret>)
//
// Pipeline :
//   1. Pour chaque equipe (3) : fetch Google News RSS (24h, langue FR)
//   2. Envoie les titres a Mistral pour categorisation + scoring V+O2.5
//   3. Fusionne avec store existant (Vercel Blob), deduplique par URL
//   4. Calcule la decision finale via decision-matrix.js
//   5. Persiste dans veille/latest.json (Vercel Blob)

import { put, list } from "@vercel/blob";
import { CATEGORIES, computeDecision } from "./decision-matrix.js";

const TEAMS = [
  { key: "aston_villa",     name: "Aston Villa",      league: "Premier League", searchTerms: '"Aston Villa"' },
  { key: "atletico_madrid", name: "Atletico Madrid",  league: "LaLiga",         searchTerms: '"Atletico Madrid" OR "Atletico de Madrid"' },
  { key: "lorient",         name: "FC Lorient",       league: "Ligue 1 FRA",    searchTerms: '"FC Lorient" OR "Lorient"' },
];

const BLOB_PATHNAME  = "veille/latest.json";
const MISTRAL_MODEL  = "mistral-small-latest";
const MAX_HEADLINES  = 15;

function decodeXmlEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title   = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const link    = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    const sourceM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    items.push({
      title:   decodeXmlEntities(title).trim(),
      url:     link.trim(),
      pubDate: pubDate.trim(),
      source:  sourceM ? decodeXmlEntities(sourceM[1]).trim() : "",
    });
  }
  return items;
}

async function fetchGoogleNewsRss(team) {
  const keywords = "(blessure OR transfert OR suspension OR coach OR entraineur OR injury OR transfer OR signing OR sanction)";
  const q = encodeURIComponent(`${team.searchTerms} ${keywords}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=fr&gl=FR&ceid=FR:fr&when=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ValueBetPro/1.0" } });
  if (!r.ok) return [];
  const xml = await r.text();
  return parseRssItems(xml);
}

async function categorizeWithMistral(team, headlines) {
  if (!headlines.length) return [];
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY non configure");

  const categoriesList = Object.entries(CATEGORIES)
    .map(([k, v]) => `- "${k}" : ${v.label} (impact default ${v.default})`)
    .join("\n");

  const prompt = `Tu es un analyste de paris sportifs specialise dans le marche "Victoire + Over 2.5 buts" a domicile.
Pour l'equipe "${team.name}" (${team.league}), analyse les titres d'actualite suivants et classe-les.

Categories disponibles :
${categoriesList}

Regles strictes :
1. REGROUPEMENT DES STORIES : si plusieurs titres decrivent le MEME evenement reel (ex: 9 articles sur le depart d'un coach, 3 articles sur la meme blessure), tu DOIS emettre UN SEUL event qui represente cet evenement. Ne dupplique JAMAIS. Choisis le titre/url/source qui resume le mieux, et mets dans l'explanation le nombre de sources qui confirment l'event entre parentheses ("(confirme par N sources)").
2. PERTINENCE : pour chaque titre, decide s'il est pertinent pour la performance V+O2.5 a domicile. Si non pertinent (resultat anodin, rumeur sans nom, info commerciale, transfert non confirme, reaction de fan sans lien direct), IGNORE-le.
3. Retourne UNIQUEMENT un JSON valide au format ci-dessous. AUCUN texte autour.
4. Si aucun titre n'est pertinent, retourne {"events": []}.
5. "impact" est un entier dans [-3, 3]. Override le default uniquement si le contexte le justifie (ex: depart de LA star vs un joueur secondaire).
6. "expires_days" : duree de validite estimee en jours (1 a 365). Pour une blessure, estime la duree d'indisponibilite. Pour un changement de coach, 30 jours.

Format JSON attendu :
{
  "events": [
    {
      "headline": "<titre exact - choisi parmi les sources>",
      "url": "<url de la source la plus officielle>",
      "source": "<nom de cette source>",
      "pubDate": "<pubDate fournie>",
      "category": "<cle exacte de la liste>",
      "impact": <int -3 a 3>,
      "expires_days": <int 1 a 365>,
      "explanation": "<une phrase max 150 chars sur le pourquoi de l'impact V+O2.5 (ajouter '(confirme par N sources)' si plusieurs titres decrivent le meme event)>"
    }
  ]
}

Titres a analyser :
${JSON.stringify(headlines)}`;

  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Mistral API ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];
  let parsed;
  try { parsed = JSON.parse(content); } catch { return []; }

  return (parsed.events || []).map(ev => {
    const cat = CATEGORIES[ev.category] ? ev.category : "other_neutral";
    const baseDate = ev.pubDate ? new Date(ev.pubDate) : new Date();
    const days = Math.max(1, Math.min(365, parseInt(ev.expires_days) || CATEGORIES[cat].defaultDurationDays));
    const expiresAt = new Date(baseDate);
    expiresAt.setDate(expiresAt.getDate() + days);
    return {
      headline:    String(ev.headline || "").slice(0, 300),
      url:         String(ev.url || ""),
      source:      String(ev.source || "").slice(0, 100),
      date:        baseDate.toISOString().slice(0, 10),
      category:    cat,
      impact:      Math.max(-3, Math.min(3, parseInt(ev.impact) || CATEGORIES[cat].default)),
      explanation: String(ev.explanation || "").slice(0, 200),
      expires_at:  expiresAt.toISOString(),
      ingested_at: new Date().toISOString(),
    };
  });
}

async function loadExistingStore() {
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

async function saveStore(store) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN non configure");
  await put(BLOB_PATHNAME, JSON.stringify(store, null, 2), {
    access: "public",
    contentType: "application/json",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

function mergeEvents(oldEvents = [], newEvents = []) {
  const seen = new Map();
  for (const ev of [...oldEvents, ...newEvents]) {
    const key = (ev.url && ev.url.length > 5) ? ev.url : ev.headline;
    if (!seen.has(key)) seen.set(key, ev);
  }
  return Array.from(seen.values());
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: "CRON_SECRET non configure - cron desactive par securite" });
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const existing = (await loadExistingStore()) || { teams: {} };
    const teamsOut = {};
    const errors   = [];

    for (const team of TEAMS) {
      try {
        const headlines = await fetchGoogleNewsRss(team);
        const newEvents = await categorizeWithMistral(team, headlines.slice(0, MAX_HEADLINES));
        const oldEvents = existing.teams?.[team.key]?.events || [];
        const merged    = mergeEvents(oldEvents, newEvents);
        const decision  = computeDecision(merged);
        teamsOut[team.key] = {
          name: team.name,
          league: team.league,
          events: merged,
          score: decision.score,
          decision: decision.decision,
          stake_recommended_eur: decision.stake_recommended_eur,
          color: decision.color,
          label: decision.label,
          activeEventsCount: decision.activeEvents.length,
          headlinesScanned: headlines.length,
          newEventsToday: newEvents.length,
        };
      } catch (e) {
        errors.push({ team: team.key, error: e.message });
        teamsOut[team.key] = existing.teams?.[team.key] || {
          name: team.name, league: team.league, events: [], score: 0,
          decision: "GO_FULL", stake_recommended_eur: 1.0, color: "green", label: "GO PLEIN",
        };
      }
    }

    const store = {
      lastUpdate: new Date().toISOString(),
      version_matrix: "1.0",
      teams: teamsOut,
      errors,
    };
    await saveStore(store);
    return res.status(200).json({ ok: true, lastUpdate: store.lastUpdate, errors });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
