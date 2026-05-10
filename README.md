# Value Bet Pro

Webapp d'analyse multi-marchés du ROI « équipes à domicile » sur 7 saisons (2020-21 → 2026-27).

Successeur enrichi du projet [value-bet-analyzer](https://github.com/davidjahan720/test-paris). Au lieu d'afficher uniquement le ROI sur le marché « 1 sec » (1N2 home win), Value Bet Pro compare **simultanément 6 marchés** pour chaque équipe :

- **1 sec** (baseline 1N2)
- **Over 2.5 buts** seul
- **Under 2.5 buts** seul
- **Double Chance 1X** (cote synthétisée via `1/(1/H + 1/D)`)
- **Victoire + Over 2.5** (combiné via produit des cotes)
- **AH -1** (Asian Handicap : favori dom doit gagner par 2+ buts)

## Découverte clé

Sur le portfolio des 10 équipes Élite, le marché **« Victoire + Over 2.5 »** affiche un ROI de **+29.94 %** sur 1 038 paris — presque le double du « 1 sec » à +16.43 %.

Cote moyenne ~3.00, win rate 34 %. Bankroll min recommandée : 80-100 unités.

## Stack

- **Frontend** : HTML/CSS/JS vanilla (palette dark GitHub-like)
- **Backend** : Node.js Vercel Functions
- **Sources** :
  - [football-data.co.uk](https://www.football-data.co.uk) — historiques + cotes moyennes marché
  - [fixturedownload.com](https://fixturedownload.com) — fixtures à venir (gratuit, sans clé API)

## Structure

```
value-bet-pro/
├── api/
│   ├── team-rankings.js        # Calcul ROI multi-marchés (15 ligues × 7 saisons)
│   ├── upcoming-fixtures.js    # Fixtures à venir
│   └── historical-odds.js      # Proxy CSV football-data.co.uk
├── index.html                   # UI multi-marchés
├── vercel.json
└── README.md
```

## Critères de filtrage (figés dans `api/team-rankings.js`)

- `n >= 60` paris in-sample (2020-21 → 2024-25)
- ROI 5y du « 1 sec » `>= +5 %`
- `>= 3 saisons positives` sur les 6 saisons jouées
- **Tier 1** = critères ci-dessus + ROI consolidé `>= +10 %`
- **Élite** = Tier 1 + ROI 25-26 strictement positif

## Déploiement Vercel

```bash
vercel --prod
```

Le projet est statique + 3 fonctions serverless. Aucune base de données nécessaire — tout est calculé à la volée avec un cache Vercel Edge de 6 heures.

## Endpoints API

| Endpoint | Description | Cache |
|---|---|---|
| `/api/team-rankings` | Tableau ROI multi-marchés (~120 KB JSON) | 6h |
| `/api/upcoming-fixtures?teams=Lorient\|F1,...&days=10` | Fixtures à venir | 1h |
| `/api/historical-odds?league=F2&season=2526` | Proxy CSV football-data | 1h |

## Méthodologie de mesure

Mise plate de **1 € par match domicile**, à la cote moyenne du marché bookmaker (`AvgH`, `Avg>2.5`, etc. selon le marché). Profit = retour - mise. ROI = profit / mise × 100.

Pour chaque marché, le ROI est calculé séparément par saison puis agrégé. Une équipe est considérée robuste si elle reste positive sur ≥ 3 saisons et avec un échantillon ≥ 60 paris.
