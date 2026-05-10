// Vercel Serverless Function — Live odds via The Odds API
// Limite aux equipes specifiees (Top 4) pour economiser le quota free 500 req/mois
//
// Usage : /api/live-odds?teams=Lorient|F1,Aston%20Villa|E0,Rennes|F1,Ath%20Madrid|SP1
//
// Variable d'env requise : ODDS_API_KEY (configuree dans Vercel)

// Mapping codes football-data.co.uk -> sport keys The Odds API
const FB_TO_ODDS_SPORT = {
  "F1":  "soccer_france_ligue_one",
  "F2":  "soccer_france_ligue_two",
  "E0":  "soccer_epl",
  "E1":  "soccer_efl_champ",
  "D1":  "soccer_germany_bundesliga",
  "D2":  "soccer_germany_bundesliga2",
  "SP1": "soccer_spain_la_liga",
  "SP2": "soccer_spain_segunda_division",
  "I1":  "soccer_italy_serie_a",
  "I2":  "soccer_italy_serie_b",
  "P1":  "soccer_portugal_primeira_liga",
  "N1":  "soccer_netherlands_eredivisie",
  "B1":  "soccer_belgium_first_div",
  "SC0": "soccer_scotland_premiership",
};

// Normalisation des noms d'equipes : football-data.co.uk -> The Odds API
// (necessaire car certains noms different : "Ath Madrid" vs "Atletico Madrid")
function normalizeTeamName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // retire accents
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const TEAM_ALIASES = {
  // football-data name -> alternatives The Odds API
  "ath madrid": ["atletico madrid", "club atletico madrid"],
  "ath bilbao": ["athletic bilbao", "athletic club"],
  "real madrid": ["real madrid"],
  "man united": ["manchester united"],
  "man city": ["manchester city"],
  "wolves": ["wolverhampton", "wolverhampton wanderers"],
  "tottenham": ["tottenham hotspur"],
  "nottm forest": ["nottingham forest"],
  "leverkusen": ["bayer 04 leverkusen", "bayer leverkusen"],
  "dortmund": ["borussia dortmund"],
  "m'gladbach": ["borussia monchengladbach"],
  "monchengladbach": ["borussia monchengladbach"],
  "bayern munich": ["bayern munich", "fc bayern munich"],
  "psv eindhoven": ["psv eindhoven", "psv"],
  "az alkmaar": ["az alkmaar", "az"],
  "st gilloise": ["union saint-gilloise", "royal union saint-gilloise"],
  "st. gilloise": ["union saint-gilloise", "royal union saint-gilloise"],
  "sp lisbon": ["sporting cp", "sporting lisbon"],
  "ein frankfurt": ["eintracht frankfurt"],
  "go ahead eagles": ["go ahead eagles"],
  "stad. honved": ["budapest honved"],
};

function teamMatches(fbTeamRaw, oddsTeamRaw) {
  const fb = normalizeTeamName(fbTeamRaw);
  const odds = normalizeTeamName(oddsTeamRaw);
  if (!fb || !odds) return false;
  if (fb === odds) return true;
  if (fb.includes(odds) || odds.includes(fb)) return true;
  // Alias check
  const aliases = TEAM_ALIASES[fb] || [];
  for (const a of aliases) {
    const na = normalizeTeamName(a);
    if (na === odds || na.includes(odds) || odds.includes(na)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ODDS_API_KEY non configuree dans Vercel" });
  }

  const { teams = "" } = req.query;
  const wanted = teams.split(",").filter(Boolean).map(s => {
    const [team, lg] = s.split("|");
    return { team: (team || "").trim(), league: (lg || "").trim() };
  });
  if (wanted.length === 0) {
    return res.status(400).json({ error: "Param 'teams' obligatoire (format: team|league,team|league)" });
  }

  // Limite de securite : 6 equipes max (free tier = 500 req/mois)
  if (wanted.length > 6) {
    return res.status(400).json({ error: "Trop d'equipes (max 6 pour preserver le quota API)" });
  }

  // Regrouper par sport key (pour minimiser le nb de requetes API)
  const sportToTeams = new Map();
  const skipped = [];
  for (const w of wanted) {
    const sport = FB_TO_ODDS_SPORT[w.league];
    if (!sport) {
      skipped.push({ ...w, error: `ligue ${w.league} non supportee par Odds API` });
      continue;
    }
    if (!sportToTeams.has(sport)) sportToTeams.set(sport, []);
    sportToTeams.get(sport).push(w);
  }

  const results = [...skipped];
  let quotaRemaining = null;

  for (const [sport, teamList] of sportToTeams.entries()) {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "ValueBetPro/1.0" } });
      // Le header x-requests-remaining contient le quota restant
      const remaining = r.headers.get("x-requests-remaining");
      if (remaining !== null) quotaRemaining = parseInt(remaining, 10);

      if (!r.ok) {
        const errText = await r.text();
        for (const t of teamList) {
          results.push({ ...t, error: `Odds API ${r.status}: ${errText.slice(0, 100)}` });
        }
        continue;
      }
      const events = await r.json();

      for (const t of teamList) {
        // Cherche les matchs domicile (homeTeam = t.team) a venir
        const homeEvents = events.filter(e => teamMatches(t.team, e.home_team));
        // Tous les matchs avec t.team implique (dom ou ext) pour debug
        const allEvents = events.filter(e =>
          teamMatches(t.team, e.home_team) || teamMatches(t.team, e.away_team)
        );
        if (homeEvents.length === 0) {
          results.push({
            ...t,
            nextHome: null,
            allUpcoming: allEvents.slice(0, 5).map(e => ({
              date: e.commence_time,
              home: e.home_team,
              away: e.away_team,
              isHome: teamMatches(t.team, e.home_team),
            })),
          });
          continue;
        }
        homeEvents.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
        const next = homeEvents[0];

        // Calcul des cotes moyennes des bookmakers
        let sumH = 0, sumD = 0, sumA = 0, cntH = 0, cntD = 0, cntA = 0;
        let bestH = 0, bestD = 0, bestA = 0;
        for (const bk of next.bookmakers || []) {
          for (const m of bk.markets || []) {
            if (m.key !== "h2h") continue;
            for (const o of m.outcomes || []) {
              if (o.name === next.home_team) {
                sumH += o.price; cntH++;
                if (o.price > bestH) bestH = o.price;
              } else if (o.name === next.away_team) {
                sumA += o.price; cntA++;
                if (o.price > bestA) bestA = o.price;
              } else if (o.name === "Draw") {
                sumD += o.price; cntD++;
                if (o.price > bestD) bestD = o.price;
              }
            }
          }
        }

        results.push({
          ...t,
          nextHome: {
            date: next.commence_time,
            opponent: next.away_team,
            opponentRaw: next.away_team,
            homeRaw: next.home_team,
            // Cotes moyennes (proche de AvgH historique)
            odds: cntH > 0 ? +(sumH / cntH).toFixed(2) : null,
            oddsD: cntD > 0 ? +(sumD / cntD).toFixed(2) : null,
            oddsA: cntA > 0 ? +(sumA / cntA).toFixed(2) : null,
            // Meilleures cotes du marche (line shopping)
            bestOdds: bestH || null,
            bestOddsD: bestD || null,
            bestOddsA: bestA || null,
            bookmakers: next.bookmakers?.length || 0,
            source: "odds-api-live",
          },
          allUpcoming: allEvents.slice(0, 5).map(e => ({
            date: e.commence_time,
            home: e.home_team,
            away: e.away_team,
            isHome: teamMatches(t.team, e.home_team),
          })),
        });
      }
    } catch (e) {
      for (const t of teamList) results.push({ ...t, error: e.message });
    }
  }

  // Cache 6h cote serveur pour economiser le quota API
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
  res.status(200).json({
    lastUpdate: new Date().toISOString(),
    quotaRemaining,
    fixtures: results,
  });
}
