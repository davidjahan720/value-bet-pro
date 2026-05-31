// Vercel Serverless Function - Simulation de paris sur la watchlist
//
// Pour chaque equipe watchlistee, charge ses matchs domicile joues sur
// les saisons 25-26 + 26-27. Pour chaque match :
//   1. Determine le bucket selon la cote 1 (TF/FN/PE/OU)
//   2. Choisit le marche au meilleur ROI dans CE bucket pour CETTE equipe
//      (parmi 1 sec / V+O2.5 / AH-1, n_bucket >= 20)
//   3. Si aucun marche valide pour ce bucket -> fallback bestMarket3y
//   4. Calcule le resultat du pari + le P&L
//
// Query : ?teams=Team1|F1,Team2|SP1,...
// Sortie : { summary, bets[] } avec running totals chronologiques

const LEAGUES_AVAILABLE = ["F1","F2","E0","E1","D1","D2","SP1","SP2","I1","I2","P1","N1","SC0","SC1","B1","G1"];
const SEASONS_TRACK = ["2324","2425","2526","2627"];
const RECOMMENDED_MARKETS = ["win","win_over25","ah_minus1"];
const BUCKET_LABEL = { TF: "TF", FN: "FN", PE: "PE", OU: "OU" };
const MARKET_SHORT = { win: "1 sec", win_over25: "V+O2.5", ah_minus1: "AH-1" };

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] ?? "").trim(); });
    return row;
  });
}

function fnum(row, ...keys) {
  for (const k of keys) {
    const v = parseFloat(row[k]);
    if (!isNaN(v) && v > 0) return v;
  }
  return 0;
}

function fnumRaw(row, key) {
  const v = parseFloat(row[key]);
  return isNaN(v) ? null : v;
}

async function fetchCsv(season, league, attempt = 1) {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
    });
    if (!r.ok) {
      if (r.status === 404) return [];
      if (attempt < 3) {
        await new Promise(res => setTimeout(res, 200 * attempt));
        return fetchCsv(season, league, attempt + 1);
      }
      return [];
    }
    const csv = await r.text();
    const rows = parseCsv(csv);
    if (rows.length === 0 && csv.length > 200 && attempt < 3) {
      await new Promise(res => setTimeout(res, 200 * attempt));
      return fetchCsv(season, league, attempt + 1);
    }
    return rows;
  } catch (e) {
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, 200 * attempt));
      return fetchCsv(season, league, attempt + 1);
    }
    return [];
  }
}

function parseDate(s) {
  if (!s) return null;
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  let [d, m, y] = parts;
  if (y.length === 2) y = "20" + y;
  return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
}

function getBucket(oddsH) {
  if (!oddsH || oddsH <= 0) return null;
  if (oddsH < 1.50) return "TF";
  if (oddsH < 2.00) return "FN";
  if (oddsH < 2.80) return "PE";
  return "OU";
}

// Calcule le resultat du pari pour un marche donne sur un match donne
function computeBetResult(row, marketKey) {
  const fthg = parseInt(row.FTHG), ftag = parseInt(row.FTAG);
  if (isNaN(fthg) || isNaN(ftag)) return null;

  if (marketKey === "win") {
    const odds = fnum(row, "AvgH", "BbAvH", "B365H");
    if (!odds) return null;
    return { odds, won: row.FTR === "H", marketLabel: "1 sec" };
  }
  if (marketKey === "win_over25") {
    const oH = fnum(row, "AvgH", "BbAvH");
    const oO = fnum(row, "Avg>2.5", "BbAv>2.5");
    if (!oH || !oO) return null;
    return { odds: oH * oO, won: row.FTR === "H" && (fthg + ftag) > 2.5, marketLabel: "V+O2.5" };
  }
  if (marketKey === "ah_minus1") {
    const ahh = fnumRaw(row, "AHh");
    if (ahh !== -1) return null;
    const odds = fnum(row, "AvgAHH", "BbAvAHH");
    if (!odds) return null;
    const margin = fthg - ftag;
    if (margin === 1) return null; // push - exclu de l'echantillon
    return { odds, won: margin >= 2, marketLabel: "AH -1" };
  }
  return null;
}

// Pour une equipe + bucket, trouve le meilleur marche selon ses stats historiques (rankings)
function pickBestMarketForBucket(teamRanking, bucket) {
  if (!teamRanking) return null;
  let best = null;
  for (const k of RECOMMENDED_MARKETS) {
    const m = teamRanking.markets?.[k];
    if (!m) continue;
    const bk = m.buckets?.[bucket];
    if (!bk || bk.n < 20 || bk.roi === null) continue;
    if (!best || bk.roi > best.roi) {
      best = { key: k, label: MARKET_SHORT[k], roi: bk.roi, n: bk.n };
    }
  }
  return best;
}

export default async function handler(req, res) {
  try {
    const teamsParam = req.query.teams;
    if (!teamsParam) return res.status(400).json({ error: "teams param required" });

    // Parse "Team1|F1,Team2|SP1,..."
    const watched = teamsParam.split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const [team, league] = s.split("|");
        return { team: team?.trim(), league: league?.trim() };
      })
      .filter(t => t.team && t.league && LEAGUES_AVAILABLE.includes(t.league));

    if (watched.length === 0) {
      return res.status(200).json({
        lastUpdate: new Date().toISOString(),
        summary: { teams: 0, bets: 0, wins: 0, totalStake: 0, totalProfit: 0, roi: 0 },
        bets: [],
      });
    }

    // Index les noms d'equipes : recherche dans TOUTES les ligues pour suivre
    // les promus/relegues (ex: Paris FC promu de F2 a F1 cette saison).
    const teamNames = new Set(watched.map(t => t.team));
    const teamOriginLeague = new Map();
    for (const t of watched) {
      if (!teamOriginLeague.has(t.team)) teamOriginLeague.set(t.team, t.league);
    }

    // Fetch rankings pour avoir les buckets historiques
    const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || "value-bet-pro.vercel.app";
    let rankings = null;
    try {
      const rr = await fetch(`https://${baseUrl}/api/team-rankings`);
      if (rr.ok) rankings = await rr.json();
    } catch {}

    const rankingLookup = new Map();
    if (rankings?.teams) {
      for (const t of rankings.teams) {
        rankingLookup.set(`${t.team}|${t.league}`, t);
      }
    }

    // Fetch CSVs de TOUTES les ligues x saisons en parallele
    // (necessaire pour detecter les matchs des equipes qui ont change de division)
    const fetchTasks = [];
    for (const league of LEAGUES_AVAILABLE) {
      for (const season of SEASONS_TRACK) {
        fetchTasks.push(
          fetchCsv(season, league).then(rows => ({ league, season, rows }))
        );
      }
    }
    const datasets = await Promise.all(fetchTasks);

    // Build bet list
    const bets = [];
    for (const { league, season, rows } of datasets) {
      for (const row of rows) {
        const home = (row.HomeTeam || "").trim();
        if (!teamNames.has(home)) continue;
        if (!["H","D","A"].includes(row.FTR)) continue; // match non joue

        const oddsH = fnum(row, "AvgH", "BbAvH", "B365H");
        if (!oddsH) continue;
        const bucket = getBucket(oddsH);

        // Cherche les buckets historiques : (team, league actuelle) sinon (team, ligue d'origine watchlist)
        // Si l'equipe a change de division, on applique ses stats de l'ancienne ligue.
        const originLeague = teamOriginLeague.get(home);
        let tr = rankingLookup.get(`${home}|${league}`);
        let crossDivision = false;
        if (!tr && originLeague && originLeague !== league) {
          tr = rankingLookup.get(`${home}|${originLeague}`);
          crossDivision = true;
        }

        let bestMarket = pickBestMarketForBucket(tr, bucket);
        let fallback = false;
        if (!bestMarket) {
          // Fallback : bestMarket3y de l'API si dispo
          if (tr?.bestMarket3y) {
            bestMarket = { key: tr.bestMarket3y.key, label: MARKET_SHORT[tr.bestMarket3y.key] || tr.bestMarket3y.label };
            fallback = true;
          } else {
            // Dernier recours : V+O2.5
            bestMarket = { key: "win_over25", label: "V+O2.5" };
            fallback = true;
          }
        }

        const result = computeBetResult(row, bestMarket.key);
        if (!result) continue;

        const d = parseDate(row.Date);
        bets.push({
          dateIso: d ? d.toISOString().slice(0,10) : null,
          dateLabel: row.Date,
          season,
          league,
          originLeague: teamOriginLeague.get(home),
          crossDivision,
          team: home,
          opponent: (row.AwayTeam || "").trim(),
          score: `${row.FTHG}-${row.FTAG}`,
          oddsH,
          bucket,
          bucketLabel: BUCKET_LABEL[bucket],
          market: bestMarket.key,
          marketLabel: bestMarket.label,
          marketRoiHist: bestMarket.roi !== undefined ? +bestMarket.roi.toFixed(2) : null,
          marketN: bestMarket.n || null,
          fallback,
          cote: +result.odds.toFixed(2),
          stake: 1,
          won: result.won,
          payout: result.won ? +result.odds.toFixed(2) : 0,
          profit: result.won ? +(result.odds - 1).toFixed(2) : -1,
        });
      }
    }

    // Tri chronologique
    bets.sort((a, b) => {
      if (!a.dateIso) return 1;
      if (!b.dateIso) return -1;
      return a.dateIso.localeCompare(b.dateIso);
    });

    // Running totals
    let cumStake = 0, cumProfit = 0;
    for (const b of bets) {
      cumStake += b.stake;
      cumProfit += b.profit;
      b.cumStake = +cumStake.toFixed(2);
      b.cumProfit = +cumProfit.toFixed(2);
      b.cumRoi = cumStake > 0 ? +((cumProfit / cumStake) * 100).toFixed(2) : 0;
    }

    const totalStake = +cumStake.toFixed(2);
    const totalProfit = +cumProfit.toFixed(2);
    const wins = bets.filter(b => b.won).length;

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
    return res.status(200).json({
      lastUpdate: new Date().toISOString(),
      watched: watched.length,
      summary: {
        teams: watched.length,
        bets: bets.length,
        wins,
        losses: bets.length - wins,
        winRate: bets.length ? +(wins / bets.length * 100).toFixed(1) : 0,
        totalStake,
        totalReturns: +(totalStake + totalProfit).toFixed(2),
        totalProfit,
        roi: totalStake > 0 ? +((totalProfit / totalStake) * 100).toFixed(2) : 0,
      },
      bets,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
