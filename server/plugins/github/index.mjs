import { mapLimit, requestJson, requireCredential } from '../../lib/http.mjs'
import { badRequest } from '../../lib/provider-error.mjs'

const enc = encodeURIComponent
const PR_LOOKUP_LIMIT = 250

const AUTH_HINT = host => `Add a line to ~/.authinfo:
  machine ${host} login <your-username> password <personal-access-token>
A classic token needs the "repo" scope; a fine-grained one needs Contents:read
and Pull requests:read. Public repositories work without a token, but GitHub
allows only 60 requests an hour that way.`

/** github.com talks to api.github.com; GitHub Enterprise serves /api/v3. */
function apiRoot (host) {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
}

function repoApi (coords, path = '') {
  return `${apiRoot(coords.host)}/repos/${enc(coords.owner)}/${enc(coords.repo)}${path}`
}

async function headers (host) {
  // Public repositories are readable without a credential, so this is optional
  // — the rate limit is the only difference until a private repo is added.
  const cred = await requireCredential(host, { required: false })
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hermit-console',
    ...(cred?.password ? { Authorization: `Bearer ${cred.password}` } : {})
  }
}

async function call (coords, path, params = {}) {
  const url = new URL(repoApi(coords, path))
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return requestJson(url, {
    host: coords.host,
    authHint: AUTH_HINT(coords.host),
    headers: await headers(coords.host)
  })
}

/** GitHub paginates with a Link header rather than a token in the body. */
function nextPage (responseHeaders) {
  const link = responseHeaders.get('link')
  if (!link) return null
  const match = /<([^>]+)>;\s*rel="next"/.exec(link)
  return match ? match[1] : null
}

async function paged (coords, path, params, collect) {
  let url = new URL(repoApi(coords, path))
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const requestHeaders = await headers(coords.host)

  while (url) {
    const { payload, headers: responseHeaders } = await requestJson(url, {
      host: coords.host, authHint: AUTH_HINT(coords.host), headers: requestHeaders
    })
    if (collect(payload) === false) return
    const next = nextPage(responseHeaders)
    url = next ? new URL(next) : null
  }
}

function normaliseCommit (entry) {
  const commit = entry.commit || {}
  return {
    commitId: entry.sha,
    shortId: entry.sha.slice(0, 8),
    message: commit.message || '',
    author: commit.author?.name || entry.author?.login || 'unknown',
    authorEmail: commit.author?.email || null,
    date: commit.author?.date || commit.committer?.date || null,
    committer: commit.committer?.name || null,
    changeCounts: null   // /compare omits per-commit stats
  }
}

/**
 * GitHub's default merge commit subject names the source branch outright, so
 * the branch can often be recovered without spending a request. Squash merges
 * only leave "(#123)" behind, which gives the number but not the branch.
 */
function pullRequestFromMessage (coords, message) {
  const subject = String(message || '').split('\n')[0]
  const merge = /^Merge pull request #(\d+) from ([^\s]+)/.exec(subject)
  if (merge) {
    const [, number, ref] = merge
    // "owner/branch" for a fork, plain "branch" otherwise.
    const sourceBranch = ref.startsWith(`${coords.owner}/`) ? ref.slice(coords.owner.length + 1) : ref
    return { pullRequestId: Number(number), sourceBranch, title: '', targetBranch: '', fromMessage: true }
  }
  const squash = /\(#(\d+)\)\s*$/.exec(subject)
  if (squash) return { pullRequestId: Number(squash[1]), sourceBranch: null, title: '', targetBranch: '', fromMessage: true }
  return null
}

const plugin = {
  id: 'github',
  name: 'GitHub',
  icon: 'mdi-github',
  color: '#8B949E',
  urlExample: 'https://github.com/{owner}/{repo}',
  capabilities: {
    pullRequests: true,
    diffCounts: true,
    // GitHub has no cherry-pick endpoint; the UI falls back to git commands.
    cherryPick: false
  },

  matchesUrl (url) {
    const host = url.hostname.toLowerCase()
    return host === 'github.com' || host === 'www.github.com' || host.startsWith('github.')
  },

  parseUrl (url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    const segments = url.pathname.split('/').map(decodeURIComponent).filter(Boolean)
    if (segments.length < 2) throw badRequest('Expected a GitHub URL like https://github.com/{owner}/{repo}')
    const [owner, rawRepo] = segments
    const repo = rawRepo.replace(/\.git$/, '')
    if (!owner || !repo) throw badRequest('Could not read the owner and repository from that URL')
    return { host, owner, repo }
  },

  describe: coords => ({ namespace: coords.owner, name: coords.repo }),

  credentialHint: host => ({
    host,
    loginMeaning: 'your GitHub username',
    secretMeaning: 'a personal access token',
    tokenUrl: host === 'github.com'
      ? 'https://github.com/settings/tokens'
      : `https://${host}/settings/tokens`,
    scopes: ['repo (classic)', 'or Contents:read + Pull requests:read (fine-grained)'],
    optional: true
  }),

  repoWebUrl: coords => `https://${coords.host}/${enc(coords.owner)}/${enc(coords.repo)}`,
  branchWebUrl: (coords, branch) => `${plugin.repoWebUrl(coords)}/tree/${branch.split('/').map(enc).join('/')}`,
  commitWebUrl: (coords, sha) => `${plugin.repoWebUrl(coords)}/commit/${sha}`,
  pullRequestWebUrl: (coords, id) => `${plugin.repoWebUrl(coords)}/pull/${id}`,

  async getRepository (coords) {
    const { payload } = await call(coords, '')
    return {
      id: String(payload.id),
      name: payload.name,
      defaultBranch: payload.default_branch || '',
      webUrl: payload.html_url
    }
  },

  async listBranches (coords) {
    const branches = []
    await paged(coords, '/branches', { per_page: 100 }, page => {
      for (const branch of page) branches.push({ name: branch.name, objectId: branch.commit?.sha, creator: null })
    })
    return branches
  },

  /** /compare/base...head returns exactly the commits head adds over base. */
  async listCommitsBetween (coords, { base, target, top = 500 }) {
    const commits = []
    await paged(coords, `/compare/${enc(base)}...${enc(target)}`, { per_page: 100 }, page => {
      for (const entry of page.commits || []) commits.push(normaliseCommit(entry))
      if (commits.length >= top) return false
    })
    return commits.slice(0, top)
  },

  async diffCounts (coords, { base, target }) {
    const { payload } = await call(coords, `/compare/${enc(base)}...${enc(target)}`, { per_page: 1 })
    return {
      ahead: payload.ahead_by ?? null,
      behind: payload.behind_by ?? null,
      baseCommit: payload.merge_base_commit?.sha || null,
      targetCommit: payload.commits?.at(-1)?.sha || null
    }
  },

  /**
   * Source branches come from commit messages first, which costs nothing, then
   * from the API for whatever is left. The API path is one request per commit,
   * so it only runs when a token is configured — burning the 60/hour anonymous
   * budget on branch labels would break the comparison itself.
   */
  async pullRequestsForCommits (coords, commitIds, { commits = [] } = {}) {
    const byCommit = new Map()
    const messages = new Map(commits.map(c => [c.commitId, c.message]))

    for (const commitId of commitIds) {
      const guess = pullRequestFromMessage(coords, messages.get(commitId))
      // A squash merge yields the number but no branch. Keep it anyway — the
      // pull request link is still worth showing, and the API pass below can
      // fill in the branch when a token is available.
      if (guess) {
        byCommit.set(commitId, [{ ...guess, url: plugin.pullRequestWebUrl(coords, guess.pullRequestId) }])
      }
    }

    const authenticated = await requireCredential(coords.host, { required: false })
    if (!authenticated) return byCommit

    // Anything still lacking a branch name, not merely anything unmatched.
    const missing = commitIds
      .filter(id => !byCommit.get(id)?.[0]?.sourceBranch)
      .slice(0, PR_LOOKUP_LIMIT)
    await mapLimit(missing, 8, async commitId => {
      try {
        const { payload } = await call(coords, `/commits/${commitId}/pulls`, { per_page: 10 })
        if (!Array.isArray(payload) || !payload.length) return
        byCommit.set(commitId, payload.map(pr => ({
          pullRequestId: pr.number,
          title: pr.title || '',
          sourceBranch: pr.head?.ref || null,
          targetBranch: pr.base?.ref || '',
          status: pr.state || null,
          createdBy: pr.user?.login || null,
          url: pr.html_url || plugin.pullRequestWebUrl(coords, pr.number)
        })))
      } catch {
        // One unreadable commit should not lose the branch labels for the rest.
      }
    })
    return byCommit
  }
}

export default plugin
