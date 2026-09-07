# FPL Edge 2.1

A mobile-first Fantasy Premier League decision engine built around Team ID 702959 by default.

## Included
- Live public FPL squad, manager, history and transfer data
- Current GW, rank, points, team value and bank
- Free-transfer replay with 5-transfer cap and chip handling
- 1–5 transfer optimisation with hit costs and legal squad constraints
- FPL selling-price handling, including observed selling price when exposed by the picks feed
- Next-five fixture model using FDR and player metrics
- Squad news/availability panel
- Two-set chip tracker for 2026/27
- Price snapshot persistence and observed price movement
- Season recommendation memory
- Mobile-first UI and PWA manifest/service worker

## Run locally

Requirements: Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:3000`.

The default team is `702959`. Override with:

```bash
FPL_TEAM_ID=702959 npm start
```

## Important
This app uses the public FPL API and does not request your FPL password or private session cookie. Public team information can be loaded from a Team ID; private account actions are intentionally not implemented.

Recommendations are projections, not guaranteed points. The official FPL price is treated as the source of truth; price-change indicators are guidance rather than guarantees.
