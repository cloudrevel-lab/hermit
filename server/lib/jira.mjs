import { credentialFor } from './authinfo.mjs'
import { corpFetch, trustHint } from './corp-cert.mjs'

export class JiraError extends Error {
  constructor (message, { status = 502, hint } = {}) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

/** Accepts a site host, a browse URL, or a release-report URL. */
export function parseJiraUrl (input) {
  const raw = String(input || '').trim()
  if (!raw) throw new JiraError('A Jira URL is required', { status: 400 })
  let url
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new JiraError('Not a valid Jira URL', { status: 400 })
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const projectKey = segments[segments.indexOf('projects') + 1] || null
  const versionIdx = segments.indexOf('versions')
  const versionId = versionIdx !== -1 ? segments[versionIdx + 1] : null
  return { host: url.hostname.toLowerCase(), projectKey, versionId }
}

async function authHeader (host) {
  const cred = await credentialFor(host)
  if (!cred?.password || !cred?.login) {
    throw new JiraError(`No credential for ${host} in ~/.authinfo`, {
      status: 401,
      hint: `Add a line to ~/.authinfo:\n  machine ${host} login <you@example.com> password <jira-api-token>\nCreate a token at https://id.atlassian.com/manage-profile/security/api-tokens`
    })
  }
  return 'Basic ' + Buffer.from(`${cred.login}:${cred.password}`).toString('base64')
}

async function request (host, path, params = {}) {
  const url = new URL(`https://${host}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  let res
  try {
    res = await corpFetch(url, {
      headers: { Authorization: await authHeader(host), Accept: 'application/json' }
    })
  } catch (cause) {
    // Without this the caller sees a bare TypeError: fetch failed, which hides
    // the OpenSSL code that says a corporate proxy is re-signing the chain.
    throw new JiraError(`Cannot reach ${host}: ${cause.cause?.code || cause.message}`, {
      status: 502,
      hint: trustHint(cause)
    })
  }
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = null }
  if (!res.ok) {
    const detail = body?.errorMessages?.join(' ') || body?.message || text.slice(0, 200)
    throw new JiraError(detail || `Jira responded ${res.status}`, {
      status: res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 401 : 502
    })
  }
  return body
}

export async function getVersion (host, versionId) {
  const v = await request(host, `/rest/api/3/version/${encodeURIComponent(versionId)}`)
  return {
    id: v.id,
    name: v.name,
    description: v.description || null,
    released: Boolean(v.released),
    releaseDate: v.releaseDate || null,
    projectId: v.projectId
  }
}

function normaliseIssue (host, issue) {
  const f = issue.fields || {}
  return {
    key: issue.key,
    summary: f.summary || '',
    status: f.status?.name || null,
    statusCategory: f.status?.statusCategory?.key || null,
    type: f.issuetype?.name || null,
    assignee: f.assignee?.displayName || null,
    priority: f.priority?.name || null,
    resolution: f.resolution?.name || null,
    url: `https://${host}/browse/${issue.key}`
  }
}

const FIELDS = 'summary,status,issuetype,assignee,priority,resolution'

async function searchJql (host, jql) {
  const issues = []
  let nextPageToken
  do {
    const body = await request(host, '/rest/api/3/search/jql', {
      jql,
      fields: FIELDS,
      maxResults: 100,
      nextPageToken
    })
    for (const issue of body.issues || []) issues.push(normaliseIssue(host, issue))
    nextPageToken = body.nextPageToken
  } while (nextPageToken)
  return issues
}

export async function issuesForVersion (host, versionId) {
  return searchJql(host, `fixVersion = ${Number(versionId)} ORDER BY key ASC`)
}

/**
 * JQL string literals are double-quoted, so a version name containing a quote
 * or backslash has to be escaped or the query is rejected as malformed.
 * Real names like `My Next Release` also need the quoting
 * because of the spaces and parentheses.
 */
function jqlString (value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Issues whose Fix Version field matches this name. */
export async function issuesForVersionName (host, name) {
  return searchJql(host, `fixVersion = ${jqlString(name)} ORDER BY key ASC`)
}

/** Every Fix Version defined on a project, newest first, for the picker. */
export async function listProjectVersions (host, projectKey) {
  const versions = await request(host, `/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`)
  return (versions || [])
    .map(v => ({
      id: v.id,
      name: v.name,
      description: v.description || null,
      released: Boolean(v.released),
      archived: Boolean(v.archived),
      releaseDate: v.releaseDate || null
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || b.id.localeCompare(a.id))
}

export async function issuesByKeys (host, keys) {
  const unique = [...new Set(keys)].filter(Boolean)
  if (!unique.length) return []
  const found = []
  // JQL has a practical limit on `in` list length, so page through in chunks.
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80)
    try {
      found.push(...await searchJql(host, `key in (${chunk.join(',')})`))
    } catch (err) {
      // Keys parsed out of commit messages may not exist in Jira at all;
      // an unknown key makes the whole chunk fail, so fall back to per-key.
      if (err.status !== 400) throw err
      for (const key of chunk) {
        try { found.push(...await searchJql(host, `key = ${key}`)) } catch { /* not a real issue */ }
      }
    }
  }
  return found
}

export function extractIssueKeys (text, pattern = '[A-Z][A-Z0-9]+-\\d+') {
  const matches = String(text || '').match(new RegExp(pattern, 'g')) || []
  return [...new Set(matches)]
}
