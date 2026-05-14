// Vercel Serverless Function — fixtures a venir depuis fixturedownload.com
// Format JSON gratuit, sans cle API.
// URL pattern : https://fixturedownload.com/feed/json/<league>-<year>

const FIXTURE_LEAGUES = {
  // codes football-data.co.uk -> identifiant fixturedownload + annee de demarrage saison
  // saison "2526" = 2025-26, demarre en aout 2025 -> annee = "2025"
  // null = pas de feed JSON disponible sur fixturedownload pour cette ligue
  "F1":  "ligue-1",
  "F2":  null,                // pas de feed JSON
  "E0":  "epl",
  "E1":  "championship",
  "D1":  "bundesliga",
  "D2":  null,                // pas de feed JSON
  "SP1": "la-liga",
  "SP2": null,                // pas de feed JSON (Segunda)
  "I1":  "serie-a",
  "I2":  null,
  "P1":  "primeira-liga",
  "N1":  "eredivisie",
  "SC0": null,
  "SC1": null,
  "B1":  null,
};

// Aliases entre noms football-data.co.uk (utilises dans la watchlist du client)
// et noms fixturedownload.com (utilises dans le feed JSON).
// Lookup case-insensitive sur la cle.
const TEAM_ALIASES = {
  // Premier League / Championship
  "QPR":             ["Queens Park Rangers"],
  "Spurs":           ["Tottenham Hotspur", "Tottenham"],
  "Tottenham":       ["Tottenham Hotspur"],
  "Man City":        ["Manchester City"],
  "Man United":      ["Manchester United"],
  "Man Utd":         ["Manchester United"],
  "Nott'm Forest":   ["Nottingham Forest"],
  "Wolves":          ["Wolverhampton Wanderers", "Wolves"],
  "Bournemouth":     ["AFC Bournemouth", "Bournemouth"],
  "Leeds":           ["Leeds United", "Leeds"],
  "Birmingham":      ["Birmingham City"],
  "Blackburn":       ["Blackburn Rovers"],
  "Bristol City":    ["Bristol City"],
  "Charlton":        ["Charlton Athletic"],
  "Coventry":        ["Coventry City"],
  "Derby":           ["Derby County"],
  "Hull":            ["Hull City"],
  "Ipswich":         ["Ipswich Town"],
  "Leicester":       ["Leicester City"],
  "Middlesbrough":   ["Middlesbrough"],
  "Millwall":        ["Millwall"],
  "Norwich":         ["Norwich City"],
  "Oxford":          ["Oxford United"],
  "Portsmouth":      ["Portsmouth"],
  "Preston":         ["Preston North End"],
  "Sheffield Utd":   ["Sheffield United"],
  "Sheffield United":["Sheffield United"],
  "Sheffield Weds":  ["Sheffield Wednesday"],
  "Southampton":     ["Southampton"],
  "Stoke":           ["Stoke City"],
  "Swansea":         ["Swansea City"],
  "Watford":         ["Watford"],
  "West Brom":       ["West Bromwich Albion"],
  "Wrexham":         ["Wrexham"],

  // Ligue 1 (FC Lorient, AS Monaco, Olympique de Marseille, etc.)
  "Lorient":         ["FC Lorient"],
  "Metz":            ["FC Metz"],
  "Nantes":          ["FC Nantes"],
  "Le Havre":        ["Havre Athletic Club", "Le Havre"],
  "Lille":           ["LOSC Lille"],
  "Nice":            ["OGC Nice"],
  "Marseille":       ["Olympique de Marseille"],
  "Lyon":            ["Olympique Lyonnais"],
  "Paris SG":        ["Paris Saint-Germain"],
  "PSG":             ["Paris Saint-Germain"],
  "Paris FC":        ["Paris FC"],
  "Lens":            ["RC Lens"],
  "Strasbourg":      ["RC Strasbourg Alsace"],
  "Brest":           ["Stade Brestois 29"],
  "Rennes":          ["Stade Rennais FC"],
  "Auxerre":         ["AJ Auxerre"],
  "Angers":          ["Angers SCO"],
  "Monaco":          ["AS Monaco"],
  "Toulouse":        ["Toulouse FC"],

  // La Liga
  "Ath Madrid":      ["Atlético de Madrid", "Atletico de Madrid", "Atletico Madrid"],
  "Ath Bilbao":      ["Athletic Club", "Athletic Bilbao"],
  "Sociedad":        ["Real Sociedad"],
  "Espanol":         ["RCD Espanyol de Barcelona", "Espanyol"],
  "Alaves":          ["Deportivo Alavés", "Alaves"],
  "Mallorca":        ["RCD Mallorca"],
  "Oviedo":          ["Real Oviedo"],
  "Betis":           ["Real Betis"],
  "Sevilla":         ["Sevilla FC"],
  "Barcelona":       ["FC Barcelona"],
  "Getafe":          ["Getafe CF"],
  "Girona":          ["Girona FC"],
  "Levante":         ["Levante UD"],
  "Valencia":        ["Valencia CF"],
  "Vallecano":       ["Rayo Vallecano"],
  "Osasuna":         ["CA Osasuna"],
  "Villarreal":      ["Villarreal CF"],
  "Elche":           ["Elche CF"],
  "Real Madrid":     ["Real Madrid"],
  "Celta":           ["Celta"],
};

function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Renvoie true si le HomeTeam fixturedownload matche le nom watchlist (alias ou fuzzy)
function isTeamMatch(homeTeam, wantedName) {
  if (homeTeam === wantedName) return true;
  const aliases = TEAM_ALIASES[wantedName] || [];
  if (aliases.includes(homeTeam)) return true;
  const aWanted = normalizeForMatch(wantedName);
  const aHome   = normalizeForMatch(homeTeam);
  if (!aWanted || !aHome) return false;
  if (aWanted === aHome) return true;
  // Substring match dans les deux sens (gere "Lorient" vs "fc lorient")
  return aHome.includes(aWanted) || aWanted.includes(aHome);
}

function seasonCodeToYear(code) {
  // "2526" -> "2025" (saison commence en 2025)
  return "20" + code.slice(0, 2);
}

async function fetchLeagueFixtures(fdCode, season) {
  const id = FIXTURE_LEAGUES[fdCode];
  if (id === null) return { _unsupported: true };  // ligue connue mais pas de feed JSON
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
  const { teams = "", season = "2526", days = "10", includeAway = "false" } = req.query;
  const wantAway = includeAway === "true" || includeAway === "1";
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
    if (!fixtures || fixtures._unsupported) {
      const errMsg = fixtures?._unsupported ? "ligue non supportee par fixturedownload" : "fixtures non dispo";
      for (const t of teamList) results.push({ team: t, league: lg, error: errMsg });
      continue;
    }

    for (const t of teamList) {
      const homeUpcoming = fixtures
        .filter(f => {
          const date = new Date(f.DateUtc);
          return date >= now && date <= horizon && isTeamMatch(f.HomeTeam, t);
        })
        .sort((a, b) => new Date(a.DateUtc) - new Date(b.DateUtc));

      const awayUpcoming = wantAway ? fixtures
        .filter(f => {
          const date = new Date(f.DateUtc);
          return date >= now && date <= horizon && isTeamMatch(f.AwayTeam, t);
        })
        .sort((a, b) => new Date(a.DateUtc) - new Date(b.DateUtc)) : [];

      const allMatches = [...homeUpcoming.map(u => ({
        date: u.DateUtc,
        opponent: u.AwayTeam,
        round: u.RoundNumber,
        isHome: true,
      })), ...awayUpcoming.map(u => ({
        date: u.DateUtc,
        opponent: u.HomeTeam,
        round: u.RoundNumber,
        isHome: false,
      }))].sort((a, b) => new Date(a.date) - new Date(b.date));

      results.push({
        team: t,
        league: lg,
        nextHome: homeUpcoming.length > 0 ? {
          date: homeUpcoming[0].DateUtc,
          opponent: homeUpcoming[0].AwayTeam,
          round: homeUpcoming[0].RoundNumber,
          location: homeUpcoming[0].Location,
        } : null,
        allUpcoming: homeUpcoming.map(u => ({
          date: u.DateUtc,
          opponent: u.AwayTeam,
          round: u.RoundNumber,
        })),
        allMatches: wantAway ? allMatches : undefined,
      });
    }
  }

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
  res.status(200).json({
    lastUpdate: new Date().toISOString(),
    horizonDays,
    fixtures: results,
  });
}
