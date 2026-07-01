# Theatrum

An interactive, **multiplayer, turn-based historical strategy map**. An admin ("Master")
paints province ownership and advances turns; players sign in with GitHub and move their
nation's armies and navies across a 4,596-province world map.

There is **no server and no database**. The Git repository *is* the database, pull requests
are the write API, and GitHub Actions is the rules/authorization engine. The frontend is a
static React app on GitHub Pages that reads game state live from `raw.githubusercontent.com`
and submits moves through a small Cloudflare Worker.

- **Stack:** React 18 · strict TypeScript · Vite · Leaflet 1.9 (map) · Cloudflare Workers (OAuth + submit proxy) · GitHub Actions (validation/merge) · GitHub Pages (hosting)
- **Live game data:** JSON files under `public/data/`, read at main's HEAD commit SHA
- **Auth:** GitHub App User-to-Server OAuth (tokens scoped to this one repo)

---

## Table of contents

- [How it works at a glance](#how-it-works-at-a-glance)
- [Architecture in detail](#architecture-in-detail)
  - [1. Frontend (React + Leaflet)](#1-frontend-react--leaflet)
  - [2. Authentication (GitHub App OAuth)](#2-authentication-github-app-oauth)
  - [3. Reading live game state](#3-reading-live-game-state)
  - [4. The write path: move → PR → validate → merge](#4-the-write-path-move--pr--validate--merge)
  - [5. The Cloudflare Worker](#5-the-cloudflare-worker)
  - [6. The CI validator (the security boundary)](#6-the-ci-validator-the-security-boundary)
  - [7. Game domain model](#7-game-domain-model)
  - [8. Data files reference](#8-data-files-reference)
  - [9. Schema versioning](#9-schema-versioning)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Deploying your own instance](#deploying-your-own-instance)
- [Operations & admin](#operations--admin)
- [Scripts reference](#scripts-reference)
- [Testing](#testing)

---

## How it works at a glance

```
                         ┌───────────────────────────────────────────────┐
                         │  Browser — static React app (GitHub Pages)     │
                         │  theatrum.kaungmyatthu.dev                     │
                         └───────────────────────────────────────────────┘
        read state             │                          │ submit move
   (SHA-pinned, public)        │                          │ (Bearer user token)
        ▼                      │                          ▼
┌──────────────────────┐       │            ┌──────────────────────────────┐
│ raw.githubusercontent│◄──────┘            │   Cloudflare Worker          │
│ /<repo>/<sha>/       │                    │   theatrum-oauth.*.dev       │
│   public/data/*.json │                    │  • OAuth code/refresh/revoke │
└──────────────────────┘                    │  • /submit → opens a PR      │
        ▲                                    └──────────────────────────────┘
        │ merge (main)                                    │ opens PR as GitHub App
        │                                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  GitHub repo  kgmyatthu/theatrum                                           │
│    pull_request_target → .github/workflows/validate-and-merge.yml         │
│      runs scripts/validate-move.mjs FROM base/ (trusted)                   │
│      valid  → gh pr merge --squash    invalid → gh pr comment (reason)     │
└──────────────────────────────────────────────────────────────────────────┘
```

Two independent flows:

1. **Read** — Every client fetches `state.json`, `turn.json`, and the per-nation
   `forces/<nation>.json` files directly from the public raw CDN, pinned to the latest
   `main` commit SHA. Clients poll every 30 minutes and pick up merged moves automatically.
2. **Write** — A signed-in player edits locally, hits *Finalize*, and the app POSTs a
   snapshot to the Worker. The Worker verifies the player's identity, enforces the game
   rules, commits the change to a branch, and opens a PR **as the GitHub App**. A
   `pull_request_target` workflow re-validates the PR from trusted (base-branch) code and
   auto-merges it, or comments the rejection reason.

Why the roundabout write path? A GitHub App user token is scoped to only this repo and
can't push branches to it, so the browser can *read* the public repo but can't *write*.
The Worker holds the App's installation credentials and does the writing, stamping the
player's verified GitHub login into the PR body so CI can trust who submitted it.

---

## Architecture in detail

### 1. Frontend (React + Leaflet)

A single-page app with **no Redux, router, or UI library** — the only heavy dependency is
Leaflet. State is a plain `useReducer` store; the map is driven imperatively through custom
hooks.

**Provider composition** (`src/main.tsx`), outermost → innermost:

```
React.StrictMode
 └─ AuthProvider          GitHub identity (status, login, role, nation)
     └─ AppProvider       useReducer game store (AppState)
         └─ ForceDraftProvider   ref-based bridge from the add-force form to map clicks
             └─ App
```

**State management** (`src/state/`)

- `AppContext.tsx` — `useReducer(reducer, initialState)`; exposes `useAppState()` / `useAppDispatch()`.
- `state.ts` — the `AppState` shape: loaded provinces (GeoJSON), cities, `owners`, `palette`,
  `forces`, turn fields (`currentDate`, `lastTurnDays`, `turnNumber`), `selectedFids`,
  layer visibility, `mode`, display settings, and pending admin edits
  (`pendingRenames`, `pendingUserAdds`, `pendingUserRemoves`).
- `actions.ts` / `reducer.ts` — every mutation is a typed `Action` in a discriminated union;
  the reducer's `switch` is exhaustiveness-checked with a `never` default, so adding an
  action without handling it is a compile error. Key actions: `BOOTSTRAP_DATA`,
  `APPLY_SNAPSHOT` (poll/import sync), `SET_OWNER`, `RENAME_COUNTRY`, `ADD_FORCE` /
  `MOVE_FORCE` (increments `kmMovedThisTurn`) / `UPDATE_FORCE` / `DELETE_FORCE`,
  `ADVANCE_TURN` (resets per-force turn tracking), and the perm-editing actions.

Province ownership on the 4,596-feature GeoJSON is **mutated in place** for performance
(the collection reference stays stable); a `provincesVersion` counter is bumped so derived
consumers (country labels) know to recompute.

**Map rendering** — the imperative↔declarative bridge. `MapView` owns the container `<div>`
and calls one hook per Leaflet concern. Each hook subscribes to `useAppState()`, holds its
Leaflet objects in refs, and re-syncs inside `useEffect`s:

| Hook | Owns |
| --- | --- |
| `useLeafletMap` | The single `L.Map` + Esri World Imagery satellite tiles |
| `useProvincesLayer` | Province polygons; restyles on owner/palette/opacity/selection/zoom |
| `useForcesLayer` | Force counter markers; drag-to-move with a live range circle sized to remaining budget |
| `useCitiesLayer` | Zoom-tiered city labels (all 7,342 visible at high zoom) |
| `useCountryLabelsLayer` | One label per connected landmass (union-find over shared vertices) |
| `useRulerTool` | Click-to-measure great-circle distances |
| `useAddForceClick` | Map click → `ADD_FORCE` when in add-force mode |
| `useDragSelect` | Shift+drag rectangle multi-select (admin only) |
| `useDataBootstrap` | Initial load: static GeoJSON/cities + live snapshot |
| `useStateRefresh` | 30-min poll; reconciles upstream changes, raises conflict/stale modals |

**Roles & modes.** `AuthContext` resolves each signed-in user to `admin`, `player`, or
`unregistered`. Gating happens in three layers and is re-checked server-side:

- **Admins** paint province ownership (right-click / drag-select), rename & recolor
  countries, manage players (`perm.json`), advance turns, and move any force.
- **Players** may only add and move forces of **their own nation**. The nation field in the
  add-force form is locked, and force markers are only draggable for their nation.
- **Unregistered** (signed in but not in `perm.json`) and **anonymous** users get a
  read-only map.

Modes (`view` / `add-force` / `ruler`) are chosen in the sidebar's `ModePanel`.

**Component tree.** `App` renders `Sidebar` + `MapView`. The sidebar stacks panels shown
by role: `AccountPanel` (sign-in + *Finalize changes*), `TurnPanel`, `ModePanel`,
`AddForcePanel`, admin-only `NewCountryPanel` / `EditCountryPanel` / `UsersPanel`,
`DisplayPanel`, `LayersPanel`, `PersistencePanel` (JSON/SVG import-export), `StatsPanel`.
Modals: `SubmitMoveModal` (the submit state machine), `ConflictModal`, `StaleClientModal`,
`AdvanceTurnModal`, `ForceModal`, `MobilizationConfirm`.

### 2. Authentication (GitHub App OAuth)

This is a **GitHub App** using the User-to-Server flow — *not* an OAuth App. The difference
matters: App user tokens (`ghu_*`) are scoped to only the repos the App is installed on
(just `theatrum`) with per-endpoint permissions, and expire after 8 hours. A leaked token
can touch nothing but this repo.

Flow (`src/auth/AuthContext.tsx`, `src/auth/session.ts`):

1. **Sign in** → redirect to `https://github.com/login/oauth/authorize` with the App's
   `client_id`, a `redirect_uri`, and a random CSRF `state` stored in `sessionStorage`.
2. **Return** → GitHub sends the user back with `?code=...&state=...`; the app strips these
   from the URL immediately (so a refresh can't replay), verifies `state`, and calls the Worker.
3. **Exchange** → the app POSTs `{ code }` to the Worker, which adds the `client_secret`
   server-side and exchanges it with GitHub for `{ access_token, refresh_token }`.
4. **Session** → stored in `localStorage['theatrum.gh_session']`. Access token lasts 8h;
   the refresh token (~6 months) **rotates on every use**. `authedFetch` refreshes
   proactively (within 60s of expiry) and reactively (on a 401, once), with concurrent
   refreshes coalesced so the one-shot refresh token isn't spent twice.
5. **Identity** → `GET /user` yields the verified `login`; the app reads `perm.json` at
   main's HEAD to map that login to `admin` / `player+nation` / unregistered.
6. **Sign out** → fire-and-forget revokes the grant at the Worker, then purges all
   `theatrum.*` keys.

### 3. Reading live game state

The frontend reads game data straight from the public raw CDN, but **pinned to an immutable
commit SHA** rather than the `main` branch ref (`src/utils/liveData.ts`).

Why: `raw.githubusercontent.com/<repo>/main/...` is served through Fastly with a 5-minute
cache, so a freshly merged move can be invisible for minutes, and query-string cache-busting
is unreliable there. Instead the app makes **one** call to `GET /repos/<repo>/commits/main`
to learn the latest SHA, then fetches `.../<sha>/public/data/<file>` — an immutable URL that
is always the freshly-committed bytes. The SHA is memoized for the page session
(`fetchLiveData`) or re-fetched to detect drift (`fetchLiveDataFresh`).

`fetchLiveSnapshot` (`src/utils/fetchSnapshot.ts`) reassembles the unified `AppSnapshot`:
it fetches `state.json` + `turn.json` in parallel, lists which nations actually have a force
file via **one** GitHub Contents-API call (`listForceNations`), then fetches only those
`forces/<nation>.json` files. This avoids 404-probing all 70+ countries when only ~16 have
forces. In local dev without a repo configured, it falls back to the bundled `/data/` files.

`useStateRefresh` polls every 30 minutes. If `main` changed and the user has no local edits,
it silently applies the new snapshot; if the user *does* have unsaved edits, it raises a
conflict modal (refresh-and-redo). If `main` declares a newer `appVersion` than the running
bundle, it raises a "stale client, refresh" modal instead.

### 4. The write path: move → PR → validate → merge

```
Finalize changes (AccountPanel)
  → SubmitMoveModal computes the local AppSnapshot + baseline (last-seen main)
  → POST <worker>/submit  { snapshot, baseline, description, renames?, userAdds?, userRemoves? }
                          Authorization: Bearer <user access token>
  → Worker verifies identity, enforces rules, commits to branch move/<login>-<ts>,
    opens PR "Move from @<login>" with a hidden <!-- theatrum-submitter: <login> --> marker
  → pull_request_target fires validate-and-merge.yml
  → valid  → squash-merge + delete branch
     invalid → bot comment "Move rejected by validator: <reason>"
  → SubmitMoveModal polls the PR (1s × up to ~2min); on merge it applies the fresh snapshot
    in place (no full reload) and re-syncs its baseline
```

Concurrent moves to the **same** nation are reconciled by a per-nation 3-way merge
(`rebaseForceFile`, keyed by force `id`) *before* the PR is opened, so two players editing
different forces of the same nation don't clobber each other. Concurrent moves to different
nations never touch the same file, so they merge cleanly.

### 5. The Cloudflare Worker

A single-file Worker (`worker/src/index.ts`) that is the app's only server-side component.
It exposes just two routes; OAuth actions are content-routed by JSON body key:

| Request | Action |
| --- | --- |
| `POST /` `{ code }` | Exchange OAuth code for tokens (adds `client_secret`) |
| `POST /` `{ refresh_token }` | Refresh tokens (`grant_type=refresh_token`) |
| `POST /` `{ revoke }` | Revoke the OAuth grant |
| `POST /submit` | Validate a move, commit it, open a PR |
| `OPTIONS` | CORS preflight |

The Worker imports the **same** movement/merge logic the CI validator uses
(`scripts/lib/movement.mjs`, `scripts/lib/rebase-forces.mjs`) so a bad move is rejected
before it ever burns a branch/PR/CI run. `/submit` in order: verifies the user token via
`/user`; gates on `appVersion === SCHEMA_VERSION`; obtains a GitHub App installation token
(RS256 App JWT → installation token, cached); reads `perm.json` to determine role (stripping
admin-only fields from non-admins); creates the branch; enforces the turn-field permission
gate and per-force movement budgets; commits `state.json` / `turn.json` / per-nation force
files (3-way merged when a baseline is present); and opens the PR.

**Worker secrets** (set via `wrangler secret put`): `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM),
`GITHUB_APP_INSTALLATION_ID`, `GITHUB_REPO` (`owner/name`), `ALLOWED_ORIGIN`
(your deployed app origin, for CORS). See [`worker/README.md`](worker/README.md) for the
deep dive.

### 6. The CI validator (the security boundary)

`.github/workflows/validate-and-merge.yml` runs on `pull_request_target`, filtered to the
data files. This is what makes the whole design safe:

- `pull_request_target` runs in the **base repo's trusted context** (with write tokens), but
  the validator is executed **from `base/` (main)**, never from the PR's head — a malicious
  PR can't ship an "always valid" validator.
- It checks out base and head separately, then runs `node base/scripts/validate-move.mjs`.
- The decision logic is a pure, dependency-free, heavily-tested module
  (`scripts/lib/validate-move-core.mjs`, `validateMove`). It checks, in order: git
  mergeability, schema version, force-shape invariants (`force.nation` must match the
  filename; IDs unique and string), that every force file maps to a real country, per-force
  movement budgets + a haversine anti-cheat check, the submitter's identity (from the
  `theatrum-submitter` marker, which must resolve to a `perm.json` entry), and authorization
  (admins pass the universal checks; **players may change only their own
  `forces/<nation>.json`** — any other changed file is rejected).
- `valid` → `gh pr merge --squash --delete-branch`. `invalid` → a bot comment the client
  parses for the rejection reason.

The merge deliberately does **not** trigger a redeploy — clients read state live, so a merged
data change is visible on their next refresh with no Pages rebuild.

### 7. Game domain model

Types live in `src/types/index.ts`.

**Force** — the central unit:

| Field | Meaning |
| --- | --- |
| `id` | `${login}-${epochMs}-${seq}`, minted client-side; self-namespacing so concurrent adds never collide |
| `nation` | Canonical lowercase country name; must match the force file it lives in |
| `branch` | `'army'` or `'navy'` |
| `name`, `commander` | Free text |
| `strength` | Troop count (army) or ship count (navy) |
| `lon`, `lat` | Current position |
| `turnStartLon/Lat` | Position at the last turn advance (server checks displacement ≤ distance moved) |
| `kmMovedThisTurn` | Cumulative path length this turn; reset to 0 on `ADVANCE_TURN` |
| `createdAtTurn?` | Turn the force was raised; movement-locked while it equals the current turn |

**Turns & movement budgets.** `turn.json` holds `currentDate`, `lastTurnDays`, `turnNumber`.
Advancing a turn (admin only) sets `lastTurnDays` to the number of in-game days elapsed and
resets every force's turn tracking. A force's budget per turn is:

```
budget = (army: 25 | navy: 200) km/day  ×  lastTurnDays
```

With the current `lastTurnDays = 30`: **armies 750 km/turn, navies 6,000 km/turn**. Forces
raised this turn can't move until next turn. These constants live once in
`scripts/lib/movement.mjs`, are re-exported to the client (`src/utils/movement.ts`), and are
enforced on **both** sides plus the CI validator.

**Ownership** is a flat `[fid, nation]` map, where `fid` is a province's array index in the
GeoJSON. All nation names inside app state are canonical lowercase (`normalizeNation`);
display uppercasing is done in CSS. Only admins may change ownership.

### 8. Data files reference

Everything under `public/data/`. Factory/static files are bundled into the deploy; live
files are read from the raw CDN at runtime.

| File | Role | Shape |
| --- | --- | --- |
| `state.json` | **Live** — ownership + country registry | `{ appVersion, ownerships: [fid, nation][], countries: {name,color}[] }` (4,596 ownership pairs) |
| `turn.json` | **Live** — turn clock | `{ appVersion, currentDate, lastTurnDays, turnNumber }` |
| `perm.json` | **Live** — permissions (admin-editable) | `{ "<login>": {role:"admin"} \| {role:"player", nation:"..."} }` |
| `forces/<nation>.json` | **Live** — per-nation forces | `Force[]` (one file per nation that has ≥1 force) |
| `provinces.geojson` | Static — the map | `FeatureCollection` of 4,596 features (`province_name`, `modern_country`, `owner`) |
| `cities.json` | Static — labels | 7,342 `{ NAME, SCALERANK, lon, lat }` |
| `owners.json`, `palette.json` | Bake inputs | Country name list + name→hex map |
| `seed_forces.json` | Bake input | Starting forces (currently `[]`; forces accrue through play) |

`state.json` / `turn.json` / `forces/` are split so an admin's turn advance and a player's
force move never contend on the same file. `_fid` is **not** stored in the GeoJSON — it's the
runtime array index — and `state.json` is the source of truth for lowercase ownership.

### 9. Schema versioning

`SCHEMA_VERSION` (currently `theatrum/v9`) is the on-disk contract for the data files. It is
**triple-sourced and must stay in sync**:

- `src/utils/schema.ts` (client)
- `worker/src/index.ts` (Worker submit gate)
- `scripts/lib/validate-move-core.mjs` (CI validator)

Bump all three together on any non-round-trippable change. Bumping one without the others
bricks submits (Worker 400) or merges (CI reject). Clients running an older bundle detect a
newer `appVersion` on `main` and prompt the user to refresh.

Past migrations (one-shot, in `scripts/`): v6→v7 split the monolithic `forces` array into
per-nation files; a force-ID migration moved to deterministic IDs; the 1680 migration reset
the world's ownership baseline. Turn/movement tracking and the `turn.json` split brought v8→v9.

---

## Repository layout

```
src/
├── main.tsx                 Entry — provider composition
├── types/index.ts           Domain types (Province, Force, Country, AppSnapshot…)
├── state/                   useReducer store (AppContext, reducer, actions, state)
├── auth/                    GitHub OAuth: AuthContext, session, submitMove, githubApi
├── hooks/                   Map layer hooks + useDataBootstrap + useStateRefresh
├── utils/                   liveData (SHA pinning), fetchSnapshot, snapshot, movement, schema, geometry
├── components/              App, sidebar/, map/, modals/, ui/
└── index.css                Design tokens + resets

public/data/                 Game state (live) + map/factory data (static)
scripts/                     bake-state, validate-move, migrations, and lib/ (shared logic) + test/
worker/                      Cloudflare Worker (OAuth + /submit proxy)
.github/workflows/           deploy.yml (Pages), validate-and-merge.yml (moves), test.yml
```

---

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
npm run lint       # tsc --noEmit (type-check only)
npm run build      # tsc && vite build → dist/
npm run preview    # serve the production build
npm test           # node --test scripts/test/  (validator + movement + merge suites)
```

Copy `.env.example` to `.env.local` and fill in the three client vars:

```
VITE_GITHUB_CLIENT_ID=<your GitHub App's Client ID>
VITE_OAUTH_WORKER_URL=https://<your-worker>.workers.dev
VITE_GITHUB_REPO=<owner>/<repo>
```

- With `VITE_GITHUB_REPO` **set**, even local dev reads live state from the raw CDN and can
  submit real moves against that repo.
- With it **unset**, the app reads the bundled `public/data/` files and sign-in/submit are
  disabled — useful for offline UI work.

These `VITE_*` values are public (they're inlined into the client bundle at build time);
the sensitive secrets all live in the Worker.

> **Do not set a Vite `base` path.** The site is served from a custom domain (via CNAME),
> not a `/repo/` subpath, so `base` correctly defaults to `/`.

---

## Deploying your own instance

You need: a GitHub repo (fork of this one), a Cloudflare account (Workers), and Node 20+
(CI uses Node 22). A custom domain is optional but assumed below.

### 1. Register a GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**
(https://github.com/settings/apps/new):

- **Homepage / Callback URL:** your app origin, e.g. `https://theatrum.example.dev/`
- ✅ **Request user authorization (OAuth) during installation**
- ✅ **Expire user authorization tokens** (8-hour tokens)
- ❌ **Webhook → Active** (unchecked — unused)
- **Repository permissions:** Contents → Read & write · Pull requests → Read & write ·
  Metadata → Read-only
- **Where can this app be installed?** → Only on this account

Create it, then record the **App ID** and **Client ID** (`Iv23…` for a GitHub App), generate
a **Client secret**, and generate a **private key** (downloads a PKCS#1 `.pem`).

### 2. Install the App on your repo

App settings → **Install App** → your account → **Only select repositories** → pick your
`theatrum` repo. The **Installation ID** is the number in the resulting URL
(`.../settings/installations/<INSTALLATION_ID>`).

### 3. Deploy the Cloudflare Worker

The Worker needs the private key as **PKCS#8**. Convert the downloaded key if needed:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out key.pk8.pem
```

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID           # App Client ID
npx wrangler secret put GITHUB_CLIENT_SECRET       # App Client secret
npx wrangler secret put GITHUB_APP_ID              # App ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY     # paste the PKCS#8 PEM
npx wrangler secret put GITHUB_APP_INSTALLATION_ID # from step 2
npx wrangler secret put GITHUB_REPO                # owner/repo
npx wrangler secret put ALLOWED_ORIGIN             # https://theatrum.example.dev
npx wrangler deploy
```

Note the deployed Worker URL (`https://theatrum-oauth.<subdomain>.workers.dev`).

### 4. Configure GitHub Actions & Pages

In the repo, **Settings → Secrets and variables → Actions**, add the three build-time vars:

```
VITE_GITHUB_CLIENT_ID = <App Client ID>
VITE_OAUTH_WORKER_URL = https://theatrum-oauth.<subdomain>.workers.dev
VITE_GITHUB_REPO      = <owner>/<repo>
```

The `deploy.yml` workflow publishes the built site to the `gh-pages` branch. In **Settings →
Pages**, set the source to the `gh-pages` branch. For a custom domain, update the `cname:`
field in `.github/workflows/deploy.yml` (it currently reads `theatrum.kaungmyatthu.dev`) and
point a DNS `CNAME` record at your Pages site.

Pushing to `main` (anything except `state.json`/`perm.json`-only changes) runs the deploy
workflow: `npm ci` → `npm run build` (with the `VITE_*` secrets injected) → publish `dist/`.

### 5. Seed the game world

The repo already ships baked game data. To reset or reseed a world, edit the bake inputs
(`public/data/owners.json`, `palette.json`, `seed_forces.json`, and the `owner` property in
`provinces.geojson`) and run:

```bash
node scripts/bake-state.mjs   # regenerates state.json, turn.json, forces/<nation>.json
```

Commit the results to `main`.

### 6. Set up permissions

Edit `public/data/perm.json` to add yourself as an admin and register players:

```json
{
  "your-github-login":   { "role": "admin" },
  "some-player-login":   { "role": "player", "nation": "france" }
}
```

Nations must be canonical lowercase and exist in `state.json.countries`. Once deployed,
admins can manage players in-app via the **Players (Admin)** panel, which stages `perm.json`
edits into the next submit.

---

## Operations & admin

- **Advancing a turn:** admins use the Turn panel → *Advance Turn*, pick a forward date, and
  *Finalize*. `lastTurnDays` becomes the elapsed days and sets everyone's next-turn budget.
- **Painting ownership:** right-click a province (or shift+drag to multi-select) → choose a
  country. Renames/recolors cascade to provinces, forces, and the palette.
- **A move was rejected:** the validator's reason is posted as a bot comment on the PR and
  shown in the submit modal. Common causes: exceeded movement budget, moved a force raised
  this turn, stale client (schema mismatch), or `main` advanced under you (refresh & redo).
- **Rotating the App private key or client secret:** update the corresponding Worker secret
  (`wrangler secret put …`) and redeploy; no frontend change needed.

## Scripts reference

| Script | Purpose |
| --- | --- |
| `scripts/bake-state.mjs` | Build initial `state.json` + `turn.json` + `forces/*` from `owners`/`palette`/`seed_forces` and the GeoJSON |
| `scripts/validate-move.mjs` | CI entry point — reads base/head checkouts, resolves PR mergeability, delegates to `validate-move-core.mjs` |
| `scripts/lib/validate-move-core.mjs` | Pure move-validation rules (the security boundary) |
| `scripts/lib/rebase-forces.mjs` | Per-nation 3-way merge for concurrent force edits |
| `scripts/lib/movement.mjs` | Movement constants + budget/distance helpers (shared by client, Worker, validator) |
| `scripts/clean-topology.mjs` | One-shot GIS cleanup of `provinces.geojson` (sews hairline gaps via mapshaper) |
| `scripts/migrate-*.mjs` | One-shot historical migrations (v6→v7 split, force IDs, 1680 baseline) |

## Testing

`npm test` runs `node --test scripts/test/` — no framework, just the Node test runner:

- `movement.test.mjs` — budget/distance math
- `validate-move.test.mjs` — ~50 **adversarial** fixtures against `validateMove` (nation
  impersonation, cross-file writes, budget/displacement cheats, forged submitter markers, …)
- `rebase-forces.test.mjs` — every concurrent-edit merge scenario

`test.yml` runs these on any push/PR touching `scripts/`, so weakening the validator fails CI
immediately.
