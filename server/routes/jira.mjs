import { Router } from 'express'
import {
  extractIssueKeys, getVersion, issuesByKeys, issuesForVersion,
  issuesForVersionName, listProjectVersions, parseJiraUrl
} from '../lib/jira.mjs'
import { addRelease, deleteRelease, findRelease, listReleases } from '../lib/jira-releases.mjs'
import { cached, TTL } from '../lib/cache.mjs'
import { getDb } from '../lib/db.mjs'

export const jiraRouter = Router()

async function jiraHost (explicit) {
  if (explicit) return parseJiraUrl(explicit).host
  const db = await getDb()
  const configured = db.data.settings.jiraBaseUrl
  if (!configured) {
    const err = new Error('No Jira site configured')
    err.status = 400
    err.hint = 'Set the Jira base URL in Settings, or paste a full release URL.'
    throw err
  }
  return parseJiraUrl(configured).host
}

/** Issues attached to a fixVersion, from a pasted release-report URL or an id. */
jiraRouter.post('/version', async (req, res, next) => {
  try {
    const { url, versionId: rawId, refresh } = req.body || {}
    const parsed = url ? parseJiraUrl(url) : {}
    const host = parsed.host || await jiraHost()
    const versionId = parsed.versionId || rawId
    if (!versionId) return res.status(400).json({ error: 'A Jira version id or release URL is required' })

    const { value, cached: fromCache } = await cached(
      `jira:version:${host}:${versionId}`,
      refresh ? 0 : TTL.jira,
      async () => ({
        version: await getVersion(host, versionId),
        issues: await issuesForVersion(host, versionId)
      })
    )
    res.json({ host, ...value, cached: fromCache })
  } catch (err) { next(err) }
})

/** Looks up the issue keys mentioned in a set of commit messages. */
jiraRouter.post('/issues', async (req, res, next) => {
  try {
    const { keys, messages, url, refresh } = req.body || {}
    const host = url ? parseJiraUrl(url).host : await jiraHost()
    const db = await getDb()
    const pattern = db.data.settings.issueKeyPattern

    const wanted = new Set(keys || [])
    for (const message of messages || []) {
      for (const key of extractIssueKeys(message, pattern)) wanted.add(key)
    }
    const list = [...wanted].sort()
    if (!list.length) return res.json({ host, issues: [] })

    const { value, cached: fromCache } = await cached(
      `jira:issues:${host}:${list.join(',')}`,
      refresh ? 0 : TTL.jira,
      () => issuesByKeys(host, list)
    )
    res.json({ host, issues: value, cached: fromCache })
  } catch (err) { next(err) }
})

/** Fix Versions defined on a project, for the picker. */
jiraRouter.get('/versions', async (req, res, next) => {
  try {
    const host = await jiraHost(req.query.url)
    const db = await getDb()
    const projectKey = req.query.project || db.data.settings.jiraProjectKey
    if (!projectKey) {
      return res.status(400).json({
        error: 'No Jira project key',
        hint: 'Set a default project key in Settings, or pass ?project=KEY.'
      })
    }
    const { value, cached: fromCache } = await cached(
      `jira:versions:${host}:${projectKey}`,
      req.query.refresh === '1' ? 0 : TTL.jira,
      () => listProjectVersions(host, projectKey)
    )
    res.json({ host, projectKey, versions: value, cached: fromCache })
  } catch (err) { next(err) }
})

jiraRouter.get('/releases', async (req, res, next) => {
  try {
    res.json({ releases: await listReleases() })
  } catch (err) { next(err) }
})

jiraRouter.post('/releases', async (req, res, next) => {
  try {
    const db = await getDb()
    const host = await jiraHost(req.body?.url)
    const release = await addRelease({
      name: req.body?.name,
      projectKey: req.body?.projectKey || db.data.settings.jiraProjectKey,
      host
    })
    res.status(201).json({ release })
  } catch (err) { next(err) }
})

jiraRouter.delete('/releases/:id', async (req, res, next) => {
  try {
    const removed = await deleteRelease(req.params.id)
    if (!removed) return res.status(404).json({ error: 'No such release' })
    res.status(204).end()
  } catch (err) { next(err) }
})

/** The tickets carrying this Fix Version, plus the version's own metadata. */
jiraRouter.get('/releases/:id/issues', async (req, res, next) => {
  try {
    const release = await findRelease(req.params.id)
    if (!release) return res.status(404).json({ error: 'No such release' })

    const host = release.host || await jiraHost()
    const refresh = req.query.refresh === '1'
    const { value, cached: fromCache, at } = await cached(
      `jira:fixversion:${host}:${release.name}`,
      refresh ? 0 : TTL.jira,
      async () => {
        const issues = await issuesForVersionName(host, release.name)
        // Metadata (release date, released flag) only exists if the name
        // matches a real version; a typo simply yields no issues and no meta.
        let meta = null
        if (release.projectKey) {
          const versions = await listProjectVersions(host, release.projectKey).catch(() => [])
          meta = versions.find(v => v.name === release.name) || null
        }
        return { issues, meta }
      }
    )
    res.json({
      host,
      release,
      ...value,
      cached: fromCache,
      fetchedAt: new Date(at).toISOString()
    })
  } catch (err) { next(err) }
})
