# dsh-usage-ledger

Request-level token usage ledger for DeepSeek Harness.

- **Fact store**: every provider call lands as one row (tokens, first-token
  wait, decode speed, status) in a local SQLite database with a 30-day
  rolling prune; permanent per-day rollups (day × model / kind / tool, plus a
  session index) live in a storage domain.
- **Global panel**: a Usage ledger row in the sidebar opens lifetime summary
  cards, a 52-week heatmap, daily per-model curves, and model/tool
  distribution.
- **Session view**: each session page gains a Usage tab with that session's
  own breakdown.

All data is derived from session logs; recording is observational and never
interferes with turns. Do not enable together with `dsh-token-total`.

## Configuration

Edit the `usage-ledger` row's `config` in `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `retentionDays` | 30 | SQLite detail retention |
| `heatmapWeeks` | 52 | Default heatmap span |
| `backfillConcurrency` | 4 | Historical scan parallelism |
| `factsDbPath` | `""` | Override the SQLite file location |
