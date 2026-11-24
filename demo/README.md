# Aurora demo data

Hermit's README screenshots, manual test passes and evaluation runs use a
fictional product called **Aurora**: a small platform split across Azure DevOps
and GitHub repositories, with an Aurora Jira project and a week of worklogs. It is
deliberately realistic, but none of it is real data and none of it is fetched
from a live service.

Run it whenever you want the whole console populated without touching
`~/.authinfo`, a real repository or Jira:

```bash
make demo                 # source checkout: builds the UI, then runs in the foreground
npm run demo              # same, without make
npx hermit-console demo   # installed package
hermit demo --no-open     # keep the current browser closed
```

The app prints a URL and serves every page from the fixtures. The app bar shows
a **Demo data** chip so a screenshot or a running window is never mistaken for
real data.

## What is in the demo

- **Repositories** — five enabled repositories across Azure DevOps and GitHub,
  plus one disabled repository (`aurora-docs`) to show the switch's effect.
- **Release branches** — `release/2.4.0` and `release/2.3.0` in every enabled
  repository, older releases with gaps, and one ad-hoc `release/2026-09-15`.
- **Commits and pull requests** — branch provenance, PR links, reviewers,
  drafts, an empty repository and one repository that is disabled for release
  compare.
- **Jira** — two pinned Fix Versions, nine tickets on the 2.4.0 release with a
  done / in progress / to do split, and drift in both directions against the
  commits.
- **Time logger** — a generated week of worklogs, a multi-entry day, comments,
  and a recent-ticket window. Typing `AUR-4213` on the Add ticket row exercises
  the typo guard; it is close to `AUR-421` and outside the last 21 days.
- **Settings** — Jira and release conventions filled in, a fictional corporate
  root CA, the installed provider plugins and a non-empty cache. Cherry-pick
  writes are enabled so the apply dialog is interactive.

Dates are generated relative to the day the demo starts, so "last week" and
"20 hours ago" stay meaningful whenever you run it.

## Reset

Demo writes (adding a repository, changing settings, logging time, pinning a
release, uploading a certificate) are held in memory for the life of the
process. Restarting restores the fixtures. To reset without restarting:

```bash
curl -X POST "$URL/api/demo/reset"
```

The server prints `$URL` on startup. `GET /api/demo` reports
`{ "demo": true, "project": "Aurora" }`; production returns `{ "demo": false }`.

## Tests and evaluation

`npm run test:demo` starts the demo server on a free port and checks the API
surface the UI depends on: release coverage, comparison shape, PR review states,
Jira drift data, Time logger ranges, the typo guard, simulated writes, repository
add/reset, settings and cache. CI runs it after `npm run build`.

To evaluate the UI by hand, run `make demo` and work through the sidebar.

### Regenerating the README screenshots

The screens in `docs/screenshots/` are produced from this demo server by
[`capture-screenshots.mjs`](capture-screenshots.mjs). Playwright is not a package
dependency, so install it only when you need to recapture:

```bash
npm install --no-save playwright
npx playwright install chromium
npm run build
node demo/capture-screenshots.mjs
```

The script starts its own demo server, sets the remembered release/cherry-pick
selections, and writes the 15 images into `docs/screenshots/`. Use
`BASE=http://127.0.0.1:1234 node demo/capture-screenshots.mjs` to reuse a running
demo, `THEME=dark …` for the dark theme, or `OUT_DIR=…` for a different
destination.

## Extending the fixtures

Everything lives in [`fixtures.mjs`](fixtures.mjs):

- `ISSUE_SPECS` — the Jira ticket catalogue.
- `REPO_SPECS` and `BRANCHES` — repositories and release coverage.
- `COMMIT_SPECS` and `PR_SPECS` — commit history and open PRs.
- `WEEK_PLAN` and `TIME_COMMENTS` — the generated worklog week.
- `createDemoStore()` — assembles a fresh in-memory state.

[`api.mjs`](api.mjs) maps the real `/api` routes onto that store. Keep its JSON
shapes in step with the production routes; the smoke tests catch the important
ones.

## What it does not do

The demo simulates the **API boundary**, not the provider plugins or the Jira
client. It does not exercise Azure DevOps/GitHub HTTP calls, `~/.authinfo`
parsing, the lowdb store or real branch writes. It is for the UI, screenshots,
manual exploration and API-shape tests. For plugin or Jira-client work, use a
real repository/token or add a focused test with a stub HTTP layer.
