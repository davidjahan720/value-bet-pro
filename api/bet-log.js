// Vercel Serverless Function — Bet log historique walk-forward
// Pour chaque match domicile des equipes Elite, simule en PARALLELE :
//   - Strategie A : "1 sec" (pari sur la victoire a chaque match)
//   - Strategie B : "V + Over 2.5" (combine victoire + plus de 2,5 buts)
// Mise 1€ par pari. Stats decomposees par saison + total.
// Saisons par defaut : 2425 (passee) et 2526 (en cours).

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
  { code: "G1",  name: "Super League GRE" },
];

const SEASON_LABELS = {
  "2021": "2020-21", "2122": "2021-22", "2223": "2022-23",
  "2324": "2023-24", "2425": "2024-25", "2526": "2025-26", "2627": "2026-27",
};

const STRATS = [
  { key: "win",         label: "1 sec",          emoji: "✅" },
  { key: "win_over25",  label: "V + Over 2.5",   emoji: "🎯" },
];

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

function computeMarket(row, market) {
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
  return null;
}

function emptyStats() {
  return { n_bets: 0, wins: 0, stake: 0, ret: 0 };
}
function finalizeStats(st, strat) {
  const profit = st.ret - st.stake;
  return {
    label: strat.label,
    emoji: strat.emoji,
    n_bets: st.n_bets,
    wins: st.wins,
    winRate: st.n_bets > 0 ? +(st.wins / st.n_bets * 100).toFixed(1) : 0,
    stake: st.stake,
    total_return: +st.ret.toFixed(2),
    profit: +profit.toFixed(2),
    roi: st.stake > 0 ? +(profit / st.stake * 100).toFixed(2) : 0,
  };
}

export default async function handler(req, res) {
  try {
    const { teams = "", seasons: seasonsParam = "2425,2526" } = req.query;
    const seasons = seasonsParam.split(",").filter(Boolean).map(s => s.trim());

    const wanted = teams.split(",").filter(Boolean).map(s => {
      const [team, lg] = s.split("|");
      return { team: (team || "").trim(), league: (lg || "").trim() };
    });
    if (wanted.length === 0) {
      return res.status(400).json({ error: "Param 'teams' obligatoire" });
    }
    // Pas de limite de nb d'equipes : on accepte tout le classement Elite.

    const teamsData = [];
    for (const w of wanted) {
      const allRows = [];
      const seasonTasks = seasons.map(s =>
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
      allRows.sort((a, b) => a._d - b._d);

      // Stats par strategie + par saison
      const stratStats = {};
      for (const s of STRATS) {
        stratStats[s.key] = { total: emptyStats(), bySeason: {} };
        for (const seas of seasons) {
          stratStats[s.key].bySeason[seas] = emptyStats();
        }
      }

      const log = [];
      for (const row of allRows) {
        const oddsH = fnum(row, "AvgH", "BbAvH", "B365H");
        const bucket = getBucket(oddsH);
        const entry = {
          date: row.Date,
          season: row._season,
          opponent: (row.AwayTeam || "").trim(),
          cote_H: oddsH || null,
          bucket,
          result_score: `${row.FTHG}-${row.FTAG}`,
          ftr: row.FTR,
          bets: {},
        };
        let hasAnyBet = false;
        for (const s of STRATS) {
          const r = computeMarket(row, s.key);
          if (!r) {
            entry.bets[s.key] = null;
            continue;
          }
          hasAnyBet = true;
          const tot = stratStats[s.key].total;
          const sea = stratStats[s.key].bySeason[row._season];
          tot.n_bets++; tot.stake++;
          if (sea) { sea.n_bets++; sea.stake++; }
          const profit = r.won ? (r.odds - 1) : -1;
          if (r.won) {
            tot.ret += r.odds; tot.wins++;
            if (sea) { sea.ret += r.odds; sea.wins++; }
          }
          entry.bets[s.key] = {
            odds: +r.odds.toFixed(2),
            won: r.won,
            profit: +profit.toFixed(2),
          };
        }
        if (hasAnyBet) log.push(entry);
      }

      // Mise en forme
      const summaryByStrat = {};
      for (const s of STRATS) {
        const bySeason = {};
        for (const seas of seasons) {
          bySeason[seas] = finalizeStats(stratStats[s.key].bySeason[seas], s);
        }
        summaryByStrat[s.key] = {
          total: finalizeStats(stratStats[s.key].total, s),
          bySeason,
        };
      }

      teamsData.push({
        team: w.team,
        league: w.league,
        leagueName: LEAGUES.find(l => l.code === w.league)?.name || w.league,
        n_matches: log.length,
        strats: summaryByStrat,
        log,
      });
    }

    // Agregation globale (total + par saison)
    const overall = {};
    for (const s of STRATS) {
      const bySeason = {};
      let totalSt = emptyStats();
      for (const seas of seasons) {
        let seasSt = emptyStats();
        for (const t of teamsData) {
          const ts = t.strats[s.key].bySeason[seas];
          seasSt.n_bets += ts.n_bets;
          seasSt.wins += ts.wins;
          seasSt.stake += ts.stake;
          seasSt.ret += ts.total_return;
        }
        bySeason[seas] = finalizeStats(seasSt, s);
        // Cumul total
        totalSt.n_bets += seasSt.n_bets;
        totalSt.wins += seasSt.wins;
        totalSt.stake += seasSt.stake;
        totalSt.ret += seasSt.ret;
      }
      overall[s.key] = {
        total: finalizeStats(totalSt, s),
        bySeason,
      };
    }

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({
      lastUpdate: new Date().toISOString(),
      methodology: "2 strategies pures (1 sec et V+Over 2.5), mise 1€ par pari sur chaque match dom., resultats par saison",
      strats: STRATS.map(s => ({ key: s.key, label: s.label, emoji: s.emoji })),
      seasons,
      seasonLabels: seasons.reduce((acc, s) => ({ ...acc, [s]: SEASON_LABELS[s] || s }), {}),
      overall,
      teams: teamsData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
}
