# Catalyst Calendar

A single self-contained HTML page: the Aug–Dec 2026 catalyst calendar (earnings,
dividends, macro prints, OpEx, product/conference dates, index events) for the
AI-hardware complex — NVDA, MRVL, COHR, GLW, AMKR, CRDO, IREN and friends.

No server, no API calls, no build step. All data and styling live inside
`index.html`. Light/dark theme follows the OS and can be toggled.

## Hosting

Deployed on Render as a **Static Site**:

- Build Command: *(empty)*
- Publish Directory: `.`

Pushing to `main` redeploys automatically. `render.yaml` is only needed if you
create the service via Render's Blueprint flow; the plain Static Site UI ignores it.

## Weekly refresh

`.github/workflows/weekly-update.yml` runs `scripts/update-calendar.mjs` every
Sunday at 13:00 UTC (and on demand from the Actions tab). It commits any changes,
which Render then auto-deploys.

What it maintains:

| Refreshed automatically | Stays hand-curated |
|---|---|
| Prices in `POSITIONS` | Conferences, product launches, capital raises |
| Earnings dates + confirmed/estimated flag | Macro prints (published a year ahead) |
| Ex-dividend and pay dates | Index rebalances, OPEX, market holidays |

The script is deliberately conservative. It only writes dates, prices, and the
`s` confidence flag — never a `title`, `desc`, or `src`, since those hold
research no API can reproduce. It never deletes an event, never overwrites a
company-confirmed date with an API estimate, and refuses to write at all if the
output size drifts more than 2 KB from the input (the signature of a parse bug).
A dead data source degrades to "no changes," not a broken page.

Data comes from Yahoo (no key required). Setting a `FINNHUB_TOKEN` repository
secret adds Finnhub as the preferred earnings source; without it the job still
runs on Yahoo alone.

Preview what a run would do without touching anything:

```bash
npm run update:dry
```

## Editing by hand

Open `index.html` and edit the `EVENTS` array near the middle of the file. Each
entry looks like:

```js
{d:'2026-10-01', t:'NVDA', c:'dividend', tier:3, s:'E',
 title:'Dividend pay date ($0.25)', desc:'…', src:'https://…'}
```

- `d` — ISO date
- `t` — ticker
- `c` — category (drives the color and the filter chips)
- `tier` — 1 = highest impact
- `s` — `C` confirmed / `E` estimated
- `src` — source URL shown on the row

Save, commit, push. Render picks it up in under a minute.
