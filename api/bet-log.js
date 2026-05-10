// Vercel Serverless Function — Bet log historique walk-forward
// Simule pour chaque match a domicile du top 4 Elite :
//   1) Determine le bucket de la cote H
//   2) Choisit le marche recommande par la strat actuelle (bucket si n>=30, sinon global)
//      en n'utilisant QUE les matchs joues AVANT celui-ci (walk-forward)
//   3) Calcule si le pari (mise 1€) aurait gagne et le profit/perte
// Retourne le log par match + statistiques cumulees

const LEAGUES = [
  { code: "F1",  name: "Ligue 1 FRA" },
  { code: "F2",  name: "Ligue 2 FRA" },
  { code: "E0",  name: "Premier League" },
  { code: "E1",  name: "Championship ENG" },
  { code: "D1",  name: "Bundesliga" },
  { code: "D2",  name: "2.Bundesliga" },
  { code: "SP1", name: "LaLiga" },
  { code: "SP2", name: "Segunda ESP" },
  { code: "I1",  name: "Serie A" },
  { code: "I2",  name: "Serie B" },
  { code: "P1",  name: "Liga Portugal" },
  { code: "N1",  name: "Eredivisie" },
  { code: "SC0", name: "Premiership ECO" },
  { code: "SC1", name: "Championship ECO" },
  { code: "B1",  name: "Pro League BEL" },
];

const SEASONS = ["2021", "2122", "2223", "2324", "2425", "2526", "2627"];

const MARKETS_LABEL = {
  "win": "1 sec",
  "win_over25": "V + Over 2.5",
  "ah_minus1": "AH -1",
};
const MARKETS_EMOJI = {
  "win": "✅",
  "win_over25": "🎯",
  "ah_minus1": "💪",
};
const VISIBLE_MARKETS = ["win", "win_over25", "ah_minus1"];
const MIN_BUCKET_N = 30;
const MIN_GLOBAL_N = 20;

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
function parseDate(s) {
  if (!s) return null;
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  let [d, m, y] = parts;
  if (y.length === 2) y = "20" + y;
  return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
}

async function fetchCsv(season, league) {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "ValueBetPro/1.0" } });
    if (!r.ok) return [];
    return parseCsv(await r.text());
  } catch { return []; }
}

function getBucket(oddsH) {
  if (!oddsH || oddsH <= 0) return null;
  if (oddsH < 1.50) return "TF";
  if (oddsH < 2.00) return "FN";
  if (oddsH < 2.80) return "PE";
  return "OU";
}

// Calcule pour chaque marche le resultat d'un pari sur ce match
function computeMarketResult(row, market) {
  const hg = parseInt(row.FTHG); const ag = parseInt(row.FTAG);
  if (isNaN(hg) || isNaN(ag)) return null;
  const ftr = row.FTR;
  if (market === "win") {
    const odds = fnum(row, "AvgH", "BbAvH", "B365H");
    return odds > 0 ? { odds, won: ftr === "H" } : null;
  }
  if (market === "win_over25") {
    const oH = fnum(row, "AvgH", "BbAvH");
    const oO = fnum(row, "Avg>2.5", "BbAv>2.5");
    if (oH <= 0 || oO <= 0) return null;
    return { odds: oH * oO, won: ftr === "H" && (hg + ag) > 2.5 };
  }
  if (market === "ah_minus1") {
    const ahh = fnumRaw(row, "AHh");
    if (ahh !== -1) return null;
    const odds = fnum(row, "AvgAHH", "BbAvAHH");
    if (odds <= 0) return null;
    const margin = hg - ag;
    if (margin === 1) return null;  // push, exclu
    return { odds, won: margin >= 2 };
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const { teams = "" } = req.query;
    const wanted = teams.split(",").filter(Boolean).map(s => {
      const [team, lg] = s.split("|");
      return { team: (team || "").trim(), league: (lg || "").trim() };
    });
    if (wanted.length === 0) {
      return res.status(400).json({ error: "Param 'teams' obligatoire" });
    }
    if (wanted.length > 6) {
      return res.status(400).json({ error: "Trop d'equipes (max 6)" });
    }

    // Pour chaque equipe, on telecharge ses 7 saisons (multi-ligue eventuel)
    // mais on suit ses matchs domicile dans la ligue specifiee.
    const teamsData = [];
    for (const w of wanted) {
      const allRows = [];
      const seasonTasks = SEASONS.map(s =>
        fetchCsv(s, w.league).then(rows => ({ season: s, rows }))
      );
      const datasets = await Promise.all(seasonTasks);
      for (const { season, rows } of datasets) {
        for (const r of rows) {
          if ((r.HomeTeam || "").trim() !== w.team) continue;
          if (!["H","D","A"].includes(r.FTR)) continue;
          const d = parseDate(r.Date);
          if (!d) continue;
          allRows.push({ ...r, _d: d, _season: season });
        }
      }
      // Tri chronologique
      allRows.sort((a, b) => a._d - b._d);

      // Walk-forward simulation
      // Profil rolling : par marche, par bucket [n, mise, retour, w], + global [n, mise, retour, w]
      const profile = {};
      for (const m of VISIBLE_MARKETS) {
        profile[m] = {
          global: [0, 0, 0, 0],
          buckets: { TF:[0,0,0,0], FN:[0,0,0,0], PE:[0,0,0,0], OU:[0,0,0,0] },
        };
      }

      function pickRecommendation(bucket) {
        // 1) Si bucket dispo et n>=MIN_BUCKET_N dans au moins un marche : choisir best bucket
        let bestM = null, bestRoi = -Infinity;
        if (bucket) {
          for (const m of VISIBLE_MARKETS) {
            const b = profile[m].buckets[bucket];
            if (b[1] < MIN_BUCKET_N) continue;
            const roi = (b[2] - b[1]) / b[1] * 100;
            if (roi > bestRoi) { bestRoi = roi; bestM = m; }
          }
          if (bestM) return { market: bestM, mode: "bucket", roi_used: bestRoi };
        }
        // 2) Fallback global (n>=MIN_GLOBAL_N)
        for (const m of VISIBLE_MARKETS) {
          const g = profile[m].global;
          if (g[1] < MIN_GLOBAL_N) continue;
          const roi = (g[2] - g[1]) / g[1] * 100;
          if (roi > bestRoi) { bestRoi = roi; bestM = m; }
        }
        if (bestM) return { market: bestM, mode: "global", roi_used: bestRoi };
        return null;  // pas assez de data pour recommander
      }

      const log = [];
      let totalStake = 0, totalReturn = 0, totalWins = 0;

      for (const row of allRows) {
        const oddsH = fnum(row, "AvgH", "BbAvH", "B365H");
        const bucket = getBucket(oddsH);

        // Recommandation basee sur le profil ACTUEL (matchs joues avant celui-ci)
        const rec = pickRecommendation(bucket);

        if (rec) {
          const result = computeMarketResult(row, rec.market);
          if (result) {
            totalStake += 1;
            const profit = result.won ? (result.odds - 1) : -1;
            totalReturn += result.won ? result.odds : 0;
            if (result.won) totalWins++;
            log.push({
              date: row.Date,
              season: row._season,
              opponent: (row.AwayTeam || "").trim(),
              cote_H: oddsH,
              bucket,
              result_score: `${row.FTHG}-${row.FTAG}`,
              ftr: row.FTR,
              recommended: {
                market: rec.market,
                label: MARKETS_LABEL[rec.market],
                emoji: MARKETS_EMOJI[rec.market],
                mode: rec.mode,
                roi_at_time: +rec.roi_used.toFixed(2),
              },
              bet_odds: +result.odds.toFixed(2),
              won: result.won,
              profit: +profit.toFixed(2),
            });
          }
        }

        // Mise a jour du profil rolling avec ce match (apres simulation)
        for (const m of VISIBLE_MARKETS) {
          const r = computeMarketResult(row, m);
          if (!r) continue;
          // global
          profile[m].global[0]++;
          profile[m].global[1]++;
          if (r.won) { profile[m].global[2] += r.odds; profile[m].global[3]++; }
          // bucket
          if (bucket) {
            profile[m].buckets[bucket][0]++;
            profile[m].buckets[bucket][1]++;
            if (r.won) { profile[m].buckets[bucket][2] += r.odds; profile[m].buckets[bucket][3]++; }
          }
        }
      }

      const profit = totalReturn - totalStake;
      const roi = totalStake > 0 ? +(profit / totalStake * 100).toFixed(2) : 0;
      const winRate = log.length > 0 ? +(totalWins / log.length * 100).toFixed(1) : 0;

      teamsData.push({
        team: w.team,
        league: w.league,
        leagueName: LEAGUES.find(l => l.code === w.league)?.name || w.league,
        n_bets: log.length,
        wins: totalWins,
        winRate,
        total_stake: totalStake,
        total_return: +totalReturn.toFixed(2),
        profit: +profit.toFixed(2),
        roi,
        log,
      });
    }

    // Agregation globale
    const overall_n = teamsData.reduce((s, t) => s + t.n_bets, 0);
    const overall_wins = teamsData.reduce((s, t) => s + t.wins, 0);
    const overall_stake = teamsData.reduce((s, t) => s + t.total_stake, 0);
    const overall_return = teamsData.reduce((s, t) => s + t.total_return, 0);
    const overall_profit = overall_return - overall_stake;
    const overall_roi = overall_stake > 0 ? +(overall_profit / overall_stake * 100).toFixed(2) : 0;
    const overall_winRate = overall_n > 0 ? +(overall_wins / overall_n * 100).toFixed(1) : 0;

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({
      lastUpdate: new Date().toISOString(),
      methodology: "walk-forward (chaque pari simule n'utilise que les matchs joues AVANT lui)",
      criteria: {
        minBucketN: MIN_BUCKET_N,
        minGlobalN: MIN_GLOBAL_N,
        markets: VISIBLE_MARKETS,
        seasons: SEASONS,
      },
      overall: {
        n_bets: overall_n,
        wins: overall_wins,
        winRate: overall_winRate,
        total_stake: overall_stake,
        total_return: +overall_return.toFixed(2),
        profit: +overall_profit.toFixed(2),
        roi: overall_roi,
      },
      teams: teamsData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
}
