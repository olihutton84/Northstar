# Railway readiness — gap list

**Nothing here is deployed and nothing is configured.** This is the audit of
what is missing, written so the deployment can be done deliberately rather than
discovered mid-incident.

Railway deployment is owned by this repository (see CLAUDE.md). It has not been
started.

## Gaps

| # | Gap | Current state | What it needs |
|---|---|---|---|
| 1 | **No `start` script** | `package.json` has `build`, `lab`, `serve`, `paper`… but no `start` | Railway's default is `npm start`. Needs an explicit entrypoint per process. |
| 2 | **No deployment config** | no `railway.json`, `Procfile`, `Dockerfile`, `nixpacks.toml` | Build command, start command, restart policy, healthcheck path. |
| 3 | **Port binding** | reads `NORTHSTAR_PORT`, defaults 3737 | Railway injects **`PORT`**. Must prefer `PORT` when present. |
| 4 | **Host binding** | `server.listen(this.port)` — no host | Railway requires binding **`0.0.0.0`**, not loopback. |
| 5 | **No `SIGTERM` handler** | only `SIGINT` (Ctrl-C) in the `paper` command | Railway stops containers with `SIGTERM`. Without it the scheduler is killed mid-task and the SQLite write may be interrupted. `Scheduler.stop()` and `app.close()` already exist — they just need wiring to the signal. |
| 6 | **Persistent storage** | SQLite at `NORTHSTAR_DB_PATH`, default `./data/northstar.sqlite` | Railway's filesystem is **ephemeral**. Needs a mounted volume with `NORTHSTAR_DB_PATH` pointing into it, or the ledger, positions and cursors are lost on every redeploy. **This is the highest-risk gap.** |
| 7 | **Process topology** | one process serves the console *or* runs the loop | Decide: a single process running both, or a worker (`paper`) plus an optional web service (`serve`) sharing the volume. Two processes on one SQLite file needs care — the scheduler's single-lock design assumes one writer. |
| 8 | **Secrets** | read from `.env` locally via `--env-file-if-exists` | Set as Railway environment variables. `.env` is not deployed. The four required: `X_BEARER_TOKEN`, `TIINGO_API_KEY`, `ALPACA_PAPER_KEY_ID`, `ALPACA_PAPER_SECRET_KEY`. |
| 9 | **Health endpoint** | `GET /api/health` exists and is suitable | Only reachable if the web process runs. A worker-only deployment has no healthcheck target. |
| 10 | **Universe snapshot delivery** | `NORTHSTAR_UNIVERSE_FILE` reads a local path | On Railway the file must live on the mounted volume, or the HTTP source must be implemented. Otherwise the deployment silently runs `BOT FALLBACK`. |
| 11 | **Restart recovery** | already implemented and tested | Depends entirely on gap 6. With an ephemeral filesystem, "restart recovery" recovers nothing. |
| 12 | **Log handling** | structured JSON to stdout/stderr | Fine as-is; Railway captures both. No change needed. |
| 13 | **Node version** | `engines.node >= 22.5.0`, uses `node:sqlite` | Railway's builder must select Node 22+. `node:sqlite` is unavailable on older runtimes and the app will not start. |

## Not gaps

- Structured logging, graceful `Scheduler.stop()`, `app.close()`, restart
  recovery logic, reconciliation and the kill switch are all implemented and
  tested; they need wiring and a volume, not new code.
- Zero runtime dependencies — no native build step, no install risk.

## Order of work, when deployment is authorised

1. Volume + `NORTHSTAR_DB_PATH` (gap 6) — nothing else matters without it.
2. `PORT` / `0.0.0.0` binding (gaps 3, 4).
3. `SIGTERM` (gap 5).
4. `start` script and process topology (gaps 1, 7).
5. Secrets (gap 8), then `railway.json` (gap 2).
6. Universe delivery (gap 10).
