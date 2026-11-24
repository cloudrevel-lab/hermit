import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { pluginForUrl, providerSummaries } from '../server/plugins/index.mjs'
import { inspect as inspectCertificate } from '../server/lib/corp-cert.mjs'
import {
  activePullRequests, branchListFor, compareAcrossRepos, compareRefs, createDemoStore,
  deleteTimeEntry, DEMO_PROJECT, DEMO_PROJECT_KEY, insertTime, jiraDetail, publicRepo,
  rangeReport, releaseOverview, reposFor, searchWorklogs, todayIso, updateDay,
  updateTimeEntry, verifyTicket
} from './fixtures.mjs'

/**
 * The demo API.
 *
 * Mounted at /api instead of the real routers when demo mode is on, so the UI
 * exercises its normal request paths without credentials, network calls or a
 * real database. Reads are generated from the Aurora fixtures; the handful of
 * writes the UI can make (repos, settings, pinned releases, worklogs, cache and
 * certificate) mutate this process's in-memory copy, and POST /demo/reset puts
 * it back. Restarting also starts fresh.
 */

const AUTH = {
  path: '/Users/alex/.authinfo',
  found: true,
  machines: [
    { machine: 'dev.azure.com', login: 'dev@aurora.dev', hasPassword: true },
    { machine: 'github.com', login: 'aurora-labs', hasPassword: true },
    { machine: 'aurora.atlassian.net', login: 'dev@aurora.dev', hasPassword: true }
  ]
}

const fail = (res, status, error, hint = null, extra = {}) =>
  res.status(status).json({ error, hint, ...extra })

const ticketPattern = /^[A-Z][A-Z0-9]*-\d+$/

function cleanTicket (value) {
  const key = String(value || '').trim().toUpperCase()
  if (!ticketPattern.test(key)) {
    const err = new Error(`ticket must look like ${DEMO_PROJECT_KEY}-1234`)
    err.status = 400
    throw err
  }
  return key
}

function cleanHours (value, { allowZero = false } = {}) {
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours < 0 || (hours === 0 && !allowZero) || hours > 24) {
    const err = new Error(`hours must be ${allowZero ? '0 or more' : 'greater than 0'} and at most 24`)
    err.status = 400
    throw err
  }
  return hours
}

function cleanDate (value) {
  const date = String(value || '').slice(0, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const probe = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null
  const valid = match && probe.getUTCFullYear() === Number(match[1]) &&
    probe.getUTCMonth() === Number(match[2]) - 1 &&
    probe.getUTCDate() === Number(match[3])
  if (!valid) {
    const err = new Error('date must be a real YYYY-MM-DD date')
    err.status = 400
    throw err
  }
  return date
}

async function describeUrl (input) {
  const { plugin, url } = await pluginForUrl(input)
  const coords = plugin.parseUrl(url)
  return { plugin, coords, described: plugin.describe(coords), url: plugin.repoWebUrl(coords) }
}

function repoFromUrl ({ plugin, coords, described, url }, input, existing) {
  return {
    id: existing?.id || `repo-${randomUUID().slice(0, 8)}`,
    name: (input.name || '').trim() || described.name,
    provider: plugin.id,
    providerName: plugin.name,
    providerIcon: plugin.icon || 'mdi-source-repository',
    capabilities: plugin.capabilities,
    host: coords.host,
    namespace: described.namespace,
    repo: described.name,
    url,
    enabled: input.enabled ?? existing?.enabled ?? true
  }
}

async function handle (req, res, state) {
  const path = req.path
  const method = req.method
  const body = req.body || {}
  const store = state.store
  const now = new Date().toISOString()

  // -------------------------------------------------------------- system
  if (method === 'GET' && path === '/health') {
    return res.json({ ok: true, demo: true, pid: process.pid, uptime: process.uptime() })
  }

  if (method === 'GET' && path === '/demo') {
    return res.json({
      demo: true,
      project: DEMO_PROJECT,
      description: 'Fictional demo data — no credentials, repositories or Jira calls are used.',
      reset: 'POST /api/demo/reset'
    })
  }

  if (method === 'POST' && path === '/demo/reset') {
    state.store = createDemoStore()
    return res.json({ ok: true, message: 'Demo data reset' })
  }

  if (method === 'GET' && path === '/auth') return res.json(AUTH)

  if (method === 'GET' && path === '/settings') return res.json({ settings: store.settings })
  if (method === 'PUT' && path === '/settings') {
    store.settings = { ...store.settings, ...body }
    return res.json({ settings: store.settings })
  }

  if (method === 'GET' && path === '/cache') return res.json(store.cache)
  if (method === 'DELETE' && path === '/cache') {
    const removed = store.cache.entries
    store.cache = { entries: 0, bytes: 0, oldest: null }
    return res.json({ removed })
  }

  if (method === 'GET' && path === '/cert') return res.json(store.cert)
  if (method === 'PUT' && path === '/cert') {
    const certs = inspectCertificate(body.pem)
    store.cert = {
      ...store.cert,
      present: true,
      certs,
      error: null,
      installed: true
    }
    return res.json(store.cert)
  }
  if (method === 'DELETE' && path === '/cert') {
    store.cert = { ...store.cert, present: false, certs: [], error: null, installed: false }
    return res.json(store.cert)
  }
  if (method === 'POST' && path === '/cert/test') {
    const raw = body.url || store.settings.jiraBaseUrl
    let host
    try {
      host = new URL(raw.includes('://') ? raw : `https://${raw}`).host
    } catch {
      return fail(res, 400, `Not a valid URL: ${raw}`)
    }
    return res.json({ ok: true, host, status: 200 })
  }

  // ---------------------------------------------------------------- repos
  if (method === 'GET' && path === '/repos') return res.json({ repos: reposFor(store) })
  if (method === 'GET' && path === '/repos/providers') return res.json({ providers: await providerSummaries() })

  if (method === 'POST' && path === '/repos/probe') {
    const described = await describeUrl(body.url)
    return res.json({
      ok: true,
      provider: {
        id: described.plugin.id,
        name: described.plugin.name,
        icon: described.plugin.icon,
        capabilities: described.plugin.capabilities
      },
      described: described.described,
      info: {
        id: `demo-${randomUUID().slice(0, 8)}`,
        name: described.described.name,
        defaultBranch: 'main',
        webUrl: described.url
      }
    })
  }

  if (method === 'POST' && path === '/repos') {
    const described = await describeUrl(body.url)
    if (store.repos.some(repo => repo.url.toLowerCase() === described.url.toLowerCase())) {
      return fail(res, 409, 'That repository is already in the list')
    }
    const repo = repoFromUrl(described, body)
    store.repos.push(repo)
    return res.status(201).json({ repo: publicRepo(repo) })
  }

  const repoMatch = /^\/repos\/([^/]+)$/.exec(path)
  if (repoMatch) {
    const id = decodeURIComponent(repoMatch[1])
    const index = store.repos.findIndex(repo => repo.id === id)
    if (index === -1) return fail(res, 404, 'No such repository')

    if (method === 'PUT') {
      const existing = store.repos[index]
      if (body.url && body.url !== existing.url) {
        const described = await describeUrl(body.url)
        if (store.repos.some(repo => repo.id !== id && repo.url.toLowerCase() === described.url.toLowerCase())) {
          return fail(res, 409, 'That repository is already in the list')
        }
        store.repos[index] = repoFromUrl(described, body, existing)
      } else {
        store.repos[index] = {
          ...existing,
          name: body.name !== undefined ? String(body.name).trim() || existing.name : existing.name,
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled
        }
      }
      return res.json({ repo: publicRepo(store.repos[index]) })
    }
    if (method === 'DELETE') {
      store.repos.splice(index, 1)
      return res.status(204).end()
    }
  }

  // ------------------------------------------------------------------ git
  if (method === 'GET' && path === '/git/releases') return res.json(releaseOverview(store))
  if (method === 'GET' && path === '/git/pull-requests') return res.json(activePullRequests(store))

  if (method === 'POST' && path === '/git/compare') {
    if (!body.base || !body.target) return fail(res, 400, 'base and target branches are required')
    if (body.base === body.target) return fail(res, 400, 'Pick two different branches')
    return res.json(compareAcrossRepos(store, body))
  }

  if (method === 'GET' && /^\/git\/repos\/[^/]+\/branches$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[3])
    const repo = store.repos.find(candidate => candidate.id === id)
    if (!repo) return fail(res, 404, 'No such repository')
    return res.json({
      repo: publicRepo(repo),
      branches: branchListFor(store, repo),
      cached: false,
      fetchedAt: now
    })
  }

  if (method === 'POST' && path === '/git/compare-refs') {
    if (!body.repoId || !body.left || !body.right) {
      return fail(res, 400, 'repoId, left and right are required')
    }
    if (body.left === body.right) return fail(res, 400, 'Pick two different refs')
    return res.json(compareRefs(store, body))
  }

  if (method === 'POST' && path === '/git/cherry-pick') {
    if (!store.settings.allowCherryPickWrites) {
      return fail(res, 403, 'Cherry-pick writes are disabled', 'Enable "Allow cherry-pick writes" in Settings first.')
    }
    const repo = store.repos.find(candidate => candidate.id === body.repoId)
    if (!repo) return fail(res, 404, 'No such repository')
    if (!repo.capabilities.cherryPick) {
      return fail(res, 400, `${repo.providerName} has no cherry-pick API`, 'Copy the git commands and run them locally instead.')
    }
    if (!body.commitIds?.length || !body.ontoRef) {
      return fail(res, 400, 'repoId, commitIds and ontoRef are required')
    }
    const topicBranch = body.topicBranch || `cherry-pick/${String(body.ontoRef).replace(/[^\w.-]+/g, '-')}-${Date.now().toString(36)}`
    const mode = body.mode || 'branch'
    const pullRequestId = 400 + body.commitIds.length
    const pullRequest = mode === 'branch' ? null : {
      pullRequestId,
      title: `Cherry-pick ${body.commitIds.length} commit(s) into ${body.ontoRef}`,
      sourceBranch: topicBranch,
      targetBranch: body.ontoRef,
      autoComplete: mode === 'auto',
      url: repo.provider === 'github'
        ? `${repo.url}/pull/${pullRequestId}`
        : `${repo.url}/pullrequest/${pullRequestId}`
    }
    return res.json({
      action: 'cherry-pick',
      topicBranch,
      cherryPickId: `demo-cherry-pick-${Date.now().toString(36)}`,
      mode,
      pullRequest,
      events: ['demo: commits applied to the simulated topic branch']
    })
  }

  if (method === 'POST' && path === '/git/merge-branches') {
    if (!store.settings.allowCherryPickWrites || !store.settings.allowCherryPickDirectMerge) {
      return fail(res, 403, 'Merging branches directly is disabled', 'Enable the direct-merge setting in Settings first.')
    }
    if (!body.repoId || !body.sourceRef || !body.targetRef) {
      return fail(res, 400, 'repoId, sourceRef and targetRef are required')
    }
    if (body.sourceRef === body.targetRef) return fail(res, 400, 'Pick two different branches to merge')
    const repo = store.repos.find(candidate => candidate.id === body.repoId)
    if (!repo) return fail(res, 404, 'No such repository')
    return res.json({
      action: 'merge-branches',
      strategy: 'merge-commit',
      sourceRef: body.sourceRef,
      targetRef: body.targetRef,
      mergeCommitId: randomUUID().replace(/-/g, '').slice(0, 40)
    })
  }

  if (method === 'POST' && path === '/git/pull-requests') {
    if (!store.settings.allowCherryPickWrites) {
      return fail(res, 403, 'Opening pull requests is disabled', 'Enable "Allow cherry-pick writes" in Settings first.')
    }
    if (!body.repoId || !body.sourceRef || !body.targetRef) {
      return fail(res, 400, 'repoId, sourceRef and targetRef are required')
    }
    if (body.sourceRef === body.targetRef) return fail(res, 400, 'The source and target branch must differ')
    const repo = store.repos.find(candidate => candidate.id === body.repoId)
    if (!repo) return fail(res, 404, 'No such repository')
    const id = 500 + store.pullRequests.size
    return res.json({
      pullRequest: {
        pullRequestId: id,
        title: body.title || `Merge ${body.sourceRef} into ${body.targetRef}`,
        sourceBranch: body.sourceRef,
        targetBranch: body.targetRef,
        url: repo.provider === 'github' ? `${repo.url}/pull/${id}` : `${repo.url}/pullrequest/${id}`
      }
    })
  }

  // ----------------------------------------------------------------- jira
  if (method === 'GET' && path === '/jira/releases') return res.json({ releases: store.jiraReleases })

  if (method === 'POST' && path === '/jira/releases') {
    const name = String(body.name || '').trim()
    if (!name) return fail(res, 400, 'A Fix Version name is required')
    if (store.jiraReleases.some(release => release.name.toLowerCase() === name.toLowerCase())) {
      return fail(res, 409, `"${name}" is already pinned`)
    }
    const release = {
      id: randomUUID(),
      name,
      projectKey: body.projectKey || store.settings.jiraProjectKey,
      host: 'aurora.atlassian.net',
      createdAt: now
    }
    store.jiraReleases.push(release)
    return res.status(201).json({ release })
  }

  const releaseMatch = /^\/jira\/releases\/([^/]+)$/.exec(path)
  if (releaseMatch && method === 'DELETE') {
    const id = decodeURIComponent(releaseMatch[1])
    const index = store.jiraReleases.findIndex(release => release.id === id)
    if (index === -1) return fail(res, 404, 'No such release')
    store.jiraReleases.splice(index, 1)
    return res.status(204).end()
  }

  const issuesMatch = /^\/jira\/releases\/([^/]+)\/issues$/.exec(path)
  if (issuesMatch && method === 'GET') {
    const id = decodeURIComponent(issuesMatch[1])
    const release = store.jiraReleases.find(candidate => candidate.id === id)
    if (!release) return fail(res, 404, 'No such release')
    return res.json(jiraDetail(store, release))
  }

  if (method === 'GET' && path === '/jira/versions') {
    return res.json({
      host: 'aurora.atlassian.net',
      projectKey: store.settings.jiraProjectKey,
      versions: store.projectVersions,
      cached: true
    })
  }

  if (method === 'POST' && path === '/jira/issues') {
    return res.json({
      host: 'aurora.atlassian.net',
      issues: (body.keys || []).map(key => store.issues[key]).filter(Boolean),
      cached: true
    })
  }

  if (method === 'POST' && path === '/jira/version') {
    const numeric = /versions\/(\d+)/.exec(body.url || '')?.[1]
    const id = body.versionId || (numeric ? `v-${numeric}` : null)
    const version = store.projectVersions.find(candidate => candidate.id === id) ||
      store.projectVersions.find(candidate => candidate.id === 'v-240')
    return res.json({
      host: 'aurora.atlassian.net',
      version,
      issues: (store.releaseIssueKeys[version?.name] || []).map(key => store.issues[key]).filter(Boolean),
      cached: true
    })
  }

  // ----------------------------------------------------------- time logger
  if (method === 'GET' && path === '/time-logger/context') {
    return res.json({
      configured: true,
      displayName: 'Alex Rivera',
      timezone: store.settings.timezone || 'Australia/Sydney',
      hoursPerDay: store.settings.timeLoggerHoursPerDay,
      daysPerWeek: 5,
      site: store.settings.jiraBaseUrl,
      project: store.settings.jiraProjectKey,
      today: todayIso(),
      defaultLogTime: store.settings.timeLoggerDefaultLogTime
    })
  }

  if (method === 'GET' && path === '/time-logger/range') {
    return res.json(rangeReport(store, req.query.from, req.query.to))
  }

  if (method === 'GET' && path === '/time-logger/verify') {
    return res.json(verifyTicket(store, req.query.ticket))
  }

  if (method === 'GET' && path === '/time-logger/search') {
    return res.json(searchWorklogs(store, req.query.q, { months: req.query.months }))
  }

  if (method === 'POST' && path === '/time-logger/worklog') {
    const ticket = cleanTicket(body.ticket)
    const date = cleanDate(body.date)
    const hours = cleanHours(body.hours)
    const entry = insertTime(store, { ticket, date, hours, comment: body.comment })
    return res.json({
      action: 'insert',
      events: [`demo: added ${hours}h to ${ticket} on ${date}`],
      entry
    })
  }

  if (method === 'PUT' && path === '/time-logger/worklog') {
    const ticket = cleanTicket(body.ticket)
    const date = cleanDate(body.date)
    const hours = cleanHours(body.hours, { allowZero: true })
    const entry = updateDay(store, { ticket, date, hours, comment: body.comment })
    return res.json({
      action: 'update',
      events: [hours === 0
        ? `demo: removed ${ticket} from ${date}`
        : `demo: set ${ticket} on ${date} to ${hours}h`],
      entry
    })
  }

  const entryMatch = /^\/time-logger\/worklog\/([^/]+)$/.exec(path)
  if (entryMatch && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(entryMatch[1])
    if (method === 'PUT') {
      const ticket = cleanTicket(body.ticket)
      const date = cleanDate(body.date)
      const entry = updateTimeEntry(store, {
        ticket,
        date,
        id,
        hours: body.hours === undefined ? undefined : cleanHours(body.hours),
        comment: body.comment
      })
      return res.json({
        action: 'update-entry',
        events: [`demo: updated worklog ${id}`],
        entry
      })
    }
    const ticket = cleanTicket(req.query.ticket)
    const date = cleanDate(req.query.date)
    const entry = deleteTimeEntry(store, { ticket, date, id })
    return res.json({
      action: 'delete-entry',
      events: [`demo: deleted worklog ${id}`],
      entry
    })
  }

  return fail(res, 404, `No demo route for ${method} ${path}`, 'This endpoint is not implemented in demo mode.')
}

export function createDemoRouter () {
  const state = { store: createDemoStore() }
  const router = Router()

  router.use(async (req, res) => {
    try {
      await handle(req, res, state)
    } catch (err) {
      const status = err.status || 500
      if (status >= 500) console.error(`[demo] ${req.method} ${req.path}:`, err)
      if (res.headersSent) return
      res.status(status).json({
        error: err.message || 'Unexpected demo error',
        hint: err.hint || null,
        ...(err.code ? { code: err.code } : {}),
        ...(err.details ? { details: err.details } : {})
      })
    }
  })

  return router
}
