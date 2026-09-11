# AGENT.md

Orientation for anyone — human or agent — working on Hermit. For how to *use*
the tool, see [README.md](README.md).

## What this application is for

Hermit is a git commit management console. A product often ships as several
repositories released together, each cutting a `release/<version>` branch. The
question that comes up before every release is:

> What is in 1.2.3 that was not in 1.2.2 — across all the repos — and does
> that match what Jira says is in the release?

Answering it by hand means opening each repo's branch comparison in its own web
UI, reading commit lists, and reconciling them against the Jira release report
by eye. Hermit does that in one screen, and across providers — some repos on
Azure DevOps, some on GitHub, compared together.

The secondary job is **moving commits between branches** (the cherry-pick page):
comparing two refs and selectively applying commits from one to the other, which
happens when a fix needs to reach both a release branch and `dev`.

It is a **local, single-user tool**. There is no authentication, no multi-user
state, and it binds to `127.0.0.1`. Credentials come from the developer's own
`~/.authinfo`. Do not add features that assume a shared deployment.

## Design decisions worth knowing

**Why there is a server at all.** The original brief asked for a pure web app.
Three requirements make that impossible: reading `~/.authinfo` (browsers cannot
touch the filesystem), calling the Azure DevOps REST API (it does not send CORS
headers for PAT-authenticated requests), and a file-backed cache. So there is a
thin Node backend. It exists to do the things a browser cannot, and holds as
little logic as it can get away with.

**One process in production, two in dev.** `make up` builds the SPA and serves
it from the same Express process as the API — same origin, no CORS config, and
one PID for `make down` to manage. `make dev` splits them so Vite can do hot
reload, and proxies `/api` to the backend. Both modes are backgrounded and both
are stopped by the same `make down`.

**No fixed ports.** The server listens on port `0`, letting the OS assign a free
one, then prints `READY <url>`. The start script reads that line to learn the
port. This was an explicit requirement — never hard-code a port anywhere.

**Writes are opt-in.** Repository operations are read-only except the cherry-pick
endpoint, which is gated behind `settings.allowCherryPickWrites` (default
`false`) and only ever creates a *new topic branch*. Keep that shape: a tool
that reads someone's repos is safe to run; one that writes to release branches is
not.

The **Time logger** (below) is the one deliberate exception, and it is a
different kind of write: it changes only the signed-in user's own Jira worklogs,
one ticket and one day at a time, on an explicit click. It never touches anyone
else's time or any repository.

## Layout

```
Makefile               Entry point for a source checkout; see targets in README
vite.config.mjs        Vite config; root is web/, proxies /api in dev
package.json           Publishes the installable package; prepack builds the UI
bin/hermit.mjs         Installed CLI: starts the server, opens a browser, Ctrl-C stops
install.sh             macOS/Linux one-line installer (bootstraps Node if needed)
install.ps1            Windows one-line installer

scripts/
  runtime.mjs          Shared paths, PID file read/write, liveness checks
  start.mjs            Spawns detached processes, waits for their port
  stop.mjs             SIGTERM then SIGKILL, cleans up PID files
  status.mjs           Reports PIDs, URL, and a live health check

server/
  index.mjs            Express app, static SPA, error handler; exports start()
  plugins/
    index.mjs          Registry: discovers plugin folders, routes URLs to them
    azure-devops/      Azure DevOps provider
    github/            GitHub provider
  lib/
    authinfo.mjs       netrc parser for ~/.authinfo; credential lookup
    http.mjs           Shared JSON fetch, auth, rate limits, mapLimit
    provider-error.mjs ProviderError: message + status + hint
    jira.mjs           Jira Cloud REST client
    db.mjs             lowdb store: repos + settings; per-user dir when installed
    cache.mjs          Read-through TTL cache on a JSON file
    repos.mjs          CRUD over the repo list; legacy record migration
    versions.mjs       Version parsing, sorting, cross-repo collation
    git-service.mjs    Orchestration: fan out across repos, cache, shape output
    time-logger.mjs    Jira worklog reads/writes for the Time logger page
  routes/
    repos.mjs          /api/repos
    git.mjs            /api/git
    jira.mjs           /api/jira
    time-logger.mjs    /api/time-logger
    system.mjs         /api/health, /auth, /settings, /cache

web/
  index.html
  src/
    main.js            App bootstrap
    App.vue            Shell: nav drawer, app bar, credential chips, snackbar
    router.js          Routes; `meta.nav` drives the sidebar
    api.js             Typed-ish wrapper around fetch for every endpoint
    plugins/vuetify.js Theme and component defaults
    styles.css         The few global classes Vuetify does not cover
    composables/
      useToast.js      Shared snackbar
      useFormat.js     Dates, commit message parsing, issue key extraction
    components/
      CommitRow.vue    One commit; used by both compare pages
      EmptyHint.vue    Empty state with an optional call to action
      TimeLoggerDayCard.vue  One day of the time-logger report, with edit rows
    pages/
      ReleasesPage.vue     Cross-repo release comparison + Jira cross-check
      CherryPickPage.vue   Two-ref comparison with commit staging
      TimeLoggerPage.vue   Date range of logged worklogs, editable in place
      RepositoriesPage.vue Repo CRUD
      SettingsPage.vue     Settings, credential status, cache controls
```

## Packaging and installing

The same source ships two ways.

- **npm.** `package.json` declares a `bin` (`hermit`) and a `files` allowlist;
  `prepack` runs `vite build`, so the published tarball always carries a fresh
  `web/dist` (which is gitignored but explicitly listed in `files`). Users get
  `npx hermit-console` or `npm install -g hermit-console`. Maintainers publish
  with `make publish` (`scripts/publish-npm.mjs`), which reads the `npmjs.com`
  token from `~/.authinfo` — npm does not read that file — into a throwaway
  `.npmrc`, checks `npm whoami`, lists the last three published versions and
  prompts for the new one (suggesting the next patch). It validates the version,
  commits the bump as `Release vX.Y.Z`, and reverts it if the publish fails.
  `npm run set-npm-token` (`scripts/set-npm-token.mjs`) stores a token the same
  way, reading it from stdin so it is never echoed, and verifying it before
  anything is written.
- **One-line installers.** `install.sh` / `install.ps1` install the published
  npm package under `~/.hermit` (override `HERMIT_HOME`; `HERMIT_TARBALL` swaps
  in a specific tarball such as the `hermit.tgz` release asset), downloading a
  private Node runtime only when the machine lacks one. They write the `hermit`
  launcher by hand rather than using npm's shim, because the shim is
  `#!/usr/bin/env node` and the private runtime is not on PATH. The release
  workflow (`.github/workflows/release.yml`) runs on a `v*` tag, packs
  `hermit.tgz` and attaches it to the GitHub release.

`server/index.mjs` exports `start()`. `make up` runs the file directly and
watches stdout for `READY`; `bin/hermit.mjs` imports `start()` so it can open a
browser and own the shutdown signals.

**Data location.** `lib/db.mjs` keeps using a checkout's `data/` when it already
exists, so a clone is unchanged. An installed package has no `data/`, so it uses
the per-user directory — `~/Library/Application Support/Hermit` on macOS,
`%APPDATA%\Hermit` on Windows, or `$XDG_DATA_HOME/hermit` on Linux. Override
either with `HERMIT_DATA_DIR`.

## Request flow

A release comparison, end to end:

```
ReleasesPage.vue
  → api.compare({ base, target, repoIds })
  → POST /api/git/compare                    routes/git.mjs
  → compareAcrossRepos()                     lib/git-service.mjs
      ├─ enabledRepos()                      lib/repos.mjs   (lowdb)
      ├─ pluginForRepo(repo)                 plugins/index.mjs
      ├─ per repo: plugin.listBranches()                     (cached 2 min)
      ├─ skip repos missing either branch
      └─ per repo: plugin.listCommitsBetween()               (cached by SHA)
                   plugin.diffCounts()
                   plugin.pullRequestsForCommits()
  → results[] shaped with web URLs for every commit and branch
```

`git-service.mjs` is where fan-out, caching, and error tolerance live. Route
handlers stay thin: validate input, call a service, return JSON. Plugins know
how to talk to one provider and nothing about repos, settings, or caching —
and `git-service.mjs` never names a provider.

**Per-repo failures never fail the whole request.** One repo with a bad
credential returns `{status: 'error', message, hint}` in its slot while the rest
compare normally. The UI renders those under "Not compared". Preserve this.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness; used by `make status` |
| GET | `/api/auth` | Which hosts have credentials (never the secrets). `?refresh=1` re-reads the file |
| GET/PUT | `/api/settings` | Read and merge settings |
| GET/DELETE | `/api/cache` | Cache stats; clear all or by `?prefix=` |
| GET | `/api/repos` | List configured repos |
| GET | `/api/repos/providers` | Installed provider plugins, capabilities and credential requirements |
| POST | `/api/repos/probe` | Detect the provider from a URL and confirm the repo is readable |
| POST | `/api/repos` | Add |
| PUT | `/api/repos/:id` | Update |
| DELETE | `/api/repos/:id` | Remove |
| GET | `/api/git/releases` | Branch coverage across all repos, collated by version |
| POST | `/api/git/compare` | Cross-repo comparison of two release branches |
| POST | `/api/git/compare-refs` | Two arbitrary refs in one repo, both directions |
| GET | `/api/git/repos/:id/branches` | Branch list for one repo |
| POST | `/api/git/cherry-pick` | Apply commits to a new topic branch. Gated, and provider must support it |
| POST | `/api/jira/version` | Issues in a fixVersion, from a release URL or id |
| GET | `/api/jira/versions` | Fix Versions defined on the project, for the picker |
| GET/POST | `/api/jira/releases` | Pinned Fix Versions |
| DELETE | `/api/jira/releases/:id` | Unpin one |
| GET | `/api/jira/releases/:id/issues` | Tickets carrying that Fix Version |
| POST | `/api/jira/issues` | Resolve issue keys found in commit messages |
| GET | `/api/time-logger/context` | Signed-in user, site, project, hours/day and today |
| GET | `/api/time-logger/range` | Logged time per day in an inclusive `?from=&to=` range |
| POST | `/api/time-logger/worklog` | Add hours on top of what is logged (insert) |
| PUT | `/api/time-logger/worklog` | Set a ticket's day total exactly (0 deletes) |

Errors are `{ error, hint }` with a meaningful status. `hint` is a longer,
multi-line remedy shown in the UI — use it for anything the user can fix, such
as a missing credential.

## Gotchas

### Azure: range parameters are backwards

In `GET /_apis/git/repositories/{id}/commits`, `itemVersion` is the **base** of
the range and `compareVersion` is the **head**. Passing them the way the names
suggest returns **zero commits with a 200** — no error, just an empty list that
looks like "no changes".

```js
// commits in target that are not in base
'searchCriteria.itemVersion.version': base,      // yes, base
'searchCriteria.compareVersion.version': target  // yes, target
```

Verified against a real `release/1.2.2..release/1.2.3` pair, whose result matches
`diffCounts().ahead`. If a comparison ever returns 0 unexpectedly, check this
first. See `plugins/azure-devops/index.mjs`.

### Azure: mapping commits to their source branch needs two PR queries

`pullRequestsForCommits()` in `plugins/azure-devops/` posts to
`/_apis/git/repositories/{id}/pullrequestquery`
with **two** query types, because they return different things:

- `lastMergeCommit` — matches the merge commit a PR produced
- `commit` — matches the individual commits a PR carried

A squashed PR appears under the first, its constituent commits under the second.
Running only one type silently misses roughly half the commits. Against
a real `release/1.2.2..release/1.2.3` pair the two types matched 4 and 6 of 10 commits
respectively; together they cover all 10.

A commit can belong to more than one PR (typically one into `develop` and one
into the release). `attachPullRequests()` in `git-service.mjs` sorts them so a
PR targeting the branch being compared wins, then the most recent — otherwise a
commit shows the wrong provenance.

PR metadata is an enhancement, not a requirement: if the token cannot read pull
requests the query returns an empty map and the comparison still works.

### Azure: a bad PAT does not produce a 401

Azure DevOps serves its HTML sign-in page, often with a 200 or 203.
`lib/http.mjs` detects a non-JSON content type and converts it into a 401 with
a useful hint. Every provider call must go through `requestJson()` to inherit it.

### GitHub: no cherry-pick, and a 60/hour anonymous ceiling

GitHub has no cherry-pick endpoint, so the plugin declares `cherryPick: false`
and the UI falls back to git commands. Do not fake it with the low-level
git-data API without saying so plainly in the UI.

A token is optional — public repositories are readable without one, at 60
requests an hour. That ceiling shapes `pullRequestsForCommits`, which otherwise
needs one request per commit. It reads source branches out of merge commit
subjects first (`Merge pull request #12 from owner/branch`, free) and only calls
the API when a credential exists; spending the anonymous budget on branch labels
would break the comparison itself. Squash merges leave only `(#123)`, which
gives the number but no branch — recorded anyway so the PR link works.

### Detached children and the event loop

`scripts/start.mjs` passes a log file descriptor straight to the child. Piping
the child's stdout through the parent instead keeps the parent's event loop
alive, and `make up` never returns to the shell. This was a real bug; do not
"simplify" it back to `stdio: 'pipe'`.

### Logs are appended across runs

`waitForLine()` records the log file size before spawning and only scans from
that offset. Without it, a startup can match a `READY` line from a previous run
and report the wrong port. Also strips ANSI codes first — Vite's banner renders
as `Local\x1b[22m:`, so a naive search for `Local:` finds nothing.

### Jira: Fix Versions are matched by name, and names need JQL quoting

Releases are pinned by **name**, not numeric id — the name is what a user reads
off a ticket, so a version can be pinned before anyone looks up its id. Real
names like `My Project 1.2.3 (Next Release)` contain spaces and parentheses, so
`jqlString()` in `lib/jira.mjs` wraps them in double quotes and escapes any
embedded quote or backslash. An unquoted name is rejected as malformed JQL.

Matching is literal: a typo yields zero tickets rather than an error, which the
page states plainly instead of showing an empty table.

### Vuetify: v-combobox returns an object when you pick, a string when you type

`v-combobox` defaults to `returnObject`, so selecting a suggestion sets the
model to the whole item (`{title, value, props}`) while free-typed text sets a
plain string. Code that assumes a string — `newVersion.value.trim()` — throws
inside the click handler, and the button appears to do nothing at all. The
`versionName` computed in `JiraReleasesPage` normalises both shapes; use it
rather than reading the model directly.

### Vuetify: a custom `#item` slot on v-combobox renders nothing

`JiraReleasesPage` needed subtitles on the Fix Version suggestions. The obvious
`<template #item="{ props, item }">` silently produced **zero** options — the
data was there (53 suggestions) but no list item rendered, and no error was
thrown. Subtitles go on each item's own `props` key instead, which Vuetify
applies to the rendered `v-list-item`. Do not reintroduce the slot.

### Not every release branch is semver

Real branches include `release/2025-05-02` and `release/PROJ-96-file-upload`.
`versions.mjs` sorts semver first and keeps the rest visible rather than
dropping them, and "previous release" only steps through semver versions.
Do not assume `x.y.z` when touching that file.

## Caching model

`lib/cache.mjs` is a read-through cache over a single JSON file.

| Key shape | TTL | Why |
| --- | --- | --- |
| `refs:<repoId>` | 2 min | Branch tips move |
| `range:v3:<repoId>:<baseSha>..<targetSha>` | 30 days | Keyed by content, cannot go stale |
| `pair:v3:<repoId>:<base>..<target>` | 2 min | Keyed by branch name, so it can |
| `jira:version:<host>:<id>` | 10 min | Issue status changes during a release |
| `jira:issues:<host>:<keys>` | 10 min | Same |

The `range:` design is the important one: because the key contains both tip
SHAs, a push produces a different key and the old entry is simply never read
again. That is what makes a 30-day TTL safe. Any new cached call should prefer
content-addressed keys over time-based expiry.

The `v3` in those keys is a shape version. Cached commits now carry pull-request
metadata; bumping the prefix retires the old shape rather than serving it to
code that expects the new one. Bump it again if the cached shape changes.

**Issue keys are derived after the cache is read, not before.** `withIssueKeys()`
runs over cached commits using the pattern currently in Settings, so editing the
pattern takes effect immediately instead of needing the cache cleared. Keys come
from the commit message, the source branch name and the PR title combined.

## Time logger

The **Time logger** page is the standalone `jira-tickets` app merged into
Hermit: its date range, per-day worklog table and insert/update/delete actions
now run inside this server and this SPA. The original Python (`list_hours.py`
+ `server.py`) is gone; `server/lib/time-logger.mjs` is the port, and it
reads `~/.authinfo` through `lib/authinfo.mjs` instead of shelling out to
`curl`.

Only the web UI was ported. The old CLI's activity scan, bulk-edit detection and
monthly text report were never reachable from the browser and are not here; the
page only ever needs issues that already carry the user's time.

Config lives in Settings under **Time logger**. A fresh install has no
organisation baked in: a blank site or project falls back to the shared
`jiraBaseUrl` / `jiraProjectKey`, so one configuration is enough, and with
neither set the page shows a setup prompt instead of querying Jira.

| Setting | Default | Purpose |
| --- | --- | --- |
| `timeLoggerSite` | *(none)* | Site whose worklogs are read and written; blank uses `jiraBaseUrl` |
| `timeLoggerProject` | *(none)* | Project scanned for the logged time; blank uses `jiraProjectKey` |
| `timeLoggerHoursPerDay` | `8` | Working day for capacity and shortfall; `0` follows Jira |
| `timeLoggerDefaultLogTime` | `09:00` | `started` time of day for a new worklog |

**The writes are scoped, and that is the whole safety story.** `setDayTotal()`
reads the ticket's worklogs, keeps the caller's own entries for the requested
day, updates the oldest in place (preserving its time of day and, unless a new
comment is supplied, its comment) and deletes any others of the caller's that
day. A colleague's worklog on the same ticket and day is invisible to the filter
and never touched, as is the caller's own time on any other day. `hours=0`
deletes only those same entries. Keep the account and day filters in place when
changing this code.

The context (`/myself` + `/configuration`) costs two Jira calls, so
`loadSite()` caches it for five minutes; a range is fetched fresh every time
because a write can change it.

Each worklog in a range report carries its comment, flattened from Jira v3's
ADF by `commentText()` (the raw ADF is still what an update re-sends). A row
with a comment — or more than one worklog — expands in place to show each
entry's time and comment.

## Conventions

**Backend.** ESM throughout (`.mjs`). No TypeScript, no build step for the
server. Node's built-in `fetch`. Errors carry `.status` and optionally `.hint`;
the error middleware in `index.mjs` turns them into JSON.

**Frontend.** Vue 3 `<script setup>`, Vuetify 4, no state library — pages own
their state and `api.js` is the only place that calls `fetch`. Component
defaults live in `plugins/vuetify.js`, so prefer setting a default there over
repeating props. Colours come from the theme; do not hard-code hex values in
components.

**Date rendering.** `useFormat.js` holds the display timezone in a module-level
`ref`, so changing it in Settings re-renders every date on screen without a
reload — the format helpers read the ref during render, so Vue tracks them.
Format dates through those helpers rather than calling `toLocaleString`
directly, or the setting will not apply. Two traps live there:

- `dateStamp` assembles the date from `Intl.formatToParts`, never from
  `getDate()` or by slicing the ISO string. Both ignore the configured zone,
  and slicing additionally gets the day wrong for commits made late in the UTC
  day.
- `Intl.supportedValuesOf('timeZone')` returns canonical zones only and omits
  `UTC`, even though `Intl` accepts it. The Settings picker adds it by hand.

`absoluteTimeIn(iso, tz)` formats for an explicit zone without touching the
configured one; Settings uses it to preview a zone before it is saved. Keep
that split — previewing by mutating the shared ref leaks an unsaved choice into
the rest of the app.

**Remembered selections.** `composables/useStored.js` wraps `localStorage`
under a `hermit:` prefix for UI choices that should survive a restart — the
compare page's base/target pair and the cherry-pick page's repo and refs.
Two rules apply when restoring:

- **Validate against what exists now.** Release branches get deleted, so a
  remembered value is only applied if it is still in the list; otherwise the
  normal default takes over. Never leave a dead branch selected.
- **Mind the restore order.** On the compare page the target is set first,
  because the watcher that auto-suggests a base only fires when none is set —
  restoring the stored base afterwards then wins. On the cherry-pick page the
  refs cannot be applied until the branch list for the restored repo has
  loaded, since changing the repo clears them; `pendingRestore` holds them
  until then.

**Theme persistence.** The light/dark choice is stored in `localStorage` under
`hermit-console:theme`. It is read *before* `createVuetify` runs and passed as
`defaultTheme`, so the stored theme is the one used for the first paint —
applying it after mount would flash the default first. `App.vue` watches
`theme.name` rather than the toggle button, so any code path that changes the
theme is persisted. Every storage access is wrapped in try/catch: it throws
outright in Safari private mode and when site data is blocked, and the app must
still load (falling back to dark) in that case.

**Comments** explain why, not what — non-obvious API behaviour, a workaround, a
deliberate constraint. Do not narrate the code.

### Adding a page

1. Create `web/src/pages/YourPage.vue`.
2. Add a route in `router.js` with `meta: { title, icon, nav: true }` — the
   sidebar is generated from `meta.nav`, so there is nothing else to wire up.
3. Add any endpoints to `api.js`, a route module under `server/routes/`, and
   orchestration in a service under `server/lib/`.

## Provider plugins

A provider is a folder under `server/plugins/` containing `index.mjs` with a
default export. `plugins/index.mjs` reads the directory at startup, validates
the shape, and registers whatever it finds. **Adding Bitbucket means adding
`server/plugins/bitbucket/index.mjs` and nothing else** — no registration list,
no switch statement, no change to routes or the UI.

### The contract

```js
export default {
  id: 'bitbucket',              // stable; stored on every repo record
  name: 'Bitbucket',
  icon: 'mdi-bitbucket',        // any mdi name
  color: '#2684FF',
  urlExample: 'https://bitbucket.org/{workspace}/{repo}',
  capabilities: { pullRequests: true, diffCounts: true, cherryPick: false },

  matchesUrl (url),             // URL object -> boolean. Cheap host test
  parseUrl (url),               // -> coords, an opaque provider-specific object
  describe (coords),            // -> { namespace, name } for the UI
  credentialHint (host),        // -> { loginMeaning, secretMeaning, tokenUrl, scopes, optional }

  repoWebUrl (coords),
  branchWebUrl (coords, branch),
  commitWebUrl (coords, sha),
  pullRequestWebUrl (coords, id),

  async getRepository (coords),                        // -> { id, name, defaultBranch, webUrl }
  async listBranches (coords),                         // -> [{ name, objectId }]
  async listCommitsBetween (coords, { base, target, top }),
  async diffCounts (coords, { base, target }),         // if capabilities.diffCounts
  async pullRequestsForCommits (coords, ids, { commits }),  // if capabilities.pullRequests
  async createCherryPick (coords, { commitIds, ontoRef, topicBranch })  // if capabilities.cherryPick
}
```

`REQUIRED` in `plugins/index.mjs` lists the keys a plugin must have; a folder
missing any of them is logged and skipped rather than crashing the server.

### Rules

- **`coords` is opaque outside its plugin.** Azure needs `{host, org, project,
  repo}`, GitHub needs `{host, owner, repo}`. Generic code passes the blob back
  and never reads inside it. Anything the UI needs comes from `describe()`.
- **Declare capabilities honestly.** GitHub has no cherry-pick endpoint, so it
  sets `cherryPick: false`; `git-service.mjs` refuses the call and the UI shows
  git commands instead. Never stub a capability that does not work.
- **Normalise commits to the common shape**: `{ commitId, shortId, message,
  author, authorEmail, date, committer, changeCounts }`. `changeCounts` may be
  null where the provider does not supply it.
- **Normalise pull requests to** `{ pullRequestId, title, sourceBranch,
  targetBranch, status, createdBy, url }`. `sourceBranch` is what the UI shows
  as a commit's provenance, so it matters most.
- **`listCommitsBetween(base, target)` returns what `target` adds over `base`.**
  Get the direction right; it is easy to invert and produces a silently empty
  list rather than an error.
- **Fail with `ProviderError`** from `lib/provider-error.mjs` so the status and
  hint reach the UI. `lib/http.mjs`'s `requestJson` already does this for
  network errors, HTML sign-in pages and rate limits.
- **Optional metadata must degrade.** `pullRequestsForCommits` is an
  enhancement; return an empty Map rather than throwing when the token cannot
  read pull requests.

### Stored repo records

```js
{ id, name, provider: 'github', url, host, coords: {...}, enabled, createdAt, updatedAt }
```

Records written before plugins existed had `org`/`project`/`repo` at the top
level and no `provider`. `migrate()` in `lib/repos.mjs` folds them into the
current shape on read and writes back once. Leave it in place — it is what lets
an existing install upgrade without re-adding every repository.

## Verifying changes

There is no test suite. Verify against the real thing:

```bash
make restart && make status          # health check passes
curl -s "$(cat .run/url)/api/health"
```

Individual modules can be exercised directly, which is how the Azure range
semantics were pinned down:

```bash
node --input-type=module -e "
import { pluginForUrl } from './server/plugins/index.mjs'
const { plugin, url } = await pluginForUrl('https://github.com/vuejs/core')
const coords = plugin.parseUrl(url)
console.log(plugin.id, await plugin.getRepository(coords))
console.log((await plugin.listCommitsBetween(coords, { base: 'v3.5.13', target: 'v3.5.14' })).length)
"
```

For UI changes, load every page and watch for console errors — a Vuetify prop
that no longer exists fails at runtime, not at build time. `make dev` gives hot
reload; `.run/web.log` has the Vite output.

## Known rough edges

- **Issue key matching is literal.** A commit reading `Feature/PROJ 482` will
  not match the default `[A-Z][A-Z0-9]+-\d+` pattern. Since keys are now also
  read from branch names, this matters less than it did — `feature/PROJ-482`
  matches even when the message does not.
- **Every commit costs a PR lookup.** Azure batches 100 ids per request;
  GitHub needs one request per commit and caps at 250. Both are cached with the
  range, so the cost is paid once, but a wide first comparison is slow.
- **No GitLab or Bitbucket plugin yet.** The contract above is what one needs;
  nothing else in the codebase would change.
- **Commit lists are capped** at 500 per repo per range (`top` in
  `listCommitsBetween`). Comparisons that far apart would need pagination.
- **`compare-refs` caches by branch name**, so the cherry-pick page can serve
  data up to two minutes old. Use the refresh path after pushing.
- **No pagination in the UI.** Long commit lists scroll inside their card. Fine
  at the current scale, not for thousands of commits.
