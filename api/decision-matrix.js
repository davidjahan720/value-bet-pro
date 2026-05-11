// Matrice de decision Veille -> Pari V+O2.5
// Source unique de verite pour le scoring et la decision finale.
// Utilise par api/veille-cron.js (categorisation + scoring) et api/veille-get.js (recompute live).

// Categories d'evenements et leur impact par defaut sur le marche V+O2.5
// (Mistral peut overrider l'impact dans une fenetre [-3, +3] si la categorie ne capture pas la specificite)
//
// uniquePerTeam = true : une seule realite possible (1 coach, 1 crise, 1 serie)
//                        -> dans computeScore on ne compte que l'event le plus impactant de cette categorie.
//                        Evite qu'un meme evenement repris par N sources gonfle artificiellement le score.
// uniquePerTeam = false : peut etre multiple (plusieurs blessures, plusieurs transferts, plusieurs suspensions)
export const CATEGORIES = {
  injury_attacker_starter:    { default: -2, label: "Blessure attaquant titulaire",         defaultDurationDays: 21, uniquePerTeam: false },
  injury_attacker_multiple:   { default: -4, label: "Blessures multiples attaquants",       defaultDurationDays: 21, uniquePerTeam: true },
  injury_midfielder_starter:  { default: -1, label: "Blessure milieu titulaire",            defaultDurationDays: 14, uniquePerTeam: false },
  injury_defender_starter:    { default:  1, label: "Blessure defenseur titulaire",         defaultDurationDays: 14, uniquePerTeam: false },
  injury_goalkeeper:          { default:  1, label: "Blessure gardien titulaire",           defaultDurationDays: 14, uniquePerTeam: true },
  transfer_out_striker:       { default: -3, label: "Depart d'un buteur",                   defaultDurationDays: 365, uniquePerTeam: false },
  transfer_out_key_player:    { default: -2, label: "Depart d'un joueur cle",               defaultDurationDays: 365, uniquePerTeam: false },
  transfer_in_striker:        { default:  2, label: "Arrivee d'un buteur",                  defaultDurationDays: 365, uniquePerTeam: false },
  transfer_in_key_player:     { default:  1, label: "Arrivee d'un joueur cle",              defaultDurationDays: 365, uniquePerTeam: false },
  coach_change:               { default: -1, label: "Changement d'entraineur",              defaultDurationDays: 30, uniquePerTeam: true },
  suspension_key_player:      { default: -1, label: "Suspension joueur cle (1 match)",      defaultDurationDays: 7, uniquePerTeam: false },
  bad_form_streak:            { default: -2, label: "Mauvaise forme (3 defaites)",          defaultDurationDays: 14, uniquePerTeam: true },
  good_form_streak:           { default:  1, label: "Bonne forme (3 victoires)",            defaultDurationDays: 14, uniquePerTeam: true },
  financial_crisis:           { default: -2, label: "Crise financiere / instabilite club",  defaultDurationDays: 60, uniquePerTeam: true },
  cup_final_next_week:        { default: -1, label: "Match coupe imminent (turnover)",      defaultDurationDays: 7, uniquePerTeam: true },
  other_neutral:              { default:  0, label: "Info contextuelle neutre",             defaultDurationDays: 7, uniquePerTeam: false },
};

// Seuils de decision applique sur le score cumule des events actifs
export const DECISION_THRESHOLDS = [
  { min:  1,            decision: "GO_BOOST",  stake: 1.5, color: "green",  label: "GO BOOST" },
  { min: -1, max: 0,    decision: "GO_FULL",   stake: 1.0, color: "green",  label: "GO PLEIN" },
  { min: -3, max: -2,   decision: "REDUCED",   stake: 0.5, color: "yellow", label: "REDUIT" },
  { min: -5, max: -4,   decision: "MINIMUM",   stake: 0.2, color: "orange", label: "MINIMUM" },
  {           max: -6,  decision: "SKIP",      stake: 0,   color: "red",    label: "SKIP" },
];

const SCORE_FLOOR   = -10;
const SCORE_CEILING =   5;

// Renvoie la decision pour un score donne
export function decideFromScore(score) {
  const s = Math.max(SCORE_FLOOR, Math.min(SCORE_CEILING, score));
  for (const t of DECISION_THRESHOLDS) {
    const okMin = (t.min === undefined) || s >= t.min;
    const okMax = (t.max === undefined) || s <= t.max;
    if (okMin && okMax) return { ...t, score_clamped: s };
  }
  // Fallback (ne devrait jamais arriver)
  return { decision: "GO_FULL", stake: 1.0, color: "green", label: "GO PLEIN", score_clamped: s };
}

// Calcule le score total a partir d'une liste d'events
// - Ne compte que les events actifs (expires_at > nowIso ou pas d'expiration)
// - Utilise l'override impact si present, sinon le default de la categorie
// - Pour les categories uniquePerTeam=true : ne garde que l'event le plus impactant (en valeur absolue)
//   Les autres restent visibles dans activeEvents (avec _counted=false) pour la trace utilisateur.
export function computeScore(events, nowIso = new Date().toISOString()) {
  const now = new Date(nowIso);
  const active = [];
  for (const ev of events || []) {
    if (ev.expires_at && new Date(ev.expires_at) < now) continue;
    const cat = CATEGORIES[ev.category] || CATEGORIES.other_neutral;
    const impact = (typeof ev.impact === "number") ? ev.impact : cat.default;
    active.push({ ...ev, _resolved_impact: impact, _category_meta: cat });
  }

  // Determine quels events sont effectivement comptabilises
  // Pour categories unique : on garde l'event au max(|impact|) (en cas d'egalite, le plus recent)
  const winnersByCategory = new Map();
  for (const ev of active) {
    if (!ev._category_meta.uniquePerTeam) continue;
    const cur = winnersByCategory.get(ev.category);
    const evDate = new Date(ev.ingested_at || ev.date || 0).getTime();
    if (!cur) { winnersByCategory.set(ev.category, ev); continue; }
    const curMag = Math.abs(cur._resolved_impact);
    const evMag = Math.abs(ev._resolved_impact);
    const curDate = new Date(cur.ingested_at || cur.date || 0).getTime();
    if (evMag > curMag || (evMag === curMag && evDate > curDate)) {
      winnersByCategory.set(ev.category, ev);
    }
  }

  let total = 0;
  for (const ev of active) {
    const isUnique = ev._category_meta.uniquePerTeam;
    const isWinner = !isUnique || winnersByCategory.get(ev.category) === ev;
    ev._counted = isWinner;
    if (isWinner) total += ev._resolved_impact;
    // Nettoyage des metas internes pour la sortie
    delete ev._category_meta;
  }

  return { score: total, activeEvents: active };
}

// API tout-en-un : events -> {score, decision, activeEvents}
export function computeDecision(events, nowIso) {
  const { score, activeEvents } = computeScore(events, nowIso);
  const decision = decideFromScore(score);
  return {
    score,
    activeEvents,
    decision: decision.decision,
    stake_recommended_eur: decision.stake,
    color: decision.color,
    label: decision.label,
  };
}

// Helper : derive un expires_at par defaut a partir d'un event si Mistral n'en fournit pas
export function defaultExpiresAt(category, baseDate = new Date()) {
  const cat = CATEGORIES[category] || CATEGORIES.other_neutral;
  const d = new Date(baseDate);
  d.setDate(d.getDate() + cat.defaultDurationDays);
  return d.toISOString();
}

// Normalise un titre pour la dedup par contenu :
// - lowercase
// - retire ponctuation/accents/guillemets
// - collapse espaces multiples
// Permet de matcher "Departed coach!" et "departed coach" comme equivalents.
export function normalizeHeadline(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")     // strip diacritiques
    .replace(/['"…«»–—\-_:;,.!?()/\[\]]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Dedup robuste : un event est considere doublon s'il partage soit l'URL,
// soit le titre normalise (>= 10 chars) avec un event deja vu.
// L'ordre est preserve (premier event = source de verite).
export function dedupEvents(events) {
  const seenUrl = new Set();
  const seenHl  = new Set();
  const out = [];
  for (const ev of events || []) {
    const urlKey = (ev.url && ev.url.length > 5) ? ev.url : null;
    const hl     = normalizeHeadline(ev.headline);
    const hKey   = hl.length >= 10 ? hl : null;
    if (urlKey && seenUrl.has(urlKey)) continue;
    if (hKey   && seenHl.has(hKey))    continue;
    if (urlKey) seenUrl.add(urlKey);
    if (hKey)   seenHl.add(hKey);
    out.push(ev);
  }
  return out;
}
