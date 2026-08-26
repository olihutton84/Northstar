# Deploying the X Trading Bot to Railway

**Nothing is deployed.** This describes how to deploy it, and what the code now
does on your behalf. Deployment itself is a deliberate act and has not been
performed.

Railway deployment is owned by this repository (see CLAUDE.md).

---

## 1. The one thing that will bite you

Railway's container filesystem is **ephemeral**. Every guarantee this bot makes
— the $50 ledger, open positions, polling cursors, restart recovery — lives in
one SQLite file. Without a volume, that file is destroyed on every redeploy,
and the bot looks perfectly healthy the whole time. Restart recovery is
thoroughly tested and completely useless against it, because there is nothing
left to recover.

So, before anything else:

1. Attach a **volume** to the service, mounted at `/data`.
2. Set `NORTHSTAR_DB_PATH=/data/northstar.sqlite`.

The bot now checks this itself and says so plainly. Get it wrong and the startup
banner reads:

```
  Database           /app/data/northstar.sqlite  LIKELY EPHEMERAL
    The database is at /app/data/northstar.sqlite, which is inside the container
    image rather than on a mounted volume. If that is right, the ledger, open
    positions and polling cursors are DESTROYED on every redeploy and restart
    recovery has nothing to recover.
    Fix: Attach a volume and point NORTHSTAR_DB_PATH at it, ...
```

`npm run readiness` carries the same finding as the `storage-durable` check. It
is a **WARN**, not a FAIL, because the container cannot prove its own filesystem
is ephemeral — and a false FAIL on a correctly mounted volume would train you to
ignore the check that matters most.

---

## 2. Environment variables

Four secrets, set in Railway's service variables. They are never written to the
database, never logged and never returned by the API.

| Variable | |
|---|---|
| `X_BEARER_TOKEN` | X API v2 |
| `TIINGO_API_KEY` | prices |
| `ALPACA_PAPER_KEY_ID` | broker |
| `ALPACA_PAPER_SECRET_KEY` | broker |

Plus:

| Variable | Value | Why |
|---|---|---|
| `NORTHSTAR_DB_PATH` | `/data/northstar.sqlite` | §1. Non-negotiable. |
| `NORTHSTAR_APPROVER_ID` | your identity | recorded against approvals |
| `NORTHSTAR_LIVE_TRADING_ENABLED` | leave unset | this release is PAPER only |

Do **not** set `PORT` or `NORTHSTAR_HOST` — Railway injects `PORT`, and the bot
derives the bind address from it. `.env` is not deployed; `--env-file-if-exists`
simply finds no file and reads the real environment instead.

Setting only half a credential pair is a hard startup error, not a silent
fallback to fixtures. That is deliberate: a bot quietly trading fixture data
against a real broker account is worse than a bot that refuses to start.

---

## 3. What the code now does

| | |
|---|---|
| **Entrypoint** | `npm start` → `northstar run`, the deployable process. |
| **Port** | `NORTHSTAR_PORT` if set, else Railway's injected `PORT`, else `3737`. |
| **Bind address** | `0.0.0.0` when `PORT` is injected, `127.0.0.1` locally. A health check cannot reach loopback from outside the container; a developer's laptop should not put the kill switch on the local network. `NORTHSTAR_HOST` overrides both. |
| **Health check** | `GET /api/health`, wired as `healthcheckPath` in `railway.json`. |
| **SIGTERM** | Handled. The scheduler stops accepting work, the in-flight task finishes, the console closes, the day's report is written, and the process exits **0** — a deliberate stop must not read as a crash, or the restart policy turns a clean shutdown into a restart loop. A second signal exits immediately. |
| **Shutdown grace** | 25s, then it exits anyway rather than being killed mid-task by the platform. |
| **Node version** | `nixpacks.toml` pins `nodejs_22`. `node:sqlite` does not exist before Node 22, and an older runtime fails at import rather than at build. |
| **Replicas** | `numReplicas: 1`, load-bearing. See §4. |

### The `run` command

`northstar run` serves the console **and** runs the trading loops in one
process. `NORTHSTAR_RUNNER_ENABLED=false` leaves the console read-only over
existing state, for inspecting a deployment without it acting.

---

## 4. Why one process, and why one replica

The obvious topology is a worker plus a web service. It is wrong here.

The scheduler's single-lock design assumes exactly one writer to the SQLite
file, and the console has POST routes (kill switch, resume, approvals) that
write. Splitting them puts **two writers on one file**, and the ledger,
reservations and position bookkeeping are not safe against that. The same
argument forbids a second replica.

`numReplicas: 1` in `railway.json` is not a cost decision. Raising it corrupts
state.

---

## 5. Universe delivery

Absent a snapshot, the bot runs its own fallback list, labelled `BOT FALLBACK`
in the banner, on the console and in the session record. It never presents that
as live Platform membership.

To supply real Platform membership, put the snapshot on the volume and set
`NORTHSTAR_UNIVERSE_FILE=/data/universe.json`. See `docs/PLATFORM_INTEGRATION.md`
for the payload. An HTTP source is a matter of writing one more `UniverseSource`;
nothing in the deployment presumes a file.

A malformed snapshot is rejected whole, never partially ingested, and the reason
appears in the banner and the session record.

---

## 6. Deployment order

1. Create the service from this repo.
2. **Attach the volume at `/data`** and set `NORTHSTAR_DB_PATH`. Nothing else
   matters without it.
3. Set the four secrets and `NORTHSTAR_APPROVER_ID`.
4. Deploy. `railway.json` supplies build, start, health check and restart policy.
5. Read the startup banner. Confirm: providers are `LIVE` / `TIINGO` /
   `ALPACA_PAPER`, mode is `PAPER`, database is not `LIKELY EPHEMERAL`.
6. Open the console and run readiness. `readyForRealDataPaper` must be true.

## 7. After a deploy

- Logs are structured JSON on stdout/stderr; Railway captures both. No change
  needed.
- Restart recovery runs on start and reconciles against Alpaca. It only works
  if step 2 was done.
- The kill switch is at `POST /api/kill` on the console, and `northstar kill`
  from a Railway shell.
