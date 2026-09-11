import { cached, TTL } from './cache.mjs'
import { getDb } from './db.mjs'
import { extractIssueKeys } from './jira.mjs'
import { enabledRepos, publicRepo, repoWithPlugin } from './repos.mjs'
import { collateReleases } from './versions.mjs'

function describeError (err) {
  return { message: err.message, status: err.status || 502, hint: err.hint || null }
}

/**
 * Attaches the pull requests each commit arrived through. A commit can belong
 * to more than one — typically one into the mainline and one into the release
 * — so the list is ordered by relevance: a PR into the branch being compared
 * wins, then the most recent.
 */
function attachPullRequests (commits, prMap, preferTarget) {
  return commits.map(commit => {
    const prs = [...(prMap.get(commit.commitId) || [])].sort((a, b) => {
      const aMatch = a.targetBranch === preferTarget
      const bMatch = b.targetBranch === preferTarget
      if (aMatch !== bMatch) return aMatch ? -1 : 1
      return b.pullRequestId - a.pullRequestId
    })
    return { ...commit, pullRequests: prs, sourceBranch: prs[0]?.sourceBranch || null }
  })
}

/**
 * Derived after the cache is read, not before, so editing the pattern in
 * Settings re-reads cached commits instead of needing the cache cleared.
 */
function withIssueKeys (commits, pattern) {
  return commits.map(commit => {
    const haystack = [
      commit.message,
      commit.sourceBranch,
      ...(commit.pullRequests || []).map(pr => `${pr.title} ${pr.sourceBranch}`)
    ].filter(Boolean).join('\n')
    return { ...commit, issueKeys: extractIssueKeys(haystack, pattern) }
  })
}

/** One provider-agnostic fetch of a commit range plus its PR metadata. */
async function commitRange (plugin, coords, { base, target }) {
  const [commits, counts] = await Promise.all([
    plugin.listCommitsBetween(coords, { base, target }),
    plugin.capabilities.diffCounts
      ? plugin.diffCounts(coords, { base, target }).catch(() => null)
      : null
  ])

  let prMap = new Map()
  if (plugin.capabilities.pullRequests) {
    prMap = await plugin
      .pullRequestsForCommits(coords, commits.map(c => c.commitId), { commits })
      .catch(() => new Map())
  }
  return { commits: attachPullRequests(commits, prMap, target), counts }
}

function decorate (plugin, coords, commits) {
  return commits.map(c => ({ ...c, url: plugin.commitWebUrl(coords, c.commitId) }))
}

export async function branchesFor (repoId, { refresh = false } = {}) {
  const { repo, plugin } = await repoWithPlugin(repoId)
  const { value, cached: fromCache, at } = await cached(
    `refs:${repo.id}`,
    refresh ? 0 : TTL.refs,
    () => plugin.listBranches(repo.coords)
  )
  return {
    repo: await publicRepo(repo),
    branches: value,
    cached: fromCache,
    fetchedAt: new Date(at).toISOString()
  }
}

/** Branches from every enabled repo, tolerating per-repo failures. */
async function allBranches ({ refresh = false } = {}) {
  const repos = await enabledRepos()
  return Promise.all(repos.map(async repo => {
    const summary = await publicRepo(repo)
    try {
      const { plugin } = await repoWithPlugin(repo.id)
      const { value } = await cached(`refs:${repo.id}`, refresh ? 0 : TTL.refs,
        () => plugin.listBranches(repo.coords))
      return { repoId: repo.id, repo: summary, branches: value }
    } catch (err) {
      return { repoId: repo.id, repo: summary, branches: [], error: describeError(err) }
    }
  }))
}

export async function releaseOverview ({ refresh = false } = {}) {
  const db = await getDb()
  const prefix = db.data.settings.releaseBranchPrefix
  const perRepo = await allBranches({ refresh })
  return {
    prefix,
    repos: perRepo.map(r => ({ ...r.repo, error: r.error || null, branchCount: r.branches.length })),
    releases: collateReleases(perRepo, prefix),
    errors: perRepo.filter(r => r.error).map(r => ({ repo: r.repo.name, ...r.error }))
  }
}

export async function compareAcrossRepos ({ base, target, repoIds, refresh = false }) {
  const perRepo = await allBranches({ refresh })
  const wanted = repoIds?.length ? perRepo.filter(r => repoIds.includes(r.repoId)) : perRepo
  const db = await getDb()

  const results = await Promise.all(wanted.map(async entry => {
    const { repo, branches, error } = entry
    if (error) return { repo, status: 'error', ...error }

    const names = new Set(branches.map(b => b.name))
    const hasBase = names.has(base)
    const hasTarget = names.has(target)
    if (!hasBase || !hasTarget) {
      return {
        repo,
        status: 'skipped',
        reason: !hasBase && !hasTarget ? 'Neither branch exists here' : `Missing ${!hasBase ? base : target}`
      }
    }

    const tip = name => branches.find(b => b.name === name).objectId
    try {
      const { repo: stored, plugin } = await repoWithPlugin(repo.id)
      // Keyed by both tip SHAs, so a cached range can never be stale.
      const key = `range:v3:${repo.id}:${tip(base)}..${tip(target)}`
      const { value, cached: fromCache, at } = await cached(key, refresh ? 0 : TTL.range,
        () => commitRange(plugin, stored.coords, { base, target }))

      return {
        repo,
        status: 'ok',
        cached: fromCache,
        fetchedAt: new Date(at).toISOString(),
        baseTip: tip(base),
        targetTip: tip(target),
        baseUrl: plugin.branchWebUrl(stored.coords, base),
        targetUrl: plugin.branchWebUrl(stored.coords, target),
        counts: value.counts,
        commits: decorate(plugin, stored.coords,
          withIssueKeys(value.commits, db.data.settings.issueKeyPattern))
      }
    } catch (err) {
      return { repo, status: 'error', ...describeError(err) }
    }
  }))

  return { base, target, results }
}

/** Two arbitrary refs in one repo, in both directions — the cherry-pick view. */
export async function compareRefs ({ repoId, left, right, refresh = false }) {
  const { repo, plugin } = await repoWithPlugin(repoId)
  const db = await getDb()

  const side = async (base, target) => {
    const { value } = await cached(
      `pair:v3:${repo.id}:${base}..${target}`,
      refresh ? 0 : TTL.refs,
      () => commitRange(plugin, repo.coords, { base, target })
    )
    return decorate(plugin, repo.coords, withIssueKeys(value.commits, db.data.settings.issueKeyPattern))
  }

  const [leftOnly, rightOnly, counts] = await Promise.all([
    side(right, left),   // in left, not in right
    side(left, right),   // in right, not in left
    plugin.capabilities.diffCounts
      ? plugin.diffCounts(repo.coords, { base: left, target: right }).catch(() => null)
      : null
  ])

  return {
    repo: await publicRepo(repo),
    left: { ref: left, url: plugin.branchWebUrl(repo.coords, left), commits: leftOnly },
    right: { ref: right, url: plugin.branchWebUrl(repo.coords, right), commits: rightOnly },
    counts
  }
}

export const CHERRY_PICK_MODES = ['branch', 'pr', 'auto']

/**
 * Lands selected commits on `ontoRef`. Azure's cherry-pick API can only write
 * to a new branch, so "onto the target" is three steps, and `mode` says how far
 * down them to go:
 *
 *   branch  the topic branch only; you raise the PR (the original behaviour)
 *   pr      also open a pull request from it into `ontoRef`
 *   auto    also set that PR to auto-complete, so it merges once policies pass
 *
 * Anything past `branch` is best-effort: the topic branch is the durable
 * result, so a failure to open or complete the PR is reported alongside it
 * rather than thrown away, and the commits are never lost.
 */
export async function cherryPick ({ repoId, commitIds, ontoRef, topicBranch, mode = 'branch' }) {
  const { repo, plugin } = await repoWithPlugin(repoId)
  if (!plugin.capabilities.cherryPick) {
    const err = new Error(`${plugin.name} has no cherry-pick API`)
    err.status = 400
    err.hint = 'Copy the git commands from the dialog and run them locally instead.'
    throw err
  }
  if (!CHERRY_PICK_MODES.includes(mode)) {
    const err = new Error(`Unknown cherry-pick mode "${mode}"`)
    err.status = 400
    throw err
  }
  if (mode !== 'branch' && !plugin.capabilities.pullRequestWrites) {
    const err = new Error(`${plugin.name} cannot open pull requests from this console`)
    err.status = 400
    err.hint = 'Use "topic branch only" and raise the pull request yourself.'
    throw err
  }

  const generated = topicBranch || `cherry-pick/${ontoRef.replace(/[^\w.-]+/g, '-')}-${Date.now().toString(36)}`
  const pick = await plugin.createCherryPick(repo.coords, { commitIds, ontoRef, topicBranch: generated })
  if (mode === 'branch') return { ...pick, mode, pullRequest: null }

  try {
    await plugin.waitForCherryPick(repo.coords, pick.cherryPickId)

    let pullRequest = await plugin.createPullRequest(repo.coords, {
      sourceRef: generated,
      targetRef: ontoRef,
      title: `Cherry-pick ${commitIds.length} commit(s) into ${ontoRef}`,
      description: [
        `Applied by the deploy console from ${generated}.`,
        '',
        'Cherry-picking rewrites each commit, so these arrive on the target with new',
        'commit ids. Comparing the two branches afterwards will still show the originals',
        'as "missing" until the source branch itself is merged.',
        '',
        ...commitIds.map(id => `- ${id.slice(0, 10)}`)
      ].join('\n')
    })

    if (mode === 'auto') {
      pullRequest = await plugin.setPullRequestAutoComplete(repo.coords, pullRequest.pullRequestId)
    }
    return { ...pick, mode, pullRequest, warning: null }
  } catch (err) {
    return {
      ...pick,
      mode,
      pullRequest: null,
      warning: {
        message: `The commits are on ${generated}, but the pull request step failed: ${err.message}`,
        hint: err.hint || 'Raise the pull request from that branch yourself.'
      }
    }
  }
}
