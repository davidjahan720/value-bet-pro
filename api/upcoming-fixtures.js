// Vercel Serverless Function — fixtures a venir depuis fixturedownload.com
// Format JSON gratuit, sans cle API.
// URL pattern : https://fixturedownload.com/feed/json/<league>-<year>

const FIXTURE_LEAGUES = {
  // codes football-data.co.uk -> identifiant fixturedownload + annee de demarrage saison
  // saison "2526" = 2025-26, demarre en aout 2025 -> annee = "2025"
  "F1":  "ligue-1",
  "F2":  "ligue-2",
  "E0":  "epl",
  "E1":  "championship",
  "D1":  "bundesliga",
  "D2":  "bundesliga-2",
  "SP1": "la-liga",
  "SP2": "la-liga-2",
  "I1":  "serie-a",
  "I2":  "serie-b",
  "P1":  "primeira-liga",
  "N1":  "eredivisie",
  "SC0": "spfl-premiership",
  "SC1": "spfl-championship",
  "B1":  "pro-league",
};

function seasonCodeToYear(code) {
  // "2526" -> "2025" (saison commence en 2025)
  return "20" + code.slice(0, 2);
}

async function fetchLeagueFixtures(fdCode, season) {
  const id = FIXTURE_LEAGUES[fdCode];
  if (!id) return null;
  const year = seasonCodeToYear(season);
  const url = `https://fixturedownload.com/feed/json/${id}-${year}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ValueBetAnalyzer/1.0)" }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const { teams = "", season = "2526", days = "10" } = req.query;
  // teams = liste team|league separee par des virgules : "Lorient|F1,Aston Villa|E0"
  const wanted = teams.split(",").filter(Boolean).map(s => {
    const [team, lg] = s.split("|");
    return { team: (team||"").trim(), league: (lg||"").trim() };
  });

  if (wanted.length === 0) {
    return res.status(400).json({ error: "Param 'teams' obligatoire (format: team|league,team|league)" });
  }

  // Regrouper par ligue pour limiter les fetches
  const byLeague = new Map();
  for (const w of wanted) {
    if (!byLeague.has(w.league)) byLeague.set(w.league, []);
    byLeague.get(w.league).push(w.team);
  }

  const results = [];
  const horizonDays = parseInt(days, 10) || 10;
  const horizon = new Date(Date.now() + horizonDays * 86400000);
  const now = new Date();

  for (const [lg, teamList] of byLeague.entries()) {
    const fixtures = await fetchLeagueFixtures(lg, season);
    if (!fixtures) {
      for (const t of teamList) results.push({ team: t, league: lg, error: "fixtures non dispo" });
      continue;
    }

    for (const t of teamList) {
      // chercher les matchs ou cette equipe est a domicile
      const upcoming = fixtures
        .filter(f => {
          const date = new Date(f.DateUtc);
          return date >= now && date <= horizon && f.HomeTeam === t;
        })
        .sort((a, b) => new Date(a.DateUtc) - new Date(b.DateUtc));

      if (upcoming.length > 0) {
        const next = upcoming[0];
        results.push({
          team: t,
          league: lg,
          nextHome: {
            date: next.DateUtc,
            opponent: next.AwayTeam,
            round: next.RoundNumber,
            location: next.Location,
          },
          allUpcoming: upcoming.map(u => ({
            date: u.DateUtc,
            opponent: u.AwayTeam,
            round: u.RoundNumber,
          })),
        });
      } else {
        results.push({ team: t, league: lg, nextHome: null });
      }
    }
  }

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
  res.status(200).json({
    lastUpdate: new Date().toISOString(),
    horizonDays,
    fixtures: results,
  });
}
