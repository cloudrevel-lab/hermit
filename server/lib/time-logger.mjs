import { credentialFor } from './authinfo.mjs'
import { getDb } from './db.mjs'
import { mapLimit } from './http.mjs'

/**
 * Jira worklog logic for the Time logger page.
 *
 * This is the web UI half of the old `jira-tickets` app, ported from Python
 * (`list_hours.py` + `server.py`) into the Hermit server so it runs in the same
 * process as everything else. It reads the same `~/.authinfo` credentials as
 * `lib/jira.mjs` rather than shelling out to curl.
 *
 * Unlike the rest of Hermit, this module WRITES to Jira: it creates, updates and
 * deletes the caller's own worklogs. Every write is scoped to the signed-in
 * account and to the requested day — other people's worklogs and the caller's
 * worklogs on other days are never touched. See `setDayTotal`.
 *
 * The site, project, working day and default worklog time are configurable in
 * Settings. Nothing organisation-specific is baked in: an unconfigured install
 * reports itself as such and the page prompts for a site and project.
 */

export class TimeLoggerError extends Error {
  constructor (message, { status = 400, hint = null } = {}) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

export const DEFAULTS = {
  hoursPerDay: 8,
  defaultLogTime: '09:00',
  maxRangeDays: 92,
  workers: 10
}

// ---------------------------------------------------------------- configuration

async function config () {
  const db = await getDb()
  const s = db.data.settings || {}
  // A site/project entered for the Time logger wins; blank falls back to the
  // shared Jira settings so one configuration is enough. A fresh install has
  // neither, and the page then prompts for them rather than shipping an
  // organisation's own default.
  const rawSite = String(s.timeLoggerSite || s.jiraBaseUrl || '').trim().replace(/\/+$/, '')
  const rawProject = String(s.timeLoggerProject || s.jiraProjectKey || '').trim().toUpperCase()
  const hours = Number(s.timeLoggerHoursPerDay)
  return {
    site: rawSite ? (/^https?:\/\//.test(rawSite) ? rawSite : `https://${rawSite}`) : null,
    project: rawProject || null,
    // 0 or blank means "follow whatever Jira reports", like HOURS_PER_DAY=None.
    hoursPerDay: Number.isFinite(hours) && hours > 0 ? hours : null,
    defaultLogTime: /^\d{1,2}:\d{2}$/.test(s.timeLoggerDefaultLogTime || '')
      ? s.timeLoggerDefaultLogTime
      : DEFAULTS.defaultLogTime
  }
}

/** Throws a fixable 400 when no Jira site/project is configured anywhere. */
function requireConfig (cfg) {
  if (cfg.site && cfg.project) return
  const missing = [!cfg.site && 'site', !cfg.project && 'project'].filter(Boolean).join(' and ')
  throw new TimeLoggerError(`Time logger has no Jira ${missing}`, {
    status: 400,
    hint: 'Set your Jira site and project key in Settings → Time logger.'
  })
}

function hostOf (site) {
  return new URL(site).hostname
}

// ---------------------------------------------------------------------- http

async function authHeader (host) {
  const cred = await credentialFor(host)
  if (!cred?.password || !cred?.login) {
    throw new TimeLoggerError(`No credential for ${host} in ~/.authinfo`, {
      status: 401,
      hint: `Add a line to ~/.authinfo:\n  machine ${host} login <you@example.com> password <jira-api-token>\nCreate a token at https://id.atlassian.com/manage-profile/security/api-tokens`
    })
  }
  return 'Basic ' + Buffer.from(`${cred.login}:${cred.password}`).toString('base64')
}

async function jiraRequest (site, path, { method = 'GET', body, query } = {}) {
  const host = hostOf(site)
  const url = new URL(`${site}/rest/api/3${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }

  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: await authHeader(host),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  } catch (cause) {
    throw new TimeLoggerError(`Cannot reach ${host}: ${cause.message}`, { status: 502 })
  }

  const text = await res.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new TimeLoggerError(`Jira rejected the credentials for ${host}`, {
        status: 401,
        hint: `The ~/.authinfo entry for ${host} is missing, malformed, or the API token has expired.\nCreate a new token at https://id.atlassian.com/manage-profile/security/api-tokens`
      })
    }
    const detail = data?.errorMessages?.join(' ') || data?.message || text.slice(0, 300) ||
      `Jira responded ${res.status}`
    throw new TimeLoggerError(detail, { status: res.status >= 500 ? 502 : res.status })
  }

  return { data, status: res.status }
}

// The signed-in user and the site's time-tracking conventions cost two calls, so
// they are cached briefly rather than re-fetched for every range and write.
let siteCache = null

async function loadSite (cfg) {
  const now = Date.now()
  if (siteCache && siteCache.site === cfg.site && now - siteCache.at < 5 * 60 * 1000) {
    return siteCache.value
  }
  const [me, configuration] = await Promise.all([
    jiraRequest(cfg.site, '/myself'),
    jiraRequest(cfg.site, '/configuration')
  ])
  const tt = configuration.data?.timeTrackingConfiguration || {}
  const value = {
    accountId: me.data?.accountId,
    displayName: me.data?.displayName || 'unknown',
    timezone: me.data?.timeZone || 'UTC',
    siteHoursPerDay: Number(tt.workingHoursPerDay) || 8,
    daysPerWeek: Number(tt.workingDaysPerWeek) || 5
  }
  siteCache = { site: cfg.site, at: now, value }
  return value
}

async function buildCtx (cfg) {
  const base = await loadSite(cfg)
  return {
    site: cfg.site,
    project: cfg.project,
    accountId: base.accountId,
    displayName: base.displayName,
    tz: safeZone(base.timezone),
    hoursPerDay: cfg.hoursPerDay || base.siteHoursPerDay,
    daysPerWeek: base.daysPerWeek,
    defaultLogTime: cfg.defaultLogTime
  }
}

export async function getContext () {
  const cfg = await config()
  // Report an unconfigured install rather than failing, so the page can show a
  // setup prompt with a link to Settings.
  if (!cfg.site || !cfg.project) {
    return {
      configured: false,
      site: cfg.site,
      project: cfg.project,
      hoursPerDay: cfg.hoursPerDay ?? DEFAULTS.hoursPerDay,
      defaultLogTime: cfg.defaultLogTime,
      displayName: null,
      timezone: null,
      today: null
    }
  }
  const ctx = await buildCtx(cfg)
  return {
    configured: true,
    displayName: ctx.displayName,
    timezone: ctx.tz,
    hoursPerDay: ctx.hoursPerDay,
    daysPerWeek: ctx.daysPerWeek,
    site: ctx.site,
    project: ctx.project,
    today: localDate(new Date().toISOString(), ctx.tz)
  }
}

// --------------------------------------------------------------- date and zone

function safeZone (tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

/** Jira sends `+1000`; the Date parser wants `+10:00`. */
function parseStamp (stamp) {
  const text = String(stamp || '')
  return new Date(text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
}

function partsIn (stamp, tz) {
  const date = parseStamp(stamp)
  if (Number.isNaN(date.getTime())) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: safeZone(tz),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(p => [p.type, p.value])
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  }
}

export function localDate (stamp, tz) {
  return partsIn(stamp, tz)?.date || null
}

export function localTime (stamp, tz) {
  return partsIn(stamp, tz)?.time || null
}

function iso (day) {
  return `${String(day.y).padStart(4, '0')}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`
}

export function parseIsoDay (value, field) {
  const text = String(value || '').trim().slice(0, 10).replace(/-/g, '')
  if (!/^\d{8}$/.test(text)) {
    throw new TimeLoggerError(`${field} must be YYYY-MM-DD (got ${JSON.stringify(value)})`)
  }
  const y = Number(text.slice(0, 4))
  const m = Number(text.slice(4, 6))
  const d = Number(text.slice(6, 8))
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new TimeLoggerError(`${field} is not a real date (got ${JSON.stringify(value)})`)
  }
  return { y, m, d, iso: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
}

function addDays (day, n) {
  const date = new Date(Date.UTC(day.y, day.m - 1, day.d + n))
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    iso: iso({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() })
  }
}

function dayDiff (first, last) {
  return Math.round((Date.UTC(last.y, last.m - 1, last.d) - Date.UTC(first.y, first.m - 1, first.d)) / 86400000)
}

function isWeekend (day) {
  const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
  return dow === 0 || dow === 6
}

function labelFor (day) {
  const date = new Date(Date.UTC(day.y, day.m - 1, day.d))
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
  }).formatToParts(date)
  const get = type => parts.find(p => p.type === type)?.value || ''
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`
}

/**
 * The offset string (e.g. `+1000`) Jira's `started` field expects. Jira
 * parses `started` as `yyyy-MM-dd'T'HH:mm:ss.SSSZ`, whose `Z` is the RFC 822
 * offset, so the ISO-8601 colon form (`+10:00`) is rejected with "Invalid date
 * format" even though it is valid ISO 8601.
 */
function offsetAt (date, tz) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: safeZone(tz), timeZoneName: 'longOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT'
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name)
  if (!match) return '+0000'
  return `${match[1]}${match[2].padStart(2, '0')}${match[3] || '00'}`
}

/** A new worklog is stamped at the configured time of day on the requested date. */
function startedStamp (day, tz, hhmm) {
  const [hh, mm] = String(hhmm).split(':').map(n => parseInt(n, 10) || 0)
  const guess = new Date(Date.UTC(day.y, day.m - 1, day.d, hh, mm))
  return `${day.iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000${offsetAt(guess, tz)}`
}

// ----------------------------------------------------------------- validation

function cleanTicket (value, project) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TimeLoggerError('ticket is required')
  }
  const key = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) {
    throw new TimeLoggerError(`ticket must look like ${project}-1234 (got ${JSON.stringify(value.trim())})`)
  }
  return key
}

function cleanHours (value, { allowZero = false } = {}) {
  const hours = Number(value)
  if (!Number.isFinite(hours)) {
    throw new TimeLoggerError(`hours must be a number (got ${JSON.stringify(value)})`)
  }
  if (hours < 0 || (hours === 0 && !allowZero)) {
    throw new TimeLoggerError(`hours must be ${allowZero ? '0 or more' : 'greater than 0'}`)
  }
  if (hours > 24) throw new TimeLoggerError(`hours must be at most 24 (got ${hours})`)
  return round2(hours)
}

const round2 = n => Math.round(n * 100) / 100
const g = n => String(round2(n))

function adf (text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

// --------------------------------------------------------------- Jira queries

async function searchWorklogIssues (ctx, firstIso, lastIso) {
  const jql = `project = ${ctx.project} AND worklogAuthor = currentUser() ` +
    `AND worklogDate >= "${firstIso}" AND worklogDate <= "${lastIso}" ORDER BY key`
  const found = {}
  let token
  do {
    const body = { jql, maxResults: 100, fields: ['summary'] }
    if (token) body.nextPageToken = token
    const { data } = await jiraRequest(ctx.site, '/search/jql', { method: 'POST', body })
    for (const issue of data?.issues || []) found[issue.key] = issue.fields?.summary || ''
    token = data?.nextPageToken
    if (!token || data?.isLast) return found
  } while (true)
}

async function fetchWorklogs (ctx, ticket) {
  const items = []
  let start = 0
  while (true) {
    const { data } = await jiraRequest(ctx.site, `/issue/${encodeURIComponent(ticket)}/worklog`, {
      query: { startAt: start, maxResults: 100 }
    })
    const page = data?.worklogs || []
    items.push(...page)
    start += page.length || 1
    if (start >= (data?.total || 0) || !page.length) break
  }
  return items
}

/** The caller's worklog entries on one ticket on one day, oldest first. */
async function myWorklogsOn (ctx, ticket, dayIso, worklogs) {
  const items = worklogs === undefined ? await fetchWorklogs(ctx, ticket) : worklogs
  return items
    .filter(w => w.author?.accountId === ctx.accountId && localDate(w.started, ctx.tz) === dayIso)
    .sort((a, b) => String(a.started).localeCompare(String(b.started)))
}

async function summaryOf (ctx, ticket) {
  const { data } = await jiraRequest(ctx.site, `/issue/${encodeURIComponent(ticket)}`, {
    query: { fields: 'summary' }
  })
  return data?.fields?.summary || ''
}

async function totalSpent (ctx, ticket) {
  const { data } = await jiraRequest(ctx.site, `/issue/${encodeURIComponent(ticket)}`, {
    query: { fields: 'timespent' }
  })
  return (data?.fields?.timespent || 0) / 3600
}

// ---------------------------------------------------------------------- entry

/**
 * Jira v3 returns worklog comments as Atlassian Document Format, not strings.
 * Flatten a node to text for display; the raw ADF is still what the update path
 * re-sends, so nothing here changes what gets written back.
 */
function adfText (node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(adfText).join('')
  switch (node.type) {
    case 'text': return node.text || ''
    case 'hardBreak': return '\n'
    case 'mention': return node.attrs?.text ? `@${node.attrs.text}` : '@'
    case 'emoji': return node.attrs?.shortName || node.attrs?.text || ''
    case 'inlineCard': return node.attrs?.url || ''
    case 'media':
    case 'mediaInline':
    case 'mediaSingle':
    case 'mediaGroup':
      return '[attachment]'
    case 'rule': return '\n'
    case 'bulletList':
    case 'orderedList':
      return (node.content || [])
        .map((item, i) => `${node.type === 'orderedList' ? `${i + 1}.` : '•'} ${adfText(item).trim()}\n`)
        .join('')
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
    case 'panel':
      return `${adfText(node.content)}\n`
    case 'table':
      return `${(node.content || [])
        .map(row => (row.content || []).map(cell => adfText(cell).trim()).join(' | '))
        .join('\n')}\n`
    default:
      return adfText(node.content)
  }
}

/** Plain text of a worklog comment, or null when there is none. */
function commentText (comment) {
  if (!comment) return null
  if (typeof comment === 'string') return comment.trim() || null
  return adfText(comment).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() || null
}

function entry (worklogs, { ticket, summary, site, tz }) {
  const hours = worklogs.reduce((sum, w) => sum + w.timeSpentSeconds, 0) / 3600
  return {
    ticket,
    summary,
    hours: round2(hours),
    url: `${site}/browse/${ticket}`,
    worklogs: worklogs.map(w => ({
      id: w.id,
      hours: round2(w.timeSpentSeconds / 3600),
      started: localTime(w.started, tz),
      comment: commentText(w.comment)
    }))
  }
}

/** The state of one ticket on one day, returned after a write so the UI can refresh. */
async function dayEntry (ctx, ticket, day) {
  const mine = await myWorklogsOn(ctx, ticket, day.iso)
  const result = entry(mine, { ticket, summary: await summaryOf(ctx, ticket), site: ctx.site, tz: ctx.tz })
  result.ticketTotal = round2(await totalSpent(ctx, ticket))
  return result
}

// --------------------------------------------------------------------- writes

async function addWorklog (ctx, ticket, day, hours, comment) {
  const body = { started: startedStamp(day, ctx.tz, ctx.defaultLogTime), timeSpentSeconds: Math.round(hours * 3600) }
  if (comment) body.comment = adf(comment)
  return jiraRequest(ctx.site, `/issue/${encodeURIComponent(ticket)}/worklog`, { method: 'POST', body })
}

/**
 * Make the caller's logged time on `day` for `ticket` exactly `hours`; 0 removes it.
 *
 * The oldest of the caller's entries that day is updated in place — keeping its
 * time of day and, unless `comment` overrides it, its comment — and any others
 * are deleted, so the day ends up carrying a single worklog. Other people's
 * worklogs, and the caller's worklogs on other days, are never touched.
 */
async function setDayTotal (ctx, ticket, day, hours, comment, existing) {
  const items = existing === undefined ? await myWorklogsOn(ctx, ticket, day.iso) : existing
  const events = []

  if (hours === 0) {
    for (const w of items) {
      const { status } = await jiraRequest(ctx.site,
        `/issue/${encodeURIComponent(ticket)}/worklog/${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      events.push([status, `deleted worklog ${w.id} (${g(w.timeSpentSeconds / 3600)}h)`])
    }
    return { events }
  }

  if (!items.length) {
    const created = await addWorklog(ctx, ticket, day, hours, comment)
    events.push([created.status, `created worklog ${created.data?.id ?? ''} (${created.data?.timeSpent ?? ''})`])
    return { events }
  }

  const keep = items[0]
  const body = { started: keep.started, timeSpentSeconds: Math.round(hours * 3600) }
  // A PUT can drop fields it does not carry, so re-send the existing comment
  // unless the caller supplied a new one.
  if (comment) body.comment = adf(comment)
  else if (keep.comment) body.comment = keep.comment
  const updated = await jiraRequest(ctx.site,
    `/issue/${encodeURIComponent(ticket)}/worklog/${encodeURIComponent(keep.id)}`, { method: 'PUT', body })
  events.push([updated.status, `worklog ${keep.id} set to ${updated.data?.timeSpent ?? ''}`])

  for (const w of items.slice(1)) {
    const { status } = await jiraRequest(ctx.site,
      `/issue/${encodeURIComponent(ticket)}/worklog/${encodeURIComponent(w.id)}`, { method: 'DELETE' })
    events.push([status, `deleted extra worklog ${w.id} (${g(w.timeSpentSeconds / 3600)}h)`])
  }
  return { events }
}

// -------------------------------------------------------------------- reports

async function rangeDays (ctx, first, last) {
  const issues = await searchWorklogIssues(ctx, first.iso, last.iso)
  const keys = Object.keys(issues).sort()
  const fetched = await mapLimit(keys, DEFAULTS.workers, async key => ({
    key, worklogs: await fetchWorklogs(ctx, key)
  }))

  const buckets = new Map() // day ISO -> Map(ticket -> [worklogs])
  for (const { key, worklogs } of fetched) {
    for (const w of worklogs) {
      if (w.author?.accountId !== ctx.accountId) continue
      const day = localDate(w.started, ctx.tz)
      if (!day || day < first.iso || day > last.iso) continue
      if (!buckets.has(day)) buckets.set(day, new Map())
      const perTicket = buckets.get(day)
      if (!perTicket.has(key)) perTicket.set(key, [])
      perTicket.get(key).push(w)
    }
  }

  const days = []
  const span = dayDiff(first, last) + 1
  for (let n = 0; n < span; n++) {
    const day = addDays(first, n)
    const perTicket = buckets.get(day.iso) || new Map()
    const entries = [...perTicket.entries()]
      .map(([ticket, worklogs]) => entry(
        worklogs.sort((a, b) => String(a.started).localeCompare(String(b.started))),
        { ticket, summary: issues[ticket] || '', site: ctx.site, tz: ctx.tz }
      ))
      .sort((a, b) => b.hours - a.hours || a.ticket.localeCompare(b.ticket))
    days.push({
      date: day.iso,
      label: labelFor(day),
      weekend: isWeekend(day),
      total: round2(entries.reduce((sum, e) => sum + e.hours, 0)),
      entries
    })
  }
  return days
}

export async function rangeReport (from, to) {
  const cfg = await config()
  requireConfig(cfg)
  // Validate before touching Jira so a typo does not cost two API calls.
  let first = parseIsoDay(from, 'from')
  let last = parseIsoDay(to, 'to')
  if (last.iso < first.iso) [first, last] = [last, first]
  if (dayDiff(first, last) + 1 > DEFAULTS.maxRangeDays) {
    throw new TimeLoggerError(`range is longer than ${DEFAULTS.maxRangeDays} days; pick a shorter one`)
  }
  const ctx = await buildCtx(cfg)
  const days = await rangeDays(ctx, first, last)
  return {
    from: first.iso,
    to: last.iso,
    hoursPerDay: ctx.hoursPerDay,
    total: round2(days.reduce((sum, d) => sum + d.total, 0)),
    days
  }
}

// ------------------------------------------------------------------- endpoints

/** Insert: add `hours` on top of whatever is already logged. */
export async function insertWorklog ({ ticket, date, hours, comment }) {
  const cfg = await config()
  requireConfig(cfg)
  const key = cleanTicket(ticket, cfg.project)
  const day = parseIsoDay(date, 'date')
  const amount = cleanHours(hours)
  const note = typeof comment === 'string' ? comment.trim() || null : null
  const ctx = await buildCtx(cfg)
  const created = await addWorklog(ctx, key, day, amount, note)
  return {
    action: 'insert',
    events: [`HTTP ${created.status} - created worklog ${created.data?.id ?? ''} (${created.data?.timeSpent ?? ''})`],
    entry: await dayEntry(ctx, key, day)
  }
}

/** Update: make the day's total for this ticket exactly `hours` (0 deletes). */
export async function updateWorklog ({ ticket, date, hours, comment }) {
  const cfg = await config()
  requireConfig(cfg)
  const key = cleanTicket(ticket, cfg.project)
  const day = parseIsoDay(date, 'date')
  const amount = cleanHours(hours, { allowZero: true })
  const note = typeof comment === 'string' ? comment.trim() || null : null
  const ctx = await buildCtx(cfg)
  const { events } = await setDayTotal(ctx, key, day, amount, note)
  return {
    action: 'update',
    events: events.length
      ? events.map(([code, what]) => `HTTP ${code} - ${what}`)
      : ['nothing logged that day; no change'],
    entry: await dayEntry(ctx, key, day)
  }
}
