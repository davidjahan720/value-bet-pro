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
│   ├── historical-odds.js      # Proxy CSV football-data.co.uk
│   ├── bet-log.js              # Bet log walk-forward
│   ├── live-odds.js            # Live odds (The Odds API)
│   ├── decision-matrix.js      # Matrice catégorie → impact (veille)
│   ├── veille-cron.js          # Cron quotidien Mistral + Vercel Blob
│   └── veille-get.js           # Lecture du store de veille
├── index.html                   # UI multi-marchés + onglet Veille
├── package.json                 # Dépend de @vercel/blob
├── vercel.json                  # Functions + cron schedule
├── .env.example                 # Doc des secrets (MISTRAL_API_KEY, etc.)
└── README.md
```

## Veille événementielle quotidienne

Onglet « 🔔 Veille » de l'app : surveille **3 équipes du Tier A** (Aston Villa, Atlético Madrid, Lorient) pour détecter les événements à impact sur le ROI V+O2.5.

### Pipeline

1. **Cron Vercel** quotidien à 07h00 UTC → `/api/veille-cron`
2. Pour chaque équipe : fetch **Google News RSS** (24h glissantes, fr-FR)
3. Envoi des titres à **Mistral** (`mistral-small-latest`) pour catégorisation + scoring
4. Fusion avec store existant (déduplication par URL) — **events persistent jusqu'à expiration** (durée par catégorie, ex: blessure 21 jours)
5. Calcul score cumulé + décision via `decision-matrix.js`
6. Persistance dans **Vercel Blob** (`veille/latest.json`)

### Matrice de décision

Chaque event a un impact dans `[-3, +3]` selon sa catégorie (cf. `api/decision-matrix.js`) :

| Catégorie | Impact défaut |
|---|---|
| Blessure attaquant titulaire | −2 |
| Blessures multiples attaquants | −4 |
| Départ d'un buteur | −3 |
| Changement d'entraîneur | −1 |
| Mauvaise forme (3 défaites) | −2 |
| Arrivée d'un buteur | +2 |
| Bonne forme (3 victoires) | +1 |

Score cumulé sur events actifs → décision :

| Score | Décision | Mise |
|---|---|---|
| ≥ +1 | 🟢 GO BOOST | 1.50 € |
| 0 à −1 | 🟢 GO PLEIN | 1.00 € |
| −2 à −3 | 🟡 RÉDUIT | 0.50 € |
| −4 à −5 | 🟠 MINIMUM | 0.20 € |
| ≤ −6 | 🔴 SKIP | 0 € |

### Override manuel

Chaque carte propose un dropdown pour forcer une décision (persisté en `localStorage` côté navigateur). Le store Vercel Blob garde la recommandation auto intacte.

### Secrets requis (Vercel Environment Variables)

| Variable | Description |
|---|---|
| `MISTRAL_API_KEY` | Console Mistral |
| `BLOB_READ_WRITE_TOKEN` | Vercel Storage → Blob → Create Store |
| `CRON_SECRET` | Random 32+ chars, protège `/api/veille-cron` |

Voir `.env.example`.

### Coût estimé

~1.5 €/mois (Mistral 30 runs × 3 équipes, web RSS gratuit, Blob/cron gratuits sur Hobby).

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
| `/api/bet-log` | Walk-forward bet log | 24h |
| `/api/live-odds` | Live odds top 4 équipes | 6h |
| `/api/veille-cron` | Cron quotidien (Authorization Bearer requis) | n/a |
| `/api/veille-get` | Lecture du store veille | 5 min |

## Méthodologie de mesure

Mise plate de **1 € par match domicile**, à la cote moyenne du marché bookmaker (`AvgH`, `Avg>2.5`, etc. selon le marché). Profit = retour - mise. ROI = profit / mise × 100.

Pour chaque marché, le ROI est calculé séparément par saison puis agrégé. Une équipe est considérée robuste si elle reste positive sur ≥ 3 saisons et avec un échantillon ≥ 60 paris.
