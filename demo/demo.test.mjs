import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { start } from '../server/index.mjs'
import { todayIso, addDays } from './fixtures.mjs'

let server
let base

before(async () => {
  const started = await start({ demo: true, port: 0 })
  server = started.server
  base = started.url
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
})

const get = async path => {
  const response = await fetch(`${base}/api${path}`)
  const body = await response.json()
  return { response, body }
}

const send = async (method, path, payload) => {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  })
  const body = response.status === 204 ? null : await response.json()
  return { response, body }
}

const reset = () => send('POST', '/demo/reset')

test('demo mode identifies itself', async () => {
  const health = await get('/health')
  assert.equal(health.response.status, 200)
  assert.equal(health.body.demo, true)

  const meta = await get('/demo')
  assert.equal(meta.body.demo, true)
  assert.equal(meta.body.project, 'Aurora')
})

test('repositories, providers and release coverage are populated', async () => {
  const repos = await get('/repos')
  assert.equal(repos.body.repos.length, 6)
  assert.deepEqual(
    repos.body.repos.map(repo => repo.provider).sort(),
    ['azure-devops', 'azure-devops', 'azure-devops', 'github', 'github', 'github']
  )

  const providers = await get('/repos/providers')
  assert.deepEqual(providers.body.providers.map(provider => provider.id).sort(), ['azure-devops', 'github'])

  const releases = await get('/git/releases')
  assert.equal(releases.body.releases[0].version, '2.4.0')
  assert.equal(releases.body.releases[0].repos.length, 5)
  assert.equal(releases.body.releases.find(release => release.version === '2026-09-15').isSemver, false)
})

test('a comparison carries commits, provenance and one empty repo', async () => {
  const { response, body } = await send('POST', '/git/compare', {
    base: 'release/2.3.0',
    target: 'release/2.4.0'
  })
  assert.equal(response.status, 200)
  assert.equal(body.results.length, 5)

  const api = body.results.find(result => result.repo.id === 'repo-api')
  assert.equal(api.status, 'ok')
  assert.equal(api.commits.length, 4)
  assert.match(api.commits[0].shortId, /^[0-9a-f]{8}$/)
  assert.deepEqual(api.commits[0].issueKeys, ['AUR-412'])
  assert.equal(api.commits[0].pullRequests[0].pullRequestId, 352)

  const infra = body.results.find(result => result.repo.id === 'repo-infra')
  assert.equal(infra.commits.length, 0)
})

test('pull requests include reviewers, drafts and the disabled repo', async () => {
  const { body } = await get('/git/pull-requests')
  assert.equal(body.total, 8)
  assert.equal(body.repos.length, 6)
  assert.ok(body.repos.some(result => result.repo.id === 'repo-docs' && !result.repo.enabled))
  const awaiting = body.repos.flatMap(result => result.pullRequests)
    .filter(pr => pr.reviewers.some(reviewer => reviewer.isCurrentUser && reviewer.state === 'awaiting'))
  assert.equal(awaiting.length, 3)
  assert.ok(body.repos.flatMap(result => result.pullRequests).some(pr => pr.draft))
})

test('Jira releases have a status breakdown and drift data', async () => {
  const releases = await get('/jira/releases')
  assert.equal(releases.body.releases.length, 2)

  const detail = await get('/jira/releases/jr-2.4.0/issues')
  assert.equal(detail.response.status, 200)
  assert.equal(detail.body.issues.length, 9)
  assert.equal(detail.body.meta.name, 'Aurora 2.4.0 (Next Release)')
  assert.equal(detail.body.meta.released, false)

  const issues = await send('POST', '/jira/issues', { keys: ['AUR-412', 'AUR-418'] })
  assert.deepEqual(issues.body.issues.map(issue => issue.key).sort(), ['AUR-412', 'AUR-418'])
})

test('the Time logger generates a current week and guards a typo', async () => {
  const today = todayIso()
  const from = addDays(today, -6)
  const range = await get(`/time-logger/range?from=${from}&to=${today}`)
  assert.equal(range.response.status, 200)
  assert.equal(range.body.days.length, 7)
  assert.ok(range.body.total > 0)
  assert.ok(range.body.days.some(day => day.entries.length > 0))

  const verdict = await get('/time-logger/verify?ticket=AUR-4213')
  assert.equal(verdict.body.exists, true)
  assert.equal(verdict.body.recent, false)
  assert.ok(verdict.body.lastLogged)
  assert.ok(verdict.body.suggestions.length > 0)

  const recent = await get('/time-logger/verify?ticket=AUR-412')
  assert.equal(recent.body.recent, true)
})

test('time writes change the in-memory report and reset restores it', async () => {
  const today = todayIso()
  const before = await get(`/time-logger/range?from=${today}&to=${today}`)
  const previous = before.body.days[0].entries.find(entry => entry.ticket === 'AUR-405')?.hours || 0

  const update = await send('PUT', '/time-logger/worklog', {
    ticket: 'AUR-405',
    date: today,
    hours: 2.5,
    comment: 'Demo write'
  })
  assert.equal(update.response.status, 200)
  assert.equal(update.body.entry.hours, 2.5)
  assert.equal(update.body.entry.worklogs[0].comment, 'Demo write')

  const afterWrite = await get(`/time-logger/range?from=${today}&to=${today}`)
  const entry = afterWrite.body.days[0].entries.find(candidate => candidate.ticket === 'AUR-405')
  assert.equal(entry.hours, 2.5)
  assert.notEqual(previous, 2.5)

  await reset()
  const afterReset = await get(`/time-logger/range?from=${today}&to=${today}`)
  const restored = afterReset.body.days[0].entries.find(candidate => candidate.ticket === 'AUR-405')
  assert.equal(restored?.hours ?? 0, previous)
})

test('adding a repository is supported, and reset removes it again', async () => {
  const probe = await send('POST', '/repos/probe', {
    url: 'https://dev.azure.com/Contoso/Aurora/_git/aurora-api/branches'
  })
  assert.equal(probe.response.status, 200)
  assert.equal(probe.body.provider.id, 'azure-devops')
  assert.equal(probe.body.info.name, 'aurora-api')

  const added = await send('POST', '/repos', {
    url: 'https://github.com/aurora-labs/aurora-status',
    name: 'aurora-status'
  })
  assert.equal(added.response.status, 201)
  assert.equal(added.body.repo.provider, 'github')
  assert.equal((await get('/repos')).body.repos.length, 7)

  await reset()
  assert.equal((await get('/repos')).body.repos.length, 6)
})

test('settings and cache mutations are local to the demo process', async () => {
  const updated = await send('PUT', '/settings', { timezone: 'UTC' })
  assert.equal(updated.body.settings.timezone, 'UTC')
  assert.equal((await get('/settings')).body.settings.timezone, 'UTC')

  const cleared = await send('DELETE', '/cache')
  assert.equal(cleared.body.removed, 128)
  assert.equal((await get('/cache')).body.entries, 0)

  await reset()
  assert.equal((await get('/settings')).body.settings.timezone, 'Australia/Sydney')
  assert.equal((await get('/cache')).body.entries, 128)
})
