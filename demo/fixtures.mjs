import { createHash } from 'node:crypto'
import { collateReleases } from '../server/lib/versions.mjs'

/**
 * The Aurora demo project.
 *
 * Every screenshot in the README is taken from this data, and `hermit demo`
 * serves it through the real UI. Nothing here touches a network, ~/.authinfo or
 * a real repository: the repository providers and Jira are simulated at the API
 * boundary, so anyone can explore every page without credentials.
 *
 * Dates are generated relative to the day the demo starts, and the Time logger
 * worklogs are generated from a weekly plan. That keeps the demo looking current
 * (and keeps "Last week" working) months after this file was written, instead of
 * freezing it to the day the screenshots were captured.
 */

export const DEMO_PROJECT = 'Aurora'
export const DEMO_TZ = 'Australia/Sydney'
export const DEMO_SITE = 'https://aurora.atlassian.net'
export const DEMO_PROJECT_KEY = 'AUR'

const jiraUrl = key => `${DEMO_SITE}/browse/${key}`
const sha = seed => createHash('sha1').update(String(seed)).digest('hex')

// ------------------------------------------------------------------- dates

export function todayIso (now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEMO_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const get = type => parts.find(p => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays (iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

function dateParts (iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}

export function labelFor (iso) {
  const { y, m, d } = dateParts(iso)
  const date = new Date(Date.UTC(y, m - 1, d))
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
  }).formatToParts(date)
  const get = type => parts.find(p => p.type === type)?.value || ''
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`
}

export function isWeekend (iso) {
  const { y, m, d } = dateParts(iso)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return dow === 0 || dow === 6
}

const weekdayOf = iso => new Date(`${iso}T00:00:00Z`).getUTCDay()
const hoursAgo = hours => new Date(Date.now() - hours * 3600 * 1000).toISOString()
const daysAgo = days => new Date(Date.now() - days * 86400 * 1000).toISOString()
const round2 = n => Math.round(n * 100) / 100

// ------------------------------------------------------------------- issues

const ISSUE_SPECS = [
  ['AUR-401', 'Prepare the 2.4.0 release checklist', 'Task', 'Done', 'done', 'Maya Chen'],
  ['AUR-402', 'Backfill tenant index on deploy', 'Task', 'Done', 'done', 'Sam Okafor'],
  ['AUR-405', 'Harden webhook retry policy', 'Bug', 'In Progress', 'indeterminate', 'Sam Okafor'],
  ['AUR-407', 'Show release coverage on the dashboard', 'Story', 'Done', 'done', 'Maya Chen'],
  ['AUR-412', 'Add cursor pagination to /v1/events', 'Story', 'In Progress', 'indeterminate', 'Priya Nair'],
  ['AUR-418', 'Cache Jira version lookups for 10 minutes', 'Task', 'Done', 'done', 'Tomás Alvarez'],
  ['AUR-421', 'Fix timezone drift in the activity chart', 'Bug', 'Done', 'done', 'Lena Fischer'],
  ['AUR-4213', 'Export release coverage from the CLI', 'Story', 'In Progress', 'indeterminate', 'Priya Nair'],
  ['AUR-423', 'Export release coverage as CSV', 'Story', 'In Progress', 'indeterminate', 'Priya Nair'],
  ['AUR-427', 'Batch index writes in groups of 250', 'Task', 'In Progress', 'indeterminate', 'Tomás Alvarez'],
  ['AUR-430', 'Document the 2.4.0 upgrade path', 'Task', 'To Do', 'new', 'Lena Fischer'],
  ['AUR-431', 'Offline banner on the release timeline', 'Story', 'In Progress', 'indeterminate', 'Lena Fischer'],
  ['AUR-433', 'Rate-limit the export endpoint', 'Task', 'In Progress', 'indeterminate', 'Sam Okafor'],
  ['AUR-436', 'Add SAML session timeout notice', 'Story', 'To Do', 'new', 'Maya Chen']
]

function buildIssues () {
  return Object.fromEntries(ISSUE_SPECS.map(([key, summary, type, status, statusCategory, assignee]) => [key, {
    key, summary, type, status, statusCategory, assignee,
    priority: 'Medium', resolution: null, url: jiraUrl(key)
  }]))
}

const RELEASE_ISSUE_KEYS = {
  'Aurora 2.4.0 (Next Release)': ['AUR-401', 'AUR-402', 'AUR-405', 'AUR-407', 'AUR-412', 'AUR-421', 'AUR-430', 'AUR-433', 'AUR-436'],
  'Aurora 2.3.0': ['AUR-401', 'AUR-402', 'AUR-405', 'AUR-407', 'AUR-421', 'AUR-427'],
  'Aurora 2.2.1': ['AUR-401', 'AUR-405', 'AUR-421']
}

// -------------------------------------------------------------------- repos

const REPO_SPECS = [
  { id: 'repo-api', name: 'aurora-api', kind: 'azure', host: 'dev.azure.com', namespace: 'Contoso / Aurora', repo: 'aurora-api', url: 'https://dev.azure.com/Contoso/Aurora/_git/aurora-api', enabled: true },
  { id: 'repo-web', name: 'aurora-web', kind: 'github', host: 'github.com', namespace: 'aurora-labs', repo: 'aurora-web', url: 'https://github.com/aurora-labs/aurora-web', enabled: true },
  { id: 'repo-workers', name: 'aurora-workers', kind: 'azure', host: 'dev.azure.com', namespace: 'Contoso / Aurora', repo: 'aurora-workers', url: 'https://dev.azure.com/Contoso/Aurora/_git/aurora-workers', enabled: true },
  { id: 'repo-mobile', name: 'aurora-mobile', kind: 'github', host: 'github.com', namespace: 'aurora-labs', repo: 'aurora-mobile', url: 'https://github.com/aurora-labs/aurora-mobile', enabled: true },
  { id: 'repo-infra', name: 'aurora-infra', kind: 'azure', host: 'dev.azure.com', namespace: 'Contoso / Aurora', repo: 'aurora-infra', url: 'https://dev.azure.com/Contoso/Aurora/_git/aurora-infra', enabled: true },
  { id: 'repo-docs', name: 'aurora-docs', kind: 'github', host: 'github.com', namespace: 'aurora-labs', repo: 'aurora-docs', url: 'https://github.com/aurora-labs/aurora-docs', enabled: false }
]

const PROVIDERS = {
  azure: {
    provider: 'azure-devops', providerName: 'Azure DevOps', providerIcon: 'mdi-microsoft-azure-devops',
    capabilities: { pullRequests: true, pullRequestList: true, diffCounts: true, cherryPick: true, pullRequestWrites: true, mergeRefs: true }
  },
  github: {
    provider: 'github', providerName: 'GitHub', providerIcon: 'mdi-github',
    capabilities: { pullRequests: true, pullRequestList: true, diffCounts: true, cherryPick: false }
  }
}

const BRANCHES = {
  'repo-api': ['release/2.4.0', 'release/2.3.0', 'release/2.2.1', 'release/2.2.0', 'main', 'develop'],
  'repo-web': ['release/2.4.0', 'release/2.3.0', 'release/2.2.1', 'release/2.2.0', 'release/2026-09-15', 'main'],
  'repo-workers': ['release/2.4.0', 'release/2.3.0', 'release/2.2.0', 'main'],
  'repo-mobile': ['release/2.4.0', 'release/2.3.0', 'release/2.2.1', 'main'],
  'repo-infra': ['release/2.4.0', 'release/2.3.0', 'release/2.2.1', 'release/2.2.0', 'release/2026-09-15', 'main'],
  'repo-docs': ['main']
}

function branchUrl (repo, branch) {
  return repo.kind === 'azure'
    ? `${repo.url}?version=GB${encodeURIComponent(branch)}`
    : `${repo.url}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`
}

function commitUrl (repo, id) {
  return `${repo.url}/commit/${id}`
}

function prUrl (repo, id) {
  return repo.kind === 'azure' ? `${repo.url}/pullrequest/${id}` : `${repo.url}/pull/${id}`
}

export function publicRepo (repo) {
  return {
    id: repo.id,
    name: repo.name,
    provider: repo.provider,
    providerName: repo.providerName,
    providerIcon: repo.providerIcon,
    capabilities: repo.capabilities,
    host: repo.host,
    namespace: repo.namespace,
    repo: repo.repo,
    url: repo.url,
    enabled: repo.enabled
  }
}

function buildRepo (spec) {
  return { ...spec, ...PROVIDERS[spec.kind] }
}

// ------------------------------------------------------------------ commits

const COMMIT_SPECS = {
  'repo-api': [
    {
      seed: 'aurora-api-412', ago: 20, author: 'Priya Nair',
      message: 'Merged PR 352: AUR-412 Add cursor pagination to /v1/events',
      changes: { Add: 148, Edit: 32, Delete: 6 },
      pr: { id: 352, title: 'Add cursor pagination to /v1/events', source: 'feature/AUR-412-cursor-pagination', target: 'release/2.4.0', author: 'Priya Nair' }
    },
    {
      seed: 'aurora-api-418', ago: 46, author: 'Tomás Alvarez',
      message: 'AUR-418 Cache Jira version lookups for 10 minutes',
      changes: { Add: 24, Edit: 9, Delete: 1 }
    },
    {
      seed: 'aurora-api-401', ago: 70, author: 'Maya Chen',
      message: 'Merged PR 348: AUR-401 Prepare the 2.4.0 release checklist',
      changes: { Add: 12, Edit: 2 },
      pr: { id: 348, title: 'Prepare the 2.4.0 release checklist', source: 'chore/release-2.4.0-checklist', target: 'release/2.4.0', author: 'Maya Chen' }
    },
    {
      seed: 'aurora-api-405', ago: 94, author: 'Sam Okafor',
      message: 'AUR-405 Harden webhook retry policy\n\nRetry 5xx responses with exponential backoff and jitter, and cap the queue at 10k events.',
      changes: { Add: 56, Edit: 18, Delete: 3 }
    }
  ],
  'repo-web': [
    {
      seed: 'aurora-web-407', ago: 100, author: 'Maya Chen',
      message: 'Show release coverage on the dashboard (#219)',
      changes: { Add: 210, Edit: 44, Delete: 12 },
      pr: { id: 219, title: 'Show release coverage on the dashboard', source: 'fix/AUR-407-coverage', target: 'release/2.4.0', author: 'Maya Chen' }
    },
    {
      seed: 'aurora-web-421', ago: 124, author: 'Lena Fischer',
      message: 'AUR-421 Fix timezone drift in the activity chart',
      changes: { Add: 18, Edit: 6 }
    },
    {
      seed: 'aurora-web-423', ago: 148, author: 'Priya Nair',
      message: 'Export release coverage as CSV (#221)',
      changes: { Add: 96, Edit: 12, Delete: 2 },
      pr: { id: 221, title: 'Export release coverage as CSV', source: 'feature/AUR-423-export-csv', target: 'release/2.4.0', author: 'Priya Nair' }
    }
  ],
  'repo-workers': [
    {
      seed: 'aurora-workers-402', ago: 170, author: 'Sam Okafor',
      message: 'Merged PR 97: AUR-402 Backfill tenant index on deploy',
      changes: { Add: 74, Edit: 20, Delete: 5 },
      pr: { id: 97, title: 'Backfill tenant index on deploy', source: 'feature/AUR-402-tenant-index', target: 'release/2.4.0', author: 'Sam Okafor' }
    },
    {
      seed: 'aurora-workers-427', ago: 194, author: 'Tomás Alvarez',
      message: 'AUR-427 Batch index writes in groups of 250',
      changes: { Add: 31, Edit: 5, Delete: 1 }
    }
  ],
  'repo-mobile': [
    {
      seed: 'aurora-mobile-431', ago: 218, author: 'Lena Fischer',
      message: 'Offline banner on the release timeline (#86)',
      changes: { Add: 64, Edit: 9 },
      pr: { id: 86, title: 'Offline banner on the release timeline', source: 'feature/AUR-431-offline-banner', target: 'release/2.4.0', author: 'Lena Fischer' }
    }
  ],
  'repo-infra': []
}

function issueKeys (text) {
  return [...new Set((String(text).match(/[A-Z][A-Z0-9]+-\d+/g) || []))]
}

function buildCommit (repo, spec) {
  const id = sha(spec.seed)
  const pr = spec.pr ? {
    pullRequestId: spec.pr.id,
    title: spec.pr.title,
    sourceBranch: spec.pr.source,
    targetBranch: spec.pr.target,
    createdBy: spec.pr.author,
    status: 'completed',
    url: prUrl(repo, spec.pr.id)
  } : null
  return {
    commitId: id,
    shortId: id.slice(0, 8),
    message: spec.message,
    author: spec.author,
    authorEmail: null,
    date: hoursAgo(spec.ago),
    changeCounts: spec.changes,
    url: commitUrl(repo, id),
    pullRequests: pr ? [pr] : [],
    sourceBranch: pr?.sourceBranch || null,
    issueKeys: issueKeys([spec.message, spec.pr?.title, spec.pr?.source].filter(Boolean).join('\n'))
  }
}

// --------------------------------------------------------------- pull requests

const PR_SPECS = [
  {
    repoId: 'repo-api', id: 352, title: 'Add cursor pagination to /v1/events', draft: false,
    source: 'feature/AUR-412-cursor-pagination', target: 'release/2.4.0', author: 'Priya Nair',
    ageDays: 3, reviewers: [['Alex Rivera', 'awaiting', true], ['Maya Chen', 'approved']]
  },
  {
    repoId: 'repo-api', id: 348, title: 'Cache Jira version lookups for 10 minutes', draft: false,
    source: 'feature/AUR-418-cache-versions', target: 'main', author: 'Tomás Alvarez',
    ageDays: 5, reviewers: [['Alex Rivera', 'awaiting', true], ['Sam Okafor', 'approved']]
  },
  {
    repoId: 'repo-web', id: 221, title: 'Export release coverage as CSV', draft: true,
    source: 'feature/AUR-423-export-csv', target: 'release/2.4.0', author: 'Maya Chen',
    ageDays: 2, reviewers: [['Sam Okafor', 'awaiting'], ['Alex Rivera', 'approved', true]]
  },
  {
    repoId: 'repo-web', id: 219, title: 'Show release coverage on the dashboard', draft: false,
    source: 'fix/AUR-407-coverage', target: 'release/2.4.0', author: 'Priya Nair',
    ageDays: 6, reviewers: [['Maya Chen', 'approved'], ['Alex Rivera', 'approved', true]]
  },
  {
    repoId: 'repo-workers', id: 97, title: 'Backfill tenant index on deploy', draft: false,
    source: 'feature/AUR-402-tenant-index', target: 'main', author: 'Sam Okafor',
    ageDays: 7, reviewers: [['Maya Chen', 'awaiting']]
  },
  {
    repoId: 'repo-mobile', id: 86, title: 'Offline banner on the release timeline', draft: false,
    source: 'feature/AUR-431-offline-banner', target: 'release/2.4.0', author: 'Lena Fischer',
    ageDays: 8, reviewers: [['Alex Rivera', 'approved', true]]
  },
  {
    repoId: 'repo-infra', id: 64, title: 'Pin Node 24 in the build image', draft: false,
    source: 'chore/node-24', target: 'main', author: 'Tomás Alvarez',
    ageDays: 10, reviewers: [['Sam Okafor', 'approved']]
  },
  {
    repoId: 'repo-docs', id: 31, title: 'Document the 2.4.0 upgrade path', draft: false,
    source: 'docs/AUR-430-upgrade', target: 'main', author: 'Lena Fischer',
    ageDays: 11, reviewers: [['Alex Rivera', 'awaiting', true]]
  }
]

function reviewer ([name, state, me = false]) {
  return { id: name.toLowerCase().replace(/\W+/g, '-'), name, state, isCurrentUser: me }
}

// ---------------------------------------------------------------- time logger

const WEEK_PLAN = {
  1: [['AUR-401', 3], ['AUR-405', 3], ['AUR-418', 2]], // Monday
  2: [['AUR-418', 2], ['AUR-421', 4], ['AUR-407', 1.5]], // Tuesday
  3: [['AUR-412', 3], ['AUR-402', 3], ['AUR-423', 2]], // Wednesday
  4: [['AUR-427', 3.5], ['AUR-431', 2], ['AUR-405', 1.5]], // Thursday
  5: [['AUR-412', [2, 1]], ['AUR-405', 3], ['AUR-401', 2]] // Friday
}

const TIME_COMMENTS = {
  'AUR-401': ['Cut the release branch and checked the version pin.', 'Final release checks.'],
  'AUR-402': ['Backfill job and dry run.'],
  'AUR-405': ['Retry policy and tests.', 'Finished the retry backoff and merged the PR.'],
  'AUR-407': ['Paired with Maya on the coverage widget.'],
  'AUR-412': ['Wrote the upgrade notes and captured the release screenshots.', 'Reworked the pagination section after review.'],
  'AUR-418': ['Reviewed the cache invalidation path.', 'Added the version lookup cache.'],
  'AUR-421': ['Reproduced the drift and fixed the bucket boundaries.'],
  'AUR-423': ['CSV column layout and escaping.'],
  'AUR-427': ['Benchmarked batch sizes against staging.'],
  'AUR-431': ['Banner copy and offline state.']
}

const START_TIMES = {
  1: ['09:00', '14:30'],
  2: ['09:00', '13:15'],
  3: ['09:30', '15:00']
}

const timeKey = (date, ticket) => `${date}|${ticket}`

function worklogsFor (date, ticket, hours) {
  const values = Array.isArray(hours) ? hours : [hours]
  const comments = TIME_COMMENTS[ticket] || []
  return values.map((value, index) => ({
    id: `w-${date}-${ticket}-${index + 1}`,
    hours: round2(value),
    started: START_TIMES[ticket.length % 3 + 1]?.[index] || (index ? '14:30' : '09:00'),
    comment: comments[index] || comments[0] || null
  }))
}

function entryFromWorklogs (ticket, worklogs, issues) {
  const logs = worklogs.map(log => ({
    id: log.id,
    hours: round2(log.hours),
    started: log.started,
    comment: log.comment || null
  }))
  return {
    ticket,
    summary: issues[ticket]?.summary || '',
    hours: round2(logs.reduce((sum, log) => sum + log.hours, 0)),
    url: jiraUrl(ticket),
    worklogs: logs
  }
}

function planForDate (date) {
  return WEEK_PLAN[weekdayOf(date)] || []
}

function entriesForDate (store, date) {
  const byTicket = new Map()
  for (const [ticket, hours] of planForDate(date)) {
    const key = timeKey(date, ticket)
    byTicket.set(ticket, store.timeOverrides.has(key)
      ? store.timeOverrides.get(key)
      : worklogsFor(date, ticket, hours))
  }
  // A write can create time on a day the plan does not mention.
  for (const [key, logs] of store.timeOverrides) {
    const [day, ticket] = key.split('|')
    if (day !== date || byTicket.has(ticket)) continue
    byTicket.set(ticket, logs)
  }
  for (const historic of store.timeHistoric) {
    if (historic.date !== date || byTicket.has(historic.ticket)) continue
    if (store.timeOverrides.has(timeKey(date, historic.ticket))) continue
    byTicket.set(historic.ticket, historic.worklogs)
  }
  return [...byTicket.entries()]
    .map(([ticket, logs]) => entryFromWorklogs(ticket, logs, store.issues))
    .filter(entry => entry.worklogs.length)
    .sort((a, b) => b.hours - a.hours || a.ticket.localeCompare(b.ticket))
}

function findEntry (store, date, ticket) {
  return entriesForDate(store, date).find(entry => entry.ticket === ticket) || null
}

function setOverride (store, date, ticket, worklogs) {
  store.timeOverrides.set(timeKey(date, ticket), worklogs)
  return entryFromWorklogs(ticket, worklogs, store.issues)
}

export function rangeReport (store, from, to) {
  const parse = value => {
    const text = String(value || '').slice(0, 10)
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    const probe = match
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : null
    const valid = match && probe.getUTCFullYear() === Number(match[1]) &&
      probe.getUTCMonth() === Number(match[2]) - 1 &&
      probe.getUTCDate() === Number(match[3])
    if (!valid) {
      const err = new Error(`from/to must be YYYY-MM-DD (got ${JSON.stringify(value)})`)
      err.status = 400
      throw err
    }
    return text
  }
  let first = parse(from)
  let last = parse(to)
  if (last < first) [first, last] = [last, first]
  const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000) + 1
  if (span > 92) {
    const err = new Error('range is longer than 92 days; pick a shorter one')
    err.status = 400
    throw err
  }
  const days = []
  for (let n = 0; n < span; n++) {
    const date = addDays(first, n)
    const entries = entriesForDate(store, date)
    days.push({
      date,
      label: labelFor(date),
      weekend: isWeekend(date),
      total: round2(entries.reduce((sum, entry) => sum + entry.hours, 0)),
      entries
    })
  }
  return {
    from: first,
    to: last,
    hoursPerDay: store.settings.timeLoggerHoursPerDay,
    total: round2(days.reduce((sum, day) => sum + day.total, 0)),
    days
  }
}

export function updateDay (store, { ticket, date, hours, comment }) {
  const key = String(ticket || '').toUpperCase()
  const existing = findEntry(store, date, key)
  const amount = Number(hours)
  if (amount === 0) return setOverride(store, date, key, [])
  if (!existing) {
    return setOverride(store, date, key, [{
      id: `w-${date}-${key}-${Date.now().toString(36)}`,
      hours: round2(amount),
      started: '09:00',
      comment: typeof comment === 'string' ? comment.trim() || null : null
    }])
  }
  const keep = { ...existing.worklogs[0] }
  keep.hours = round2(amount)
  if (typeof comment === 'string') keep.comment = comment.trim() || null
  return setOverride(store, date, key, [keep])
}

export function insertTime (store, { ticket, date, hours, comment }) {
  const key = String(ticket || '').toUpperCase()
  const existing = findEntry(store, date, key)
  const logs = existing ? existing.worklogs.map(log => ({ ...log })) : []
  logs.push({
    id: `w-${date}-${key}-${Date.now().toString(36)}`,
    hours: round2(Number(hours)),
    started: '09:00',
    comment: typeof comment === 'string' ? comment.trim() || null : null
  })
  return setOverride(store, date, key, logs)
}

export function updateTimeEntry (store, { ticket, date, id, hours, comment }) {
  const key = String(ticket || '').toUpperCase()
  const existing = findEntry(store, date, key)
  if (!existing) {
    const err = new Error(`no worklog ${id} of yours on ${key} for ${date}`)
    err.status = 404
    throw err
  }
  const logs = existing.worklogs.map(log => {
    if (String(log.id) !== String(id)) return { ...log }
    return {
      ...log,
      hours: hours === undefined ? log.hours : round2(Number(hours)),
      comment: comment === undefined ? log.comment : (String(comment).trim() || null)
    }
  })
  if (!logs.some(log => String(log.id) === String(id))) {
    const err = new Error(`no worklog ${id} of yours on ${key} for ${date}`)
    err.status = 404
    throw err
  }
  return setOverride(store, date, key, logs)
}

export function deleteTimeEntry (store, { ticket, date, id }) {
  const key = String(ticket || '').toUpperCase()
  const existing = findEntry(store, date, key)
  if (!existing || !existing.worklogs.some(log => String(log.id) === String(id))) {
    const err = new Error(`no worklog ${id} of yours on ${key} for ${date}`)
    err.status = 404
    throw err
  }
  return setOverride(store, date, key, existing.worklogs.filter(log => String(log.id) !== String(id)))
}

function recentTickets (store, days = 21) {
  const found = new Map()
  const today = todayIso()
  for (let n = 0; n < days; n++) {
    const date = addDays(today, -n)
    for (const entry of entriesForDate(store, date)) found.set(entry.ticket, entry.summary)
  }
  return found
}

function lastLogged (store, ticket) {
  const today = todayIso()
  for (let n = 1; n <= 365; n++) {
    const date = addDays(today, -n)
    if (entriesForDate(store, date).some(entry => entry.ticket === ticket)) return date
  }
  return null
}

function distance (a, b) {
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) d[i][0] = i
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

function suggestionsFor (key, recent) {
  const project = key.split('-')[0]
  const number = Number(key.split('-').pop()) || 0
  return [...recent.entries()]
    .filter(([ticket]) => ticket.split('-')[0] === project)
    .map(([ticket, summary]) => ({
      ticket, summary, distance: distance(key, ticket),
      gap: Math.abs(number - (Number(ticket.split('-').pop()) || 0))
    }))
    .filter(candidate => candidate.distance > 0 && candidate.distance <= 3)
    .sort((a, b) => a.distance - b.distance || a.gap - b.gap || a.ticket.localeCompare(b.ticket))
    .slice(0, 3)
    .map(({ ticket, summary }) => ({ ticket, summary }))
}

export function verifyTicket (store, raw) {
  const key = String(raw || '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) {
    const err = new Error(`ticket must look like ${DEMO_PROJECT_KEY}-1234`)
    err.status = 400
    throw err
  }
  const recent = recentTickets(store)
  const issue = store.issues[key]
  if (recent.has(key)) {
    return { ticket: key, project: DEMO_PROJECT_KEY, recent: true, exists: true, summary: recent.get(key), windowDays: 21 }
  }
  return {
    ticket: key,
    project: DEMO_PROJECT_KEY,
    recent: false,
    exists: Boolean(issue),
    summary: issue?.summary || '',
    status: issue?.status || null,
    url: jiraUrl(key),
    lastLogged: issue ? lastLogged(store, key) : null,
    windowDays: 21,
    suggestions: suggestionsFor(key, recent)
  }
}

export function searchWorklogs (store, query, { months = 12 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.join(' ').length < 2) {
    const err = new Error('search needs at least two characters')
    err.status = 400
    throw err
  }
  const today = todayIso()
  const first = addDays(today, -Math.round((Math.min(24, Math.max(1, Number(months) || 12)) * 365) / 12))
  const matches = []
  const scanned = new Set()
  for (let date = first; date <= today; date = addDays(date, 1)) {
    for (const entry of entriesForDate(store, date)) {
      scanned.add(entry.ticket)
      for (const log of entry.worklogs) {
        const text = `${entry.ticket} ${entry.summary} ${log.comment || ''}`.toLowerCase()
        if (!terms.every(term => text.includes(term))) continue
        matches.push({
          ticket: entry.ticket,
          summary: entry.summary,
          url: entry.url,
          id: log.id,
          date,
          started: log.started,
          hours: log.hours,
          comment: log.comment
        })
      }
    }
  }
  matches.sort((a, b) => b.date.localeCompare(a.date) || String(a.started).localeCompare(String(b.started)) || a.ticket.localeCompare(b.ticket))
  const days = []
  let current = null
  for (const match of matches.slice(0, 200)) {
    if (!current || current.date !== match.date) {
      current = { date: match.date, label: labelFor(match.date), weekend: isWeekend(match.date), matches: [] }
      days.push(current)
    }
    current.matches.push({
      ticket: match.ticket, summary: match.summary, url: match.url, id: match.id,
      hours: match.hours, started: match.started, comment: match.comment
    })
  }
  return {
    query: String(query || '').trim(),
    from: first,
    to: today,
    months: Math.min(24, Math.max(1, Number(months) || 12)),
    scannedIssues: scanned.size,
    matched: matches.length,
    truncated: matches.length > 200,
    days
  }
}

// ---------------------------------------------------------------- all the rest

function projectVersions () {
  const today = todayIso()
  return [
    { id: 'v-250', name: 'Aurora 2.5.0 (Next Release)', description: null, released: false, archived: false, releaseDate: addDays(today, 60) },
    { id: 'v-240', name: 'Aurora 2.4.0 (Next Release)', description: null, released: false, archived: false, releaseDate: addDays(today, 10) },
    { id: 'v-230', name: 'Aurora 2.3.0', description: null, released: true, archived: false, releaseDate: addDays(today, -39) },
    { id: 'v-221', name: 'Aurora 2.2.1', description: null, released: true, archived: false, releaseDate: addDays(today, -80) }
  ]
}

function releaseReleases () {
  return [
    { id: 'jr-2.4.0', name: 'Aurora 2.4.0 (Next Release)', projectKey: DEMO_PROJECT_KEY, host: 'aurora.atlassian.net', createdAt: daysAgo(21) },
    { id: 'jr-2.3.0', name: 'Aurora 2.3.0', projectKey: DEMO_PROJECT_KEY, host: 'aurora.atlassian.net', createdAt: daysAgo(57) }
  ]
}

function buildPullRequests (store) {
  const byRepo = new Map()
  for (const spec of PR_SPECS) {
    const repo = store.repos.find(candidate => candidate.id === spec.repoId)
    if (!repo) continue
    if (!byRepo.has(repo.id)) byRepo.set(repo.id, [])
    byRepo.get(repo.id).push({
      pullRequestId: spec.id,
      title: spec.title,
      status: 'active',
      mergeStatus: 'succeeded',
      sourceBranch: spec.source,
      targetBranch: spec.target,
      mergeCommitId: null,
      autoComplete: false,
      url: prUrl(repo, spec.id),
      createdBy: spec.author,
      createdAt: daysAgo(spec.ageDays),
      draft: spec.draft,
      reviewers: spec.reviewers.map(reviewer)
    })
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }
  return byRepo
}

export function createDemoStore () {
  const issues = buildIssues()
  const repos = REPO_SPECS.map(buildRepo)
  const byId = Object.fromEntries(repos.map(repo => [repo.id, repo]))
  const commitsByRepo = Object.fromEntries(repos.map(repo => [
    repo.id,
    (COMMIT_SPECS[repo.id] || []).map(spec => buildCommit(repo, spec))
  ]))
  const branchNames = Object.fromEntries(repos.map(repo => [repo.id, BRANCHES[repo.id] || []]))
  const leftOnly = [
    buildCommit(byId['repo-api'], {
      seed: 'aurora-api-409', ago: 14 * 24, author: 'Maya Chen',
      message: 'AUR-409 Backport the webhook retry cap to 2.3.0',
      changes: { Add: 14, Edit: 3 }
    }),
    buildCommit(byId['repo-api'], {
      seed: 'aurora-api-411', ago: 17 * 24, author: 'Sam Okafor',
      message: 'AUR-411 Pin the Jira client to 3.2.1 on 2.3.0',
      changes: { Add: 6, Edit: 2 }
    })
  ]
  const versions = projectVersions()
  const timeHistoric = [{
    date: addDays(todayIso(), -27),
    ticket: 'AUR-4213',
    worklogs: [{
      id: `w-${addDays(todayIso(), -27)}-AUR-4213-1`,
      hours: 2,
      started: '09:00',
      comment: 'Tried the CLI export before the rewrite.'
    }]
  }]
  const store = {
    repos,
    commitsByRepo,
    leftOnly,
    branchNames,
    issues,
    settings: {
      releaseBranchPrefix: 'release/',
      jiraBaseUrl: DEMO_SITE,
      jiraProjectKey: DEMO_PROJECT_KEY,
      issueKeyPattern: '[A-Z][A-Z0-9]+-\\d+',
      allowCherryPickWrites: true,
      allowCherryPickAutoComplete: false,
      allowCherryPickDirectMerge: false,
      timezone: DEMO_TZ,
      timeLoggerSite: '',
      timeLoggerProject: '',
      timeLoggerHoursPerDay: 8,
      timeLoggerDefaultLogTime: '09:00',
      timeLoggerVerifyWindowDays: 21
    },
    jiraReleases: releaseReleases(),
    projectVersions: versions,
    releaseIssueKeys: RELEASE_ISSUE_KEYS,
    timeOverrides: new Map(),
    timeHistoric,
    cache: { entries: 128, bytes: 486912, oldest: daysAgo(12) },
    cert: {
      present: true,
      path: '/Users/alex/.hermit-console/corp-ca.pem',
      certs: [{
        subject: 'CN=Aurora Labs Root CA, O=Aurora Labs, C=AU',
        issuer: 'CN=Aurora Labs Root CA, O=Aurora Labs, C=AU',
        validFrom: '2024-07-01T00:00:00.000Z',
        validTo: '2034-06-30T00:00:00.000Z',
        fingerprint: '8E:41:6C:2B:D9:0A:77:F1:31:55:AE:4C:0D:8F:62:B9',
        isRoot: true,
        isCa: true,
        expired: false
      }],
      error: null,
      installed: true,
      canInstallAtRuntime: true,
      nodeVersion: process.version,
      manualHint: null
    }
  }
  store.pullRequests = buildPullRequests(store)
  return store
}

export function reposFor (store) {
  return store.repos.map(publicRepo)
}

export function branchListFor (store, repo) {
  return (store.branchNames[repo.id] || []).map(name => ({
    name,
    objectId: sha(`${repo.id}:${name}`),
    creator: null,
    url: branchUrl(repo, name)
  }))
}

export function releaseOverview (store) {
  const enabled = store.repos.filter(repo => repo.enabled)
  const perRepo = enabled.map(repo => ({
    repoId: repo.id,
    repo: publicRepo(repo),
    branches: branchListFor(store, repo),
    error: null
  }))
  const releases = collateReleases(perRepo, store.settings.releaseBranchPrefix)
  return {
    prefix: store.settings.releaseBranchPrefix,
    repos: perRepo.map(entry => ({ ...entry.repo, error: null, branchCount: entry.branches.length })),
    releases,
    errors: []
  }
}

export function compareAcrossRepos (store, { base, target, repoIds }) {
  const allowed = new Set(store.repos.filter(repo => repo.enabled).map(repo => repo.id))
  const wanted = (repoIds?.length ? repoIds : [...allowed]).filter(id => allowed.has(id))
  const results = wanted.map(id => {
    const repo = store.repos.find(candidate => candidate.id === id)
    const branches = store.branchNames[id] || []
    const names = new Set(branches)
    if (!names.has(base) || !names.has(target)) {
      return {
        repo: publicRepo(repo),
        status: 'skipped',
        reason: !names.has(base) && !names.has(target)
          ? 'Neither branch exists here'
          : `Missing ${!names.has(base) ? base : target}`
      }
    }
    const commits = store.commitsByRepo[id] || []
    return {
      repo: publicRepo(repo),
      status: 'ok',
      cached: false,
      fetchedAt: new Date().toISOString(),
      baseTip: sha(`${id}:${base}`),
      targetTip: sha(`${id}:${target}`),
      baseUrl: branchUrl(repo, base),
      targetUrl: branchUrl(repo, target),
      counts: { ahead: commits.length, behind: 0 },
      commits
    }
  })
  return { base, target, results }
}

export function compareRefs (store, { repoId, left, right }) {
  const repo = store.repos.find(candidate => candidate.id === repoId)
  if (!repo) {
    const err = new Error('No such repository')
    err.status = 404
    throw err
  }
  return {
    repo: publicRepo(repo),
    left: {
      ref: left,
      url: branchUrl(repo, left),
      commits: repoId === 'repo-api' ? store.leftOnly : []
    },
    right: {
      ref: right,
      url: branchUrl(repo, right),
      commits: store.commitsByRepo[repoId] || []
    },
    counts: {
      ahead: (store.commitsByRepo[repoId] || []).length,
      behind: repoId === 'repo-api' ? store.leftOnly.length : 0
    }
  }
}

export function activePullRequests (store) {
  const results = store.repos.map(repo => ({
    repoId: repo.id,
    repo: publicRepo(repo),
    status: 'ok',
    pullRequests: (store.pullRequests.get(repo.id) || []).map(pr => ({
      ...pr,
      reviewers: [...pr.reviewers].sort((a, b) =>
        Number(b.isCurrentUser) - Number(a.isCurrentUser) || a.name.localeCompare(b.name))
    })),
    cached: false,
    fetchedAt: new Date().toISOString()
  }))
  return {
    repos: results,
    total: results.reduce((sum, result) => sum + result.pullRequests.length, 0),
    fetchedAt: new Date().toISOString()
  }
}

export function jiraDetail (store, release) {
  const meta = store.projectVersions.find(version => version.name === release.name) || null
  const keys = store.releaseIssueKeys[release.name] || []
  return {
    host: 'aurora.atlassian.net',
    release,
    issues: keys.map(key => store.issues[key]).filter(Boolean),
    meta,
    cached: true,
    fetchedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString()
  }
}

