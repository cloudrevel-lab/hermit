import { randomUUID } from 'node:crypto'
import { getDb } from './db.mjs'
import { pluginForRepo, pluginForUrl } from '../plugins/index.mjs'
import { ProviderError } from './provider-error.mjs'

/**
 * A stored repository keeps the provider id plus an opaque `coords` blob that
 * only that provider understands — Azure needs org/project/repo, GitHub needs
 * owner/repo. Nothing outside a plugin should read inside `coords`.
 */
export async function buildRepo (input, existing = {}) {
  const { plugin, url } = await pluginForUrl(input.url)
  const coords = plugin.parseUrl(url)
  const described = plugin.describe(coords)

  return {
    id: existing.id || randomUUID(),
    name: (input.name || '').trim() || described.name,
    provider: plugin.id,
    url: plugin.repoWebUrl(coords),
    host: coords.host,
    coords,
    enabled: input.enabled ?? existing.enabled ?? true,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

/**
 * Records written before providers existed were all Azure DevOps and stored
 * org/project/repo at the top level. Fold them into the current shape on read.
 */
function migrate (repo) {
  if (repo.provider && repo.coords) return repo
  const { org, project, repo: name, ...rest } = repo
  return {
    ...rest,
    provider: 'azure-devops',
    coords: { host: repo.host, org, project, repo: name }
  }
}

export async function listRepos () {
  const db = await getDb()
  let changed = false
  db.data.repos = db.data.repos.map(repo => {
    const migrated = migrate(repo)
    if (migrated !== repo) changed = true
    return migrated
  })
  if (changed) await db.write()
  return db.data.repos
}

export async function findRepo (id) {
  return (await listRepos()).find(r => r.id === id) || null
}

export async function requireRepo (id) {
  const repo = await findRepo(id)
  if (!repo) throw new ProviderError('No such repository', { status: 404 })
  return repo
}

/** The repo plus the plugin that knows how to talk to it. */
export async function repoWithPlugin (id) {
  const repo = await requireRepo(id)
  return { repo, plugin: await pluginForRepo(repo) }
}

async function assertUnique (repos, repo) {
  const clash = repos.find(r => r.id !== repo.id && r.url.toLowerCase() === repo.url.toLowerCase())
  if (clash) throw new ProviderError('That repository is already in the list', { status: 409 })
}

export async function addRepo (input) {
  const db = await getDb()
  const repo = await buildRepo(input)
  await assertUnique(await listRepos(), repo)
  db.data.repos.push(repo)
  await db.write()
  return repo
}

export async function updateRepo (id, input) {
  const db = await getDb()
  const repos = await listRepos()
  const index = repos.findIndex(r => r.id === id)
  if (index === -1) return null
  const existing = repos[index]
  const repo = await buildRepo({ url: input.url ?? existing.url, name: input.name, enabled: input.enabled }, existing)
  await assertUnique(repos, repo)
  db.data.repos[index] = repo
  await db.write()
  return repo
}

export async function deleteRepo (id) {
  const db = await getDb()
  await listRepos()
  const index = db.data.repos.findIndex(r => r.id === id)
  if (index === -1) return false
  db.data.repos.splice(index, 1)
  await db.write()
  return true
}

export async function enabledRepos () {
  return (await listRepos()).filter(r => r.enabled)
}

/** Repo fields safe to hand the browser: no coords internals it should rely on. */
export async function publicRepo (repo) {
  const plugin = await pluginForRepo(repo).catch(() => null)
  const described = plugin ? plugin.describe(repo.coords) : { namespace: repo.host, name: repo.name }
  return {
    id: repo.id,
    name: repo.name,
    provider: repo.provider,
    providerName: plugin?.name || repo.provider,
    providerIcon: plugin?.icon || 'mdi-source-repository',
    capabilities: plugin?.capabilities || {},
    host: repo.host,
    namespace: described.namespace,
    repo: described.name,
    url: repo.url,
    enabled: repo.enabled
  }
}
