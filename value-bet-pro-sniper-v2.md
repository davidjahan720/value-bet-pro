# Value Bet Pro Sniper V2

Ceci est la documentation pour l'application Sniper V2, accessible via l'API.

## Accès
L'application est déployée avec le reste du projet sur Vercel. Après le push sur la branche `v2`, elle est disponible à l'adresse :
`/api/watchlist-simulation-v2`

## Paramètres de l'URL
L'application accepte les paramètres suivants via la query string :

- `teams`: Liste des équipes sous forme `Team1|Ligue1,Team2|Ligue2`.
- `roiThreshold`: ROI historique minimum (ex: `25` pour 25%).
- `winRateThreshold`: Taux de réussite historique minimum (ex: `30` pour 30%).

## Exemple d'appel
`https://value-bet-pro.vercel.app/api/watchlist-simulation-v2?teams=Lens|F1,Mallorca|SP1&roiThreshold=25&winRateThreshold=30`
