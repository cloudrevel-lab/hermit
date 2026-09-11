# Hermit Console

A local web app for working out what actually changed between two releases,
across all the repositories that make one up. It also includes a **Time logger**
for reconciling your Jira worklogs against a date range and fixing them.

Pick a base and a target release — say 1.2.2 and 1.2.3 — and Hermit finds
`release/1.2.2` and `release/1.2.3` in every configured repo and lists the
commits the target adds on top of the base. It then cross-checks those commits
against the Jira release so you can see what is missing on either side.

Repositories can live on **Azure DevOps** or **GitHub**, mixed freely in the
same comparison. Each provider is a plugin, so adding Bitbucket or GitLab means
dropping a folder into `server/plugins/` — see [AGENT.md](AGENT.md).

---

## Install

### From npm

Requires Node 20.19+ or 22.12+.

```bash
npm install -g hermit-console   # install the `hermit` command
hermit                          # start it
```

Or run it without installing anything:

```bash
npx hermit-console
```

Package page: <https://www.npmjs.com/package/hermit-console>. To upgrade later,
`npm install -g hermit-console@latest`.

### One-line installer (macOS, Linux, Windows)

No Node required. The script installs Hermit under `~/.hermit`, fetching a
private Node runtime only when the machine does not already have a suitable one,
and puts a `hermit` command on your PATH. It installs `hermit-console` from
npm; set `HERMIT_TARBALL=<url-or-path>` to install a specific tarball instead.

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/cloudrevel-lab/hermit/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/cloudrevel-lab/hermit/main/install.ps1 | iex
```

If the installer added a directory to your PATH, open a new terminal afterwards.

### From source (development)

```bash
git clone https://github.com/cloudrevel-lab/hermit.git
cd hermit
make up
```

Whichever way you start it, Hermit serves on a free port bound to `127.0.0.1`
and opens your browser. Stop it with Ctrl-C (or `make down` in a source
checkout).

### Command line

```
hermit [options]
  -p, --port <n>      port to listen on (default: any free port)
      --host <addr>   interface to bind (default: 127.0.0.1)
      --data-dir <p>  where db.json and cache.json are stored
      --no-open       do not open a browser
  -h, --help          show this help
  -v, --version       print the version
```

An installed copy keeps its data in a per-user directory — on macOS
`~/Library/Application Support/Hermit`, on Windows `%APPDATA%\Hermit`, on
Linux `$XDG_DATA_HOME/hermit` or `~/.local/share/hermit`. A source checkout
keeps using its own `data/` directory. Override either with `--data-dir` or
`HERMIT_DATA_DIR`.

## Requirements

These are for the source checkout; the npm and installer routes above bring
what they need.

- Node 20.19+ or 22.12+ (Vite's floor). Developed on Node 24
- `make` (macOS and Linux have it; on Windows run the `npm` scripts directly)
- A token for whichever repository provider you use (see **Credentials** below)
- A Jira API token for any Jira feature — the release cross-check, **Jira
  releases**, and the **Time logger**. A token acts as your Jira account, so it
  can read and write exactly what you can.

## Run from source

A source checkout is managed with `make`; `make up` installs, builds and
starts it in the background.

```bash
make up      # install, build, and start in the background
make status  # is it running? on what port? is it healthy?
make down    # stop it
```

`make up` prints the URL when it is ready:

```
Hermit console is up at http://127.0.0.1:58909
Logs: /path/to/repo/.run/*.log     Stop: make down
```

**No port is hard-coded.** The server asks the operating system for a free port
each time it starts, so it will never collide with anything else you have
running. `make status` and `make open` will tell you which one it got.

**You do not need the terminal that started it.** The process is detached and
its PID is written to `.run/`, so `make down` works from any terminal, after a
reboot of your shell, or days later. If the process died on its own, `make down`
notices and cleans up the stale PID file.

### All targets

| Command | What it does |
| --- | --- |
| `make` or `make help` | List the targets |
| `make up` | Build the UI and start in the background on a free port |
| `make down` | Stop whatever is running |
| `make restart` | `down` then `up` |
| `make status` | PIDs, the URL, and a live health check |
| `make open` | Open the running app in your browser |
| `make logs` | Follow the server log |
| `make dev` | Start with hot reload (also backgrounded; stop with `make down`) |
| `make build` | Build the UI without starting anything |
| `make install` | Install dependencies |
| `make clean` | Remove `web/dist` and `.run` |
| `make reset` | `clean`, and also drop the local database and cache |
| `make publish` | Publish this version to npm, using the token in `~/.authinfo` |
| `make release` | Tag the current version and push the tag, triggering the release workflow |

`make up` refuses to start a second copy and tells you what is already running.

**Without `make`** (for example on Windows without Bash), the equivalents are
`npm install`, `npm run build`, then `npm run server`. The server prints its
URL on startup and stops with Ctrl-C.

## Credentials

Tokens are read on the server from `~/.authinfo` and are never sent to the
browser. Add one line per host:

```
machine dev.azure.com login you@example.com password <azure-devops-pat>
machine github.com login your-username password <github-token>
machine your-site.atlassian.net login you@example.com password <jira-api-token>
```

The file uses the standard netrc format, so it can hold entries for other tools
too — only the hosts being called are looked at. Keep it `chmod 600`.

- **Azure DevOps PAT** needs the **Code (read)** scope. Add **Code (write)**
  only if you intend to turn on cherry-pick writes.
  Create one at *User settings → Personal access tokens*.
- **GitHub token** needs `repo` (classic), or Contents:read plus Pull
  requests:read (fine-grained). It is **optional for public repositories** —
  without one GitHub allows 60 requests an hour, which is enough to look around
  but not to work. Create one at *Settings → Developer settings → Tokens*.
- **Jira API token** comes from
  <https://id.atlassian.com/manage-profile/security/api-tokens>. The `login`
  must be the email address of the Atlassian account, and the `machine` host
  must be the Jira site you enter in Settings (for example
  `machine your-site.atlassian.net …`). It is the token the Time logger writes
  worklogs with, and because it carries your own Jira permissions it can only
  change time you are allowed to change.

The app bar shows a green chip per integration once a credential is found, and
an amber one if it is missing. **Settings → Providers** documents exactly what each installed provider expects,
and **Settings → Credentials** lists what was parsed
(hosts and logins only, never the secrets) and re-reads the file on demand — so
after rotating a token you do not need to restart the app.

**Loopback only.** The server binds to `127.0.0.1` and talks to your providers
and Jira with the credentials above. Anyone who can reach it can use them, so do
not expose it on a network interface or put it behind a tunnel. The **Time
logger** and cherry-pick writes change data remotely; every other page is
read-only.

## Configure

Everything is configured in **Settings** in the app bar and saved to
`data/db.json`. The minimum to get going:

1. **Jira base URL** (Settings → Jira) — your Atlassian site, for example
   `https://your-company.atlassian.net`. Used by the Jira cross-check,
   **Jira releases** and the Time logger.
2. **Default project key** — for example `PROJ`. Used for issue lookups and as
   the default in the Fix Version picker.
3. **Time logger site** and **project key** (Settings → Time logger) — leave
   them blank to reuse the Jira base URL and default project key, or point them
   at a different site/project if your worklogs live elsewhere.
4. **Hours per day** — your working day, used for capacity and shortfall.
   Defaults to `8`; set it to `0` to follow Jira's own time-tracking setting.
5. **Display timezone** (Settings → Dates and times) — leave blank to follow the
   browser.

Repository tokens are not entered here: they come from `~/.authinfo` and are
shown read-only under **Settings → Credentials**. Every option is listed in the
[Settings](#settings) table below.

## Using it

### 1. Add your repositories

Go to **Repositories → Add repository** and paste a repository URL. The provider
is worked out from the URL — you do not pick one. Any of these work, including
the branches tab URL straight from your browser:

```
https://dev.azure.com/YourCompany/foo/_git/bar/branches
https://dev.azure.com/YourCompany/foo/_git/bar
https://contoso.visualstudio.com/MyProject/_git/thing
https://github.com/owner/repo
https://github.com/owner/repo/tree/release/1.2.3
```

A release can span providers: some repos on Azure DevOps and some on GitHub
compare together in one view.

**Test connection** confirms the URL parses and that your PAT can actually see
the repo before you save it. Repos can be disabled rather than deleted, which
keeps them out of comparisons without losing the entry.

### 2. Compare two releases

On **Release compare**, pick the base and target. Your last pair is remembered
per browser, so reopening the tool goes straight back to the comparison you
were working on. On a first visit — or if a remembered branch has since been
deleted — the target defaults to the newest release and the base to the one
below it. Choosing a target auto-suggests the previous version, skipping
non-semver branches like `release/2025-05-02`.

The cherry-pick page remembers its repository and both refs the same way.

Before you compare, the page shows a **coverage grid**: which repos have a
branch for each release. After you compare, you get per-repo commit lists with
SHAs linking back to Azure DevOps and file change counts.

Each commit also shows **the branch it was merged from**:

```
d3b957b4  Feature/PROJ 482
A. Developer · 23 hours ago (2026-09-07 Mon) · ~5
⑂ feature/PROJ-482    PR 128  │  PROJ-482
```

The calendar date sits beside the relative age, so "23 hours ago" does not need
working out. Hovering shows the full timestamp with its timezone.

Dates follow your browser's timezone unless you pick one in **Settings → Dates
and times** — useful when the team spans zones, or for reading commit times in
UTC. The setting shows a live preview of the current time in the zone you are
choosing, and clearing the field goes back to following the browser.

Since branches are named after the ticket, this is usually the quickest way to
see which Jira issue a commit belongs to — including when the commit message
never mentions it. The branch and PR chips link to the pull request; hovering
shows the PR title, who raised it, and which branch it went into. A commit that
went straight to the branch with no PR is marked *no pull request*.

The filter box searches branch names and ticket numbers as well as messages,
authors and SHAs, so typing `PROJ-517` shows just that ticket's commits.

Repos where a branch is missing are listed under **Not compared** with the
reason, rather than being silently dropped.

**Copy notes** puts the whole comparison on the clipboard as Markdown, grouped
by repo — usable as a release-notes starting point.

### 3. Cross-check against Jira

Paste the Jira release URL into the cross-check panel, for example:

```
https://your-site.atlassian.net/projects/PROJ/versions/1234/tab/release-report-all-issues
```

You get the drift in both directions:

- **In Jira release, no commit found** — issues scheduled for the release that
  no commit mentions. Either the work has not landed, or the commit did not
  reference the ticket.
- **In commits, not in the Jira release** — issue keys that showed up in commits
  but are not attached to this release in Jira.

Issue keys are collected from three places: the commit message, the **source
branch name**, and the pull request title. Branch names are usually the richest
source, since `feature/PROJ-482` names the ticket even when the commit message
does not.

The pattern is a regex you can change in Settings. The default,
`[A-Z][A-Z0-9]+-\d+`, matches `PROJ-482` but not `PROJ 482` with a space.

### 4. Pin a Jira release

**Jira releases** lists every ticket carrying a given Fix Version, for example
`My Project 1.2.3 (Next Release)`. Pin one by picking it from the project's own
list of versions, or by typing a name — pinned releases are saved, so they are
still there next time you open the tool.

Each release shows its ticket count, a done / in progress / to do breakdown with
a progress bar, and the version's release date. The table gives key, summary,
type, status and assignee; clicking a row opens the ticket in Jira. There is a
filter box and a **Copy keys** button, and **Reload** re-reads from Jira instead
of the cache.

The name is matched literally, exactly as Jira has it, so a typo simply returns
no tickets — the page says so rather than showing an empty table.

### 5. Cherry-pick between branches

**Cherry-pick** compares any two refs in a single repo side by side. Each pane
lists the commits that side has and the other does not. Tick the ones you want
and press the arrow to move them toward the opposite branch.

By default this is **read-only**: it shows you the exact commands to run
yourself.

```
git fetch origin
git switch -c cherry-pick/release-1.2.2-mts380e1 origin/release/1.2.2
git cherry-pick 3c3f26fb61 965fc591e3 0a9c917847
git push -u origin cherry-pick/release-1.2.2-mts380e1
```

Turning on **Allow cherry-pick writes** in Settings lets the console ask the
provider to apply them for you — where the provider supports it. Azure DevOps
does; **GitHub has no cherry-pick API**, so GitHub repos always show the
commands instead, and the page says so. Either way the commits land on a **new topic
branch** — the target branch is never rewritten — and you still raise the pull
request yourself.

### 6. Log your time

**Time logger** reconciles your Jira worklogs against a date range and lets you
correct them in place. Pick a range — or a quick preset, **Today**, **This
week**, **Last week**, **This month**, **Last month** — and press **Retrieve**.
Every day comes back with the tickets you logged time on and an editable hours
box.

> This is the one page that **writes** to Jira. It only ever changes the
> signed-in user's own worklogs, for the ticket and day you choose, but the
> changes are real and immediate — which is why **Update** and **Insert** mean
> different things below.

Each ticket row has one hours box and two buttons, and they mean different
things:

| Button | Effect |
| --- | --- |
| **Update** | Makes that day's total for the ticket **exactly** the box value |
| **Insert** | Adds the box value **on top** of what is already logged |
| 🗑 | Deletes your time for that ticket on that day |

Hovering either button spells out what it is about to do — *"Set Wed 05 Aug to
2h (currently 14h)"* versus *"Add 2h on top - 14h becomes 16h"* — so the two
are hard to confuse. The **Add ticket** row at the foot of each day logs a
ticket that has no time yet, with an optional comment.

A confirmation dialog appears only when something would be destroyed: setting a
day to 0, or collapsing a ticket that has several entries that day into one.
Those rows are marked with an amber *"N entries"* chip. Everything else applies
immediately, and the result of each call is shown in the snackbar.

Only **your own** worklogs are ever changed. The day header shows the day's
total against your working day — green for a full day, amber short, red over —
and the summary card totals the range against weekday capacity.

Retrieval asks Jira for issues you logged time on in the range, so it is fast —
about half a second for a week. The trade-off is that it shows only tickets that
*already have* time, which is what the update/insert buttons need.

The site, project, working day and new-worklog time are configurable in
**Settings → Time logger**. There is no site or project baked in: enter your own
(for example `https://<yourcompanycustomized>.atlassian.net` and `PROJ`), or
leave them blank to reuse the Jira base URL and default project key from the
settings above. The working day defaults to 8h and new worklogs are stamped at
09:00. Ranges are capped at 92 days.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Release branch prefix | `release/` | Which branches count as releases |
| Issue key pattern | `[A-Z][A-Z0-9]+-\d+` | Regex for finding ticket references in commit messages |
| Display timezone | browser | Zone all dates are rendered in |
| Jira base URL | — | Atlassian site used for the Jira cross-check, **Jira releases** and the Time logger |
| Default project key | — | Project for issue lookups and the Fix Version picker |
| Allow cherry-pick writes | off | Lets Azure DevOps apply selected commits; GitHub is always manual |
| Complete the cherry-pick pull request | off | Auto-completes that PR; requires writes on |
| Time logger site | Jira base URL | Site whose worklogs the Time logger reads and writes |
| Time logger project key | default project key | Project scanned for your logged time |
| Time logger hours per day | `8` | Capacity basis; `0` follows Jira's own setting |
| Time logger worklog time | `09:00` | `started` time of day for a new worklog |

## Caching

Comparisons are cached in `data/cache.json` so that re-checking a release is
instant and does not re-hit Azure DevOps.

Commit ranges are keyed by the two branch **tip SHAs**, which means a cached
range can never be stale: if someone pushes to a branch, the tip changes and so
does the key. Branch listings expire after two minutes. Jira lookups after ten.

The **Time logger** range is fetched fresh on every *Retrieve*, because writing
time changes what it would return.

To force fresh data, use **Refresh branches** on the compare page, the refresh
button next to *Copy notes*, or clear the whole cache from **Settings → Cache**.

## Where things are stored

In a source checkout these live under `data/`; an installed copy uses the
per-user directory described in [Install](#install).

| Path | Contents | In git? |
| --- | --- | --- |
| `data/db.json` | Your repo list, pinned Jira releases and settings | No |
| `data/cache.json` | Cached branch and commit data | No |
| `.run/*.pid` | PIDs of the running processes | No |
| `.run/url` | URL of the running instance | No |
| `.run/*.log` | Server and dev-server output | No |
| `~/.authinfo` | Tokens — outside the project entirely | No |
| Browser `localStorage` | Theme choice, and the branches last selected on the compare and cherry-pick pages | No |

Nothing here is shared or remote; it is all local to your machine.

The light/dark toggle in the top right is remembered per browser, so the tool
opens in whichever theme you last chose.

## Troubleshooting

**"Azure DevOps returned a sign-in page instead of data."** The PAT is expired
or lacks the Code (read) scope. Azure serves an HTML login page rather than a
401 in this case, which is why the message is worded that way.

**A repo shows "No credential for dev.azure.com in ~/.authinfo".** The file is
missing, unreadable, or has no matching `machine` line. Check
**Settings → Credentials**, then press *Re-read file*.

**`make down` says a process "DID NOT STOP".** It ignored both SIGTERM and
SIGKILL, which normally means it is wedged in the kernel. `make status` will
still show the PID; investigate it with `ps` before forcing anything.

**The app was already running on a port I lost.** `make status` reads `.run/url`
and reports it, or `make open` goes straight there.

**Nothing loads and the log mentions a build.** Run `make build` on its own to
see the Vite output; `make up` hides it unless it fails.

**The Time logger says "Time logger is not configured".** Set a Jira site and
project key under **Settings → Time logger**, or set the Jira base URL and
default project key — the Time logger falls back to those.

**A Jira call returns 401/403.** The `~/.authinfo` entry is missing or the token
has expired. Check **Settings → Credentials** and press *Re-read file*. For
worklogs, remember the token acts as your Jira account, so it can only log time
where your account can.

**The Time logger shows no tickets for a range.** It lists only issues that
*already carry your time*; it is not an activity report. Use it to correct time
you have logged, not to discover tickets you forgot to log.

**`hermit: command not found` after `npm install -g hermit-console`.** The
command was installed into a Node prefix whose `bin` is not on your PATH — many
machines have more than one Node (nvm, pnpm, Homebrew). Check `npm prefix -g`
and add `<prefix>/bin` to your PATH, or use the one-line installer, which puts
the launcher on your PATH for you.

**The one-line installer fails while installing from npm right after a
release.** A registry can briefly serve a new version's tag before the version
itself, which shows up as `ETARGET No matching version found`. Wait a minute and
run it again. The installer prints npm's error when it fails.

## License

[MIT](LICENSE).

## Contributing

See [AGENT.md](AGENT.md) for the architecture, module layout, API surface, and
the conventions to follow when adding a page or an integration.

### Publishing

`make publish` (or `npm run publish:npm`) releases a new version. It reads the
token you already keep in `~/.authinfo` as `machine npmjs.com` — npm itself
does not read that file, so the script bridges the two with a throwaway
`.npmrc` and verifies the token with `npm whoami` first.

It then lists the last three versions already on npm and asks which version to
publish, suggesting the next patch. The version is validated (semver, not already
published, not lower than the newest), written into `package.json` and
`package-lock.json`, published, and committed as `Release vX.Y.Z`. A failed
publish reverts the version change.

- `HERMIT_VERSION=1.2.3 make publish` — skip the prompt.
- `npm run publish:npm -- --dry-run` — show what would be published, changing
  nothing.

To store or replace the token without echoing it, paste it from the clipboard:

```bash
pbpaste | npm run set-npm-token          # macOS; on Linux: xclip -selection clipboard -o | ...
```

That checks the token against the registry before writing it, and refuses the
masked `npm_xxxx…yyyy` form from the token list — only the full value, shown
once when the token is created, works.

For CI, `.github/workflows/release.yml` publishes on a `v*` tag using the
`NPM_TOKEN` repository secret instead.

`make release` is the other route: it tags the current version (`vX.Y.Z`) and
pushes the tag, which runs the release workflow. That workflow creates a GitHub
release with a `hermit.tgz` asset and publishes
`@cloudrevel-lab/hermit-console` to **GitHub Packages** — a separate registry
whose npm packages must be scoped to the owner, and which GitHub shows as
**private** until you change its visibility (package settings → Danger Zone). It
publishes to npm only if the `NPM_TOKEN` secret is set and that version is not
already there. Use `make publish` **or** `make release`, not both, for the same
version; both refuse to run with uncommitted changes.
