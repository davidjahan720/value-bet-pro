// Matrice de decision Veille -> Pari V+O2.5
// Source unique de verite pour le scoring et la decision finale.
// Utilise par api/veille-cron.js (categorisation + scoring) et api/veille-get.js (recompute live).

// Categories d'evenements et leur impact par defaut sur le marche V+O2.5
// (Mistral peut overrider l'impact dans une fenetre [-3, +3] si la categorie ne capture pas la specificite)
export const CATEGORIES = {
  injury_attacker_starter:    { default: -2, label: "Blessure attaquant titulaire",         defaultDurationDays: 21 },
  injury_attacker_multiple:   { default: -4, label: "Blessures multiples attaquants",       defaultDurationDays: 21 },
  injury_midfielder_starter:  { default: -1, label: "Blessure milieu titulaire",            defaultDurationDays: 14 },
  injury_defender_starter:    { default:  1, label: "Blessure defenseur titulaire",         defaultDurationDays: 14 },
  injury_goalkeeper:          { default:  1, label: "Blessure gardien titulaire",           defaultDurationDays: 14 },
  transfer_out_striker:       { default: -3, label: "Depart d'un buteur",                   defaultDurationDays: 365 },
  transfer_out_key_player:    { default: -2, label: "Depart d'un joueur cle",               defaultDurationDays: 365 },
  transfer_in_striker:        { default:  2, label: "Arrivee d'un buteur",                  defaultDurationDays: 365 },
  transfer_in_key_player:     { default:  1, label: "Arrivee d'un joueur cle",              defaultDurationDays: 365 },
  coach_change:               { default: -1, label: "Changement d'entraineur",              defaultDurationDays: 30 },
  suspension_key_player:      { default: -1, label: "Suspension joueur cle (1 match)",      defaultDurationDays: 7 },
  bad_form_streak:            { default: -2, label: "Mauvaise forme (3 defaites)",          defaultDurationDays: 14 },
  good_form_streak:           { default:  1, label: "Bonne forme (3 victoires)",            defaultDurationDays: 14 },
  financial_crisis:           { default: -2, label: "Crise financiere / instabilite club",  defaultDurationDays: 60 },
  cup_final_next_week:        { default: -1, label: "Match coupe imminent (turnover)",      defaultDurationDays: 7 },
  other_neutral:              { default:  0, label: "Info contextuelle neutre",             defaultDurationDays: 7 },
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
export function computeScore(events, nowIso = new Date().toISOString()) {
  const now = new Date(nowIso);
  let total = 0;
  const active = [];
  for (const ev of events || []) {
    if (ev.expires_at && new Date(ev.expires_at) < now) continue;
    const cat = CATEGORIES[ev.category] || CATEGORIES.other_neutral;
    const impact = (typeof ev.impact === "number") ? ev.impact : cat.default;
    total += impact;
    active.push({ ...ev, _resolved_impact: impact });
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
