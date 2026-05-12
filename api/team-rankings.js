// Vercel Serverless Function — Calcul du ROI MULTI-MARCHES par equipe
// Sources : football-data.co.uk (7 saisons : 2020-21 a 2026-27)
// Marches calcules :
//   - 1 sec (1N2 home win)
//   - Over 2.5 buts
//   - Under 2.5 buts
//   - Double Chance 1X (cote synthetique)
//   - V + Over 2.5 (combine via produit des cotes)
//   - AH -1 (Asian Handicap : equipe doit gagner par 2+ buts)
// Critere Tier 1 : n_5y >= 60, ROI 5y "1 sec" >= +5%, >=3 saisons positives

const LEAGUES = [
  { code: "F1",  name: "Ligue 1 FRA",      tier: "D1" },
  { code: "F2",  name: "Ligue 2 FRA",      tier: "D2" },
  { code: "E0",  name: "Premier League",   tier: "D1" },
  { code: "E1",  name: "Championship ENG", tier: "D2" },
  { code: "D1",  name: "Bundesliga",       tier: "D1" },
  { code: "D2",  name: "2.Bundesliga",     tier: "D2" },
  { code: "SP1", name: "LaLiga",           tier: "D1" },
  { code: "SP2", name: "Segunda ESP",      tier: "D2" },
  { code: "I1",  name: "Serie A",          tier: "D1" },
  { code: "I2",  name: "Serie B",          tier: "D2" },
  { code: "P1",  name: "Liga Portugal",    tier: "D1" },
  { code: "N1",  name: "Eredivisie",       tier: "D1" },
  { code: "SC0", name: "Premiership ECO",  tier: "D1" },
  { code: "SC1", name: "Championship ECO", tier: "D2" },
  { code: "B1",  name: "Pro League BEL",   tier: "D1" },
];

const SEASONS = ["2021", "2122", "2223", "2324", "2425", "2526", "2627"];
const SEASONS_BACKTEST = ["2021", "2122", "2223", "2324", "2425"];
const SEASONS_3Y = ["2324", "2425", "2526"]; // 2 saisons completes + saison en cours
const CURRENT_SEASON = "2526";
const NEXT_SEASON = "2627";

// Marches consideres pour la recommandation "bestMarket3y" (les 3 marches phares affiches en colonnes)
const RECOMMENDED_MARKETS = ["win", "win_over25", "ah_minus1"];
const RECOMMENDED_MIN_N_3Y = 20; // echantillon minimum pour recommander un marche

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

async function fetchCsv(season, league) {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ValueBetPro/1.0)" }
    });
    if (!r.ok) return [];
    const csv = await r.text();
    return parseCsv(csv);
  } catch (e) {
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

// Buckets de cote H (proxy force adverse)
//   TF = Tres favori (cote H < 1.50)
//   FN = Favori normal (1.50-2.00)
//   PE = Pick'em (2.00-2.80)
//   OU = Outsider (>= 2.80)
function getBucket(oddsH) {
  if (!oddsH || oddsH <= 0) return null;
  if (oddsH < 1.50) return "TF";
  if (oddsH < 2.00) return "FN";
  if (oddsH < 2.80) return "PE";
  return "OU";
}

// MARKETS = liste des marches a tracker
// Chaque marche : { key, label, computeBet(row) -> { odds, won } | null }
const MARKETS = [
  {
    key: "win",
    label: "1 sec",
    compute: (row) => {
      const odds = fnum(row, "AvgH", "BbAvH", "B365H");
      if (!odds) return null;
      return { odds, won: row.FTR === "H" };
    }
  },
  {
    key: "over25",
    label: "Over 2.5",
    compute: (row) => {
      const odds = fnum(row, "Avg>2.5", "BbAv>2.5");
      if (!odds) return null;
      const hg = parseInt(row.FTHG); const ag = parseInt(row.FTAG);
      if (isNaN(hg) || isNaN(ag)) return null;
      return { odds, won: (hg + ag) > 2.5 };
    }
  },
  {
    key: "under25",
    label: "Under 2.5",
    compute: (row) => {
      const odds = fnum(row, "Avg<2.5", "BbAv<2.5");
      if (!odds) return null;
      const hg = parseInt(row.FTHG); const ag = parseInt(row.FTAG);
      if (isNaN(hg) || isNaN(ag)) return null;
      return { odds, won: (hg + ag) < 2.5 };
    }
  },
  {
    key: "dc1x",
    label: "DC 1X",
    compute: (row) => {
      const oH = fnum(row, "AvgH", "BbAvH");
      const oD = fnum(row, "AvgD", "BbAvD");
      if (!oH || !oD) return null;
      const dc = 1 / (1/oH + 1/oD);
      return { odds: dc, won: row.FTR === "H" || row.FTR === "D" };
    }
  },
  {
    key: "win_over25",
    label: "V + Over 2.5",
    compute: (row) => {
      const oH = fnum(row, "AvgH", "BbAvH");
      const oO = fnum(row, "Avg>2.5", "BbAv>2.5");
      if (!oH || !oO) return null;
      const hg = parseInt(row.FTHG); const ag = parseInt(row.FTAG);
      if (isNaN(hg) || isNaN(ag)) return null;
      return { odds: oH * oO, won: row.FTR === "H" && (hg + ag) > 2.5 };
    }
  },
  {
    key: "ah_minus1",
    label: "AH -1",
    compute: (row) => {
      // s'applique uniquement si la ligne AHh = -1 (favori dom doit gagner par 2+ buts)
      const ahh = fnumRaw(row, "AHh");
      if (ahh !== -1) return null;
      const odds = fnum(row, "AvgAHH", "BbAvAHH");
      if (!odds) return null;
      const hg = parseInt(row.FTHG); const ag = parseInt(row.FTAG);
      if (isNaN(hg) || isNaN(ag)) return null;
      const margin = hg - ag;
      if (margin === 1) return null;  // push, mise rembursee, exclu de l'echantillon
      return { odds, won: margin >= 2 };
    }
  },
];

export default async function handler(req, res) {
  try {
    // Telecharger toutes les saisons x ligues en parallele
    const tasks = [];
    for (const season of SEASONS) {
      for (const lg of LEAGUES) {
        tasks.push(
          fetchCsv(season, lg.code).then(rows => ({ season, league: lg, rows }))
        );
      }
    }
    const datasets = await Promise.all(tasks);

    // Agreger par (team, league) — pour chaque marche, par saison
    // teamData[key] = { team, league, perMarketSeason: { marketKey: { season: [n,m,r,w] } }, future: [] }
    const teamData = new Map();

    for (const { season, league, rows } of datasets) {
      for (const row of rows) {
        const home = (row.HomeTeam || "").trim();
        const away = (row.AwayTeam || "").trim();
        if (!home) continue;

        const key = `${home}|${league.code}`;
        if (!teamData.has(key)) {
          const init = {
            team: home,
            league: league.code,
            leagueName: league.name,
            tier: league.tier,
            perMarketSeason: {},
            future: [],
          };
          for (const m of MARKETS) {
            init.perMarketSeason[m.key] = {};
          }
          teamData.set(key, init);
          // ajout du tracking par bucket : byBucket[marketKey][bucket] = [n,m,r,w]
          const tdNew = teamData.get(key);
          tdNew.byBucket = {};
          for (const m of MARKETS) {
            tdNew.byBucket[m.key] = { TF:[0,0,0,0], FN:[0,0,0,0], PE:[0,0,0,0], OU:[0,0,0,0] };
          }
        }
        const td = teamData.get(key);

        const ftr = row.FTR;
        // Match futur (pas de FTR) - tracking pour fixtures a venir
        if ((!ftr || !["H","D","A"].includes(ftr)) && season === CURRENT_SEASON) {
          const date = parseDate(row.Date);
          if (date && date > new Date()) {
            const oddsH = fnum(row, "AvgH", "BbAvH", "B365H");
            td.future.push({ date: row.Date, opponent: away, odds: oddsH });
          }
          continue;
        }
        if (!["H","D","A"].includes(ftr)) continue;

        // Determiner le bucket selon la cote H
        const oddsH = fnum(row, "AvgH", "BbAvH", "B365H");
        const bucket = getBucket(oddsH);

        // Pour chaque marche, calculer le resultat du pari
        for (const m of MARKETS) {
          const result = m.compute(row);
          if (!result) continue;
          if (!td.perMarketSeason[m.key][season]) td.perMarketSeason[m.key][season] = [0,0,0,0];
          const ps = td.perMarketSeason[m.key][season];
          ps[0]++; ps[1]++;
          if (result.won) { ps[2] += result.odds; ps[3]++; }
          // bucket
          if (bucket) {
            const bs = td.byBucket[m.key][bucket];
            bs[0]++; bs[1]++;
            if (result.won) { bs[2] += result.odds; bs[3]++; }
          }
        }
      }
    }

    // Calcul des stats par equipe x marche
    const results = [];
    for (const td of teamData.values()) {
      // Pour chaque marche on calcule les agregats
      const markets = {};
      let bk_n_win = 0, pos_seasons_win = 0, nb_seasons_win = 0;

      for (const m of MARKETS) {
        const ps = td.perMarketSeason[m.key];
        let bk_n=0, bk_m=0, bk_r=0, bk_w=0;
        let oos = [0,0,0,0]; let next = [0,0,0,0];
        let pos_s = 0, nb_s = 0;
        const perSeason = {};

        for (const s of SEASONS_BACKTEST) {
          const v = ps[s] || [0,0,0,0];
          bk_n += v[0]; bk_m += v[1]; bk_r += v[2]; bk_w += v[3];
          if (v[1] > 0) {
            nb_s++;
            if (v[2] >= v[1]) pos_s++;
            perSeason[s] = { n: v[0], v: v[3], roi: (v[2]-v[1])/v[1]*100 };
          } else {
            perSeason[s] = null;
          }
        }
        oos = ps[CURRENT_SEASON] || [0,0,0,0];
        if (oos[1] > 0) {
          nb_s++;
          if (oos[2] >= oos[1]) pos_s++;
          perSeason[CURRENT_SEASON] = { n: oos[0], v: oos[3], roi: (oos[2]-oos[1])/oos[1]*100 };
        } else {
          perSeason[CURRENT_SEASON] = null;
        }
        next = ps[NEXT_SEASON] || [0,0,0,0];
        perSeason[NEXT_SEASON] = next[1] > 0 ? { n: next[0], v: next[3], roi: (next[2]-next[1])/next[1]*100 } : null;

        const tot_n = bk_n + oos[0] + next[0];
        const tot_m = bk_m + oos[1] + next[1];
        const tot_r = bk_r + oos[2] + next[2];
        const tot_w = bk_w + oos[3] + next[3];

        // ROI 3y agrege (saisons 23-24 + 24-25 + 25-26)
        let n_3y=0, m_3y=0, r_3y=0, w_3y=0, sw_3y=0;
        for (const s of SEASONS_3Y) {
          const v = ps[s] || [0,0,0,0];
          if (v[1] > 0) sw_3y++;
          n_3y += v[0]; m_3y += v[1]; r_3y += v[2]; w_3y += v[3];
        }
        const roi_3y = m_3y > 0 ? +((r_3y - m_3y) / m_3y * 100).toFixed(2) : null;

        // ROI par bucket (TF/FN/PE/OU) sur l'ensemble des saisons
        const buckets = {};
        const bb = td.byBucket[m.key];
        for (const b of ["TF","FN","PE","OU"]) {
          const v = bb[b];
          if (v[1] > 0) {
            buckets[b] = {
              n: v[0],
              w: v[3],
              roi: +((v[2]-v[1])/v[1]*100).toFixed(2),
            };
          } else {
            buckets[b] = { n: 0, w: 0, roi: null };
          }
        }

        markets[m.key] = {
          label: m.label,
          n_5y: bk_n, n_oos: oos[0], n_next: next[0], n_total: tot_n,
          n_3y, w_3y, seasonsWithData_3y: sw_3y,
          w_total: tot_w,
          roi_5y: bk_m > 0 ? +((bk_r-bk_m)/bk_m*100).toFixed(2) : null,
          roi_3y,
          roi_oos: oos[1] > 0 ? +((oos[2]-oos[1])/oos[1]*100).toFixed(2) : null,
          roi_next: next[1] > 0 ? +((next[2]-next[1])/next[1]*100).toFixed(2) : null,
          roi_all: tot_m > 0 ? +((tot_r-tot_m)/tot_m*100).toFixed(2) : null,
          profit_total: +(tot_r-tot_m).toFixed(2),
          posSeasons: `${pos_s}/${nb_s}`,
          perSeason,
          buckets,
        };

        if (m.key === "win") {
          bk_n_win = bk_n;
          pos_seasons_win = pos_s;
          nb_seasons_win = nb_s;
        }
      }

      // Filtre Tier 1 base sur le marche "win" (pour rester comparable au projet d'origine)
      if (bk_n_win < 60) continue;
      if (markets.win.roi_5y === null) continue;

      const isTier1 = (markets.win.roi_5y >= 5)
                   && (markets.win.roi_oos === null || markets.win.roi_oos >= 0)
                   && pos_seasons_win >= 3
                   && (markets.win.roi_all || 0) >= 10;
      const isElite = isTier1 && markets.win.roi_oos !== null && markets.win.roi_oos > 0;

      // bestMarket3y : meilleure recommandation parmi win / win_over25 / ah_minus1
      // Critere : n_3y >= seuil ET roi_3y disponible. On prend le max ROI 3y.
      let bestMarket3y = null;
      for (const k of RECOMMENDED_MARKETS) {
        const mk = markets[k];
        if (!mk || mk.roi_3y === null || mk.n_3y < RECOMMENDED_MIN_N_3Y) continue;
        if (!bestMarket3y || mk.roi_3y > bestMarket3y.roi_3y) {
          bestMarket3y = { key: k, label: mk.label, roi_3y: mk.roi_3y, n_3y: mk.n_3y };
        }
      }

      results.push({
        team: td.team,
        league: td.league,
        leagueName: td.leagueName,
        tier: td.tier,
        markets,
        isTier1,
        isElite,
        bestMarket3y,
        nextMatches: td.future.slice(0, 3),
      });
    }

    // Tri par ROI 5y (sur "win") descendant, Tier1 d'abord
    results.sort((a, b) => {
      if (a.isTier1 !== b.isTier1) return a.isTier1 ? -1 : 1;
      return (b.markets.win.roi_5y || 0) - (a.markets.win.roi_5y || 0);
    });

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({
      lastUpdate: new Date().toISOString(),
      criteria: {
        minMatches5y: 60,
        minRoi5y: 5,
        minPositiveSeasons: 3,
        leaguesCovered: LEAGUES.length,
        seasonsCovered: SEASONS.length,
        markets: MARKETS.map(m => ({ key: m.key, label: m.label })),
        seasons3y: SEASONS_3Y,
        recommendedMarkets: RECOMMENDED_MARKETS,
        minN3yForRecommendation: RECOMMENDED_MIN_N_3Y,
      },
      counts: {
        all: results.length,
        tier1: results.filter(r => r.isTier1).length,
        elite: results.filter(r => r.isElite).length,
      },
      teams: results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
}
