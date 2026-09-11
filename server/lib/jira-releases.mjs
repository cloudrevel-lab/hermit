import { randomUUID } from 'node:crypto'
import { getDb } from './db.mjs'
import { ProviderError } from './provider-error.mjs'

/**
 * Pinned Jira Fix Versions. Stored by name rather than id: the name is what a
 * user reads off a ticket, and it is what the JQL matches, so a release can be
 * added before anyone has looked up its numeric id.
 */
export async function listReleases () {
  const db = await getDb()
  return db.data.jiraReleases
}

export async function addRelease ({ name, projectKey = '', host = '' }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new ProviderError('A Fix Version name is required', { status: 400 })

  const db = await getDb()
  const exists = db.data.jiraReleases.some(r =>
    r.name.toLowerCase() === trimmed.toLowerCase() && r.host === host)
  if (exists) throw new ProviderError(`"${trimmed}" is already pinned`, { status: 409 })

  const release = {
    id: randomUUID(),
    name: trimmed,
    projectKey: String(projectKey || '').trim(),
    host,
    createdAt: new Date().toISOString()
  }
  db.data.jiraReleases.push(release)
  await db.write()
  return release
}

export async function findRelease (id) {
  return (await listReleases()).find(r => r.id === id) || null
}

export async function deleteRelease (id) {
  const db = await getDb()
  const index = db.data.jiraReleases.findIndex(r => r.id === id)
  if (index === -1) return false
  db.data.jiraReleases.splice(index, 1)
  await db.write()
  return true
}
