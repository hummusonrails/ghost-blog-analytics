## Ghost blog analytics

Script to pull the last 12 months of Ghost Admin stats and Tinybird KPIs, then write two CSVs (aggregate and daily) plus a console table.

### Setup
- Node 18+
- `.env` with `GHOST_URL` (or `GHOST_ADMIN_URL`), `GHOST_ADMIN_KEY`, optional `TIMEZONE` (defaults to `Etc/UTC`).
- Install deps: `npm install`

### Run
- `node analytics.js`
- Outputs `analytics-aggregate-<timestamp>.csv` and `analytics-daily-<timestamp>.csv` in the repo root.

### License
MIT