// Vercel Serverless Function — proxy CSV historiques depuis football-data.co.uk
// Évite le problème CORS en servant le CSV depuis notre propre domaine

export default async function handler(req, res) {
  const { league = "F2", season = "2526" } = req.query;

  // Codes ligue valides (football-data.co.uk)
  const validLeagues = [
    "F1", "F2",       // France L1, L2
    "E0", "E1", "E2", "E3", // Angleterre Premier, Championship, L1, L2
    "D1", "D2",       // Allemagne Bundes, 2.Bundes
    "SP1", "SP2",     // Espagne Liga, Segunda
    "I1", "I2",       // Italie Série A, B
    "P1",             // Portugal Primeira
    "N1",             // Pays-Bas Eredivisie
    "B1",             // Belgique Pro League
    "SC0", "SC1",     // Écosse Premier, Championship
    "T1",             // Turquie Süper Lig
    "G1"              // Grèce Super League
  ];

  if (!validLeagues.includes(league)) {
    return res.status(400).json({ error: `Code ligue invalide. Valides: ${validLeagues.join(", ")}` });
  }

  if (!/^\d{4}$/.test(season)) {
    return res.status(400).json({ error: "Format saison invalide (attendu YYYY ex 2526)" });
  }

  const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ValueBetAnalyzer/1.0)"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Échec récupération CSV (${response.status})`,
        url
      });
    }

    const csv = await response.text();

    // Cache côté Vercel : 1h (les CSV historiques ne changent pas souvent)
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
