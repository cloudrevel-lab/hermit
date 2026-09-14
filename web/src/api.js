async function call (path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  if (res.status === 204) return null
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(payload.error || `Request failed (${res.status})`)
    err.hint = payload.hint
    err.status = res.status
    throw err
  }
  return payload
}

export const api = {
  health: () => call('/health'),
  auth: (refresh) => call(`/auth${refresh ? '?refresh=1' : ''}`),

  settings: () => call('/settings'),
  saveSettings: (settings) => call('/settings', { method: 'PUT', body: settings }),

  cert: () => call('/cert'),
  uploadCert: (pem) => call('/cert', { method: 'PUT', body: { pem } }),
  deleteCert: () => call('/cert', { method: 'DELETE' }),
  testCert: (url) => call('/cert/test', { method: 'POST', body: { url } }),

  cacheStats: () => call('/cache'),
  clearCache: (prefix) => call(`/cache${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`, { method: 'DELETE' }),

  repos: () => call('/repos'),
  providers: () => call('/repos/providers'),
  probeRepo: (url) => call('/repos/probe', { method: 'POST', body: { url } }),
  addRepo: (repo) => call('/repos', { method: 'POST', body: repo }),
  updateRepo: (id, repo) => call(`/repos/${id}`, { method: 'PUT', body: repo }),
  deleteRepo: (id) => call(`/repos/${id}`, { method: 'DELETE' }),
  branches: (id, refresh) => call(`/git/repos/${id}/branches${refresh ? '?refresh=1' : ''}`),

  releases: (refresh) => call(`/git/releases${refresh ? '?refresh=1' : ''}`),
  compare: (payload) => call('/git/compare', { method: 'POST', body: payload }),
  compareRefs: (payload) => call('/git/compare-refs', { method: 'POST', body: payload }),
  cherryPick: (payload) => call('/git/cherry-pick', { method: 'POST', body: payload }),

  jiraVersion: (payload) => call('/jira/version', { method: 'POST', body: payload }),
  jiraProjectVersions: (refresh) => call(`/jira/versions${refresh ? '?refresh=1' : ''}`),
  jiraReleases: () => call('/jira/releases'),
  addJiraRelease: (payload) => call('/jira/releases', { method: 'POST', body: payload }),
  deleteJiraRelease: (id) => call(`/jira/releases/${id}`, { method: 'DELETE' }),
  jiraReleaseIssues: (id, refresh) => call(`/jira/releases/${id}/issues${refresh ? '?refresh=1' : ''}`),
  jiraIssues: (payload) => call('/jira/issues', { method: 'POST', body: payload }),

  timeLoggerContext: () => call('/time-logger/context'),
  timeLoggerRange: (from, to) =>
    call(`/time-logger/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  // Add hours on top of what is already logged.
  timeLoggerInsert: (payload) => call('/time-logger/worklog', { method: 'POST', body: payload }),
  // Make the day's total for the ticket exactly `hours` (0 deletes it).
  timeLoggerUpdate: (payload) => call('/time-logger/worklog', { method: 'PUT', body: payload }),
  // Retime one worklog, leaving the day's other entries for that ticket alone.
  timeLoggerUpdateEntry: (id, payload) =>
    call(`/time-logger/worklog/${encodeURIComponent(id)}`, { method: 'PUT', body: payload }),
  // Remove one worklog. The ticket and date travel in the query so the server can
  // check the id really is the caller's own entry on that day.
  timeLoggerDeleteEntry: (id, { ticket, date }) =>
    call(
      `/time-logger/worklog/${encodeURIComponent(id)}` +
        `?ticket=${encodeURIComponent(ticket)}&date=${encodeURIComponent(date)}`,
      { method: 'DELETE' }
    )
}
