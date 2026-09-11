import { basicAuth, mapLimit, requestJson, requireCredential } from '../../lib/http.mjs'
import { badRequest, ProviderError } from '../../lib/provider-error.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The token owner never changes for the life of the process.
const userIdCache = new Map()

const API_VERSION = '7.1'
const enc = encodeURIComponent

const AUTH_HINT = host => `Add a line to ~/.authinfo:
  machine ${host} login <you@example.com> password <personal-access-token>
The token needs the "Code (read)" scope, plus "Code (write)" for cherry-picks and
pull requests.`

/** Azure PATs authenticate as basic auth with an empty username. */
async function authorization (host) {
  const cred = await requireCredential(host, { hint: AUTH_HINT(host) })
  return basicAuth('', cred.password)
}

function apiBase ({ host, org, project }) {
  const origin = host.endsWith('.visualstudio.com')
    ? `https://${host}`
    : `https://${host}/${enc(org)}`
  return `${origin}/${enc(project)}/_apis/git`
}

function repoApi (coords, path) {
  return `${apiBase(coords)}/repositories/${enc(coords.repo)}${path}`
}

async function call (coords, path, params = {}, init = {}) {
  const url = new URL(repoApi(coords, path))
  url.searchParams.set('api-version', API_VERSION)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return requestJson(url, {
    ...init,
    host: coords.host,
    authHint: AUTH_HINT(coords.host),
    headers: { Authorization: await authorization(coords.host), ...(init.headers || {}) }
  })
}

/** The subset of a PR the console shows, plus everything it needs to poll one. */
function describePullRequest (coords, pr) {
  return {
    pullRequestId: pr.pullRequestId,
    title: pr.title || '',
    status: pr.status || null,
    mergeStatus: pr.mergeStatus || null,
    sourceBranch: (pr.sourceRefName || '').replace('refs/heads/', ''),
    targetBranch: (pr.targetRefName || '').replace('refs/heads/', ''),
    mergeCommitId: pr.lastMergeCommit?.commitId || null,
    autoComplete: Boolean(pr.autoCompleteSetBy),
    url: plugin.pullRequestWebUrl(coords, pr.pullRequestId)
  }
}

const plugin = {
  id: 'azure-devops',
  name: 'Azure DevOps',
  icon: 'mdi-microsoft-azure-devops',
  color: '#0078D4',
  urlExample: 'https://dev.azure.com/{org}/{project}/_git/{repo}',
  capabilities: { pullRequests: true, diffCounts: true, cherryPick: true, pullRequestWrites: true },

  /** Any dev.azure.com or *.visualstudio.com URL that names a repo. */
  matchesUrl (url) {
    const host = url.hostname.toLowerCase()
    return (host === 'dev.azure.com' || host.endsWith('.visualstudio.com') || host.endsWith('.azure.com')) &&
      url.pathname.split('/').includes('_git')
  },

  parseUrl (url) {
    const host = url.hostname.toLowerCase()
    const segments = url.pathname.split('/').map(decodeURIComponent).filter(Boolean)
    const gitIndex = segments.indexOf('_git')
    if (gitIndex === -1 || !segments[gitIndex + 1]) {
      throw badRequest('Expected an Azure DevOps URL containing "/_git/<repo>"')
    }
    const repo = segments[gitIndex + 1]
    const before = segments.slice(0, gitIndex).filter(s => s !== 'DefaultCollection')

    let org, project
    if (host.endsWith('.visualstudio.com')) {
      org = host.split('.')[0]
      project = before[before.length - 1]
    } else {
      // Clone URLs repeat the org: /{org}/{project}/_git/{repo}
      org = before[0]
      project = before.length > 1 ? before[before.length - 1] : before[0]
    }
    if (!org || !project) throw badRequest('Could not read the organisation and project from that URL')
    return { host, org, project, repo }
  },

  describe: coords => ({ namespace: `${coords.org} / ${coords.project}`, name: coords.repo }),

  credentialHint: host => ({
    host,
    loginMeaning: 'your email address',
    secretMeaning: 'a personal access token',
    tokenUrl: `https://${host}/_usersSettings/tokens`,
    scopes: ['Code (read)', 'Code (write) — only for cherry-picks and pull requests']
  }),

  repoWebUrl (coords) {
    const base = coords.host.endsWith('.visualstudio.com')
      ? `https://${coords.host}/${enc(coords.project)}`
      : `https://${coords.host}/${enc(coords.org)}/${enc(coords.project)}`
    return `${base}/_git/${enc(coords.repo)}`
  },
  branchWebUrl: (coords, branch) => `${plugin.repoWebUrl(coords)}?version=GB${enc(branch)}`,
  commitWebUrl: (coords, sha) => `${plugin.repoWebUrl(coords)}/commit/${sha}`,
  pullRequestWebUrl: (coords, id) => `${plugin.repoWebUrl(coords)}/pullrequest/${id}`,

  async getRepository (coords) {
    const { payload } = await call(coords, '')
    return {
      id: payload.id,
      name: payload.name,
      defaultBranch: (payload.defaultBranch || '').replace('refs/heads/', ''),
      webUrl: payload.webUrl
    }
  },

  async listBranches (coords) {
    const branches = []
    let continuationToken
    do {
      const { payload, headers } = await call(coords, '/refs', {
        filter: 'heads/', $top: 1000, continuationToken
      })
      for (const ref of payload.value || []) {
        branches.push({
          name: ref.name.replace('refs/heads/', ''),
          objectId: ref.objectId,
          creator: ref.creator?.displayName || null
        })
      }
      continuationToken = headers.get('x-ms-continuationtoken') || undefined
    } while (continuationToken)
    return branches
  },

  /**
   * Commits in `target` that are not in `base`.
   *
   * Azure's parameter names read backwards: itemVersion is the BASE of the
   * range and compareVersion is the HEAD. Swapping them returns an empty list
   * with a 200 rather than an error.
   */
  async listCommitsBetween (coords, { base, target, top = 500 }) {
    const { payload } = await call(coords, '/commits', {
      'searchCriteria.itemVersion.version': base,
      'searchCriteria.itemVersion.versionType': 'branch',
      'searchCriteria.compareVersion.version': target,
      'searchCriteria.compareVersion.versionType': 'branch',
      'searchCriteria.$top': top,
      'searchCriteria.includeWorkItems': true
    })
    return (payload.value || []).map(c => ({
      commitId: c.commitId,
      shortId: c.commitId.slice(0, 8),
      message: c.comment || '',
      author: c.author?.name || c.author?.email || 'unknown',
      authorEmail: c.author?.email || null,
      date: c.author?.date || c.committer?.date || null,
      committer: c.committer?.name || null,
      changeCounts: c.changeCounts || null
    }))
  },

  async diffCounts (coords, { base, target }) {
    const { payload } = await call(coords, '/diffs/commits', {
      baseVersion: base, baseVersionType: 'branch',
      targetVersion: target, targetVersionType: 'branch',
      $top: 0
    })
    return {
      ahead: payload.aheadCount ?? null,
      behind: payload.behindCount ?? null,
      baseCommit: payload.baseCommit || null,
      targetCommit: payload.targetCommit || null
    }
  },

  /**
   * Two query types are required and return different things: lastMergeCommit
   * matches the merge commit a PR produced, commit matches the commits it
   * carried. A squashed PR appears only under the first.
   */
  async pullRequestsForCommits (coords, commitIds) {
    const byCommit = new Map()
    if (!commitIds.length) return byCommit

    for (let i = 0; i < commitIds.length; i += 100) {
      const items = commitIds.slice(i, i + 100)
      let payload
      try {
        ({ payload } = await call(coords, '/pullrequestquery', {}, {
          method: 'POST',
          body: { queries: [{ type: 'lastMergeCommit', items }, { type: 'commit', items }] }
        }))
      } catch {
        return byCommit   // PR metadata is optional; a read-only token still works
      }
      for (const result of payload.results || []) {
        for (const [commitId, prs] of Object.entries(result)) {
          const list = byCommit.get(commitId) || []
          for (const pr of prs) {
            if (list.some(existing => existing.pullRequestId === pr.pullRequestId)) continue
            list.push({
              pullRequestId: pr.pullRequestId,
              title: pr.title || '',
              sourceBranch: (pr.sourceRefName || '').replace('refs/heads/', ''),
              targetBranch: (pr.targetRefName || '').replace('refs/heads/', ''),
              status: pr.status || null,
              createdBy: pr.createdBy?.displayName || null,
              url: plugin.pullRequestWebUrl(coords, pr.pullRequestId)
            })
          }
          byCommit.set(commitId, list)
        }
      }
    }
    return byCommit
  },

  /**
   * Azure applies the commits to a new topic branch; nothing is rewritten.
   * The REST API has no way to cherry-pick straight onto an existing branch —
   * `generatedRefName` must not already exist — so landing on the target is a
   * second step, via a pull request. See `completeCherryPick` below.
   */
  async createCherryPick (coords, { commitIds, ontoRef, topicBranch }) {
    const { payload } = await call(coords, '/cherryPicks', {}, {
      method: 'POST',
      body: {
        generatedRefName: `refs/heads/${topicBranch}`,
        ontoRefName: `refs/heads/${ontoRef}`,
        source: { commitList: commitIds.map(commitId => ({ commitId })) }
      }
    })
    return { topicBranch, cherryPickId: payload.cherryPickId, status: payload.status, detail: payload }
  },

  async getCherryPick (coords, cherryPickId) {
    const { payload } = await call(coords, `/cherryPicks/${cherryPickId}`)
    return payload
  },

  /**
   * The cherry-pick runs asynchronously and the topic branch does not exist
   * until it lands, so anything that pushes further (opening a PR) has to wait
   * for a terminal status first.
   */
  async waitForCherryPick (coords, cherryPickId, { timeoutMs = 90_000, intervalMs = 1500 } = {}) {
    if (!cherryPickId) {
      throw new ProviderError('Azure DevOps did not return a cherry-pick id to track', {
        hint: 'The topic branch may still appear; check the repository.'
      })
    }
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await plugin.getCherryPick(coords, cherryPickId)
      const status = String(last.status || '').toLowerCase()
      if (status === 'completed' || status === 'succeeded') return last
      if (status === 'conflicts') {
        throw new ProviderError('The cherry-pick hit conflicts and produced no branch', {
          status: 409,
          hint: 'The commits do not apply cleanly onto the target. Resolve them locally with the git commands in the dialog.'
        })
      }
      if (status === 'failure' || status === 'failed' || status === 'abandoned') {
        throw new ProviderError(`Azure DevOps reported the cherry-pick as "${last.status}"`, {
          status: 502,
          hint: last.detailedStatus?.failureMessage || 'Check the cherry-pick in Azure DevOps for the reason.'
        })
      }
      await sleep(intervalMs)
    }
    throw new ProviderError('Timed out waiting for Azure DevOps to finish the cherry-pick', {
      status: 504,
      hint: `The topic branch may still appear. Last status was "${last?.status || 'unknown'}".`
    })
  },

  /** The PAT's own identity, needed to set a PR to auto-complete. */
  async currentUserId (coords) {
    if (userIdCache.has(coords.host)) return userIdCache.get(coords.host)
    const origin = coords.host.endsWith('.visualstudio.com')
      ? `https://${coords.host}`
      : `https://${coords.host}/${enc(coords.org)}`
    const url = new URL(`${origin}/_apis/connectionData`)
    url.searchParams.set('api-version', `${API_VERSION}-preview`)
    const { payload } = await requestJson(url, {
      host: coords.host,
      authHint: AUTH_HINT(coords.host),
      headers: { Authorization: await authorization(coords.host) }
    })
    const id = payload.authenticatedUser?.id
    if (!id) throw new ProviderError('Could not read the token owner from Azure DevOps')
    userIdCache.set(coords.host, id)
    return id
  },

  async createPullRequest (coords, { sourceRef, targetRef, title, description }) {
    const { payload } = await call(coords, '/pullrequests', {}, {
      method: 'POST',
      body: {
        sourceRefName: `refs/heads/${sourceRef}`,
        targetRefName: `refs/heads/${targetRef}`,
        title,
        description
      }
    })
    return describePullRequest(coords, payload)
  },

  /**
   * Auto-complete merges the PR as soon as branch policies pass (immediately,
   * where there are none). `noFastForward` is deliberate: squashing would
   * collapse the picked commits into one more brand-new SHA, which is the very
   * divergence a cherry-pick already causes. The source branch is kept so a
   * failed run leaves something to inspect.
   */
  async setPullRequestAutoComplete (coords, pullRequestId, { deleteSourceBranch = false } = {}) {
    const { payload } = await call(coords, `/pullrequests/${pullRequestId}`, {}, {
      method: 'PATCH',
      body: {
        autoCompleteSetBy: { id: await plugin.currentUserId(coords) },
        completionOptions: {
          mergeStrategy: 'noFastForward',
          squashMerge: false,
          bypassPolicy: false,
          deleteSourceBranch
        }
      }
    })
    return describePullRequest(coords, payload)
  },

  async getPullRequest (coords, pullRequestId) {
    const { payload } = await call(coords, `/pullrequests/${pullRequestId}`)
    return describePullRequest(coords, payload)
  }
}

export default plugin
