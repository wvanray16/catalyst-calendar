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

## Editing

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
