// Vercel Serverless Function - Simulation de paris v2 (Sniper)
// Paramètres : ?teams=... & roiThreshold=25 & winRateThreshold=30
// Logique : ROI historique >= roiThreshold ET Win Rate > winRateThreshold

const LEAGUES_AVAILABLE = ["F1","F2","E0","E1","D1","D2","SP1","SP2","I1","I2","P1","N1","SC0","SC1","B1"];
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
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
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
    if (margin === 1) return null; 
    return { odds, won: margin >= 2, marketLabel: "AH -1" };
  }
  return null;
}

function pickBestMarketForBucket(teamRanking, bucket, roiThreshold, winRateThreshold) {
  if (!teamRanking) return null;
  let best = null;
  for (const k of RECOMMENDED_MARKETS) {
    const m = teamRanking.markets?.[k];
    if (!m) continue;
    const bk = m.buckets?.[bucket];
    if (!bk || bk.n < 20 || bk.roi === null) continue;

    const winRate = (bk.w / bk.n);
    if (bk.roi < roiThreshold) continue;
    if (winRate <= (winRateThreshold / 100)) continue;

    if (!best || bk.roi > best.roi) {
      best = { key: k, label: MARKET_SHORT[k], roi: bk.roi, n: bk.n, winRate };
    }
  }
  return best;
}

export default async function handler(req, res) {
  try {
    const { teams: teamsParam, roiThreshold: rt = 25, winRateThreshold: wt = 30 } = req.query;
    if (!teamsParam || typeof teamsParam !== 'string') return res.status(400).json({ error: "teams param required and must be a string" });
    const roiThreshold = parseFloat(rt);
    const winRateThreshold = parseFloat(wt);

    const watched = teamsParam.split(",").filter(Boolean).map(s => {
      const [team, league] = s.split("|");
      return { team: team?.trim(), league: league?.trim() };
    }).filter(t => t.team && t.league && LEAGUES_AVAILABLE.includes(t.league));

    const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || "value-bet-pro.vercel.app";
    let rankings = null;
    try {
      const rr = await fetch(`https://${baseUrl}/api/team-rankings`);
      if (rr.ok) rankings = await rr.json();
    } catch {}

    const rankingLookup = new Map();
    if (rankings?.teams) {
      for (const t of rankings.teams) rankingLookup.set(`${t.team}|${t.league}`, t);
    }

    const datasets = await Promise.all(
      LEAGUES_AVAILABLE.flatMap(l => SEASONS_TRACK.map(s => fetchCsv(s, l).then(rows => ({ rows, league: l, season: s }))))
    );

    const bets = [];
    for (const { rows, league, season } of datasets) {
      for (const row of rows) {
        const home = (row.HomeTeam || "").trim();
        if (!watched.find(w => w.team === home)) continue;
        if (!["H","D","A"].includes(row.FTR)) continue;

        const oddsH = fnum(row, "AvgH", "BbAvH", "B365H");
        if (!oddsH) continue;
        const bucket = getBucket(oddsH);
        
        let tr = rankingLookup.get(`${home}|${league}`);
        let bestMarket = pickBestMarketForBucket(tr, bucket, roiThreshold, winRateThreshold);
        if (!bestMarket) continue; 

        const result = computeBetResult(row, bestMarket.key);
        if (!result) continue;

        const valueThreshold = 1 / bestMarket.winRate;
        if (result.odds <= valueThreshold) continue;

        bets.push({
          date: row.Date,
          team: home,
          opponent: (row.AwayTeam || "").trim(),
          market: bestMarket.label,
          cote: +result.odds.toFixed(2),
          won: result.won,
          profit: result.won ? +(result.odds - 1).toFixed(2) : -1,
        });
      }
    }

    res.status(200).json({ summary: { totalBets: bets.length, totalProfit: bets.reduce((acc,b) => acc + b.profit, 0) }, bets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
