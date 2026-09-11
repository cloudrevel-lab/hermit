import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { badRequest } from '../lib/provider-error.mjs'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

const REQUIRED = [
  'id', 'name', 'matchesUrl', 'parseUrl', 'describe', 'credentialHint',
  'repoWebUrl', 'branchWebUrl', 'commitWebUrl',
  'getRepository', 'listBranches', 'listCommitsBetween'
]

let registry = null

/**
 * Every directory here holding an index.mjs is a provider. Adding Bitbucket
 * means dropping in server/plugins/bitbucket/index.mjs — nothing else in the
 * codebase needs to learn about it.
 */
async function discover () {
  const entries = await readdir(PLUGIN_DIR, { withFileTypes: true })
  const plugins = new Map()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(PLUGIN_DIR, entry.name, 'index.mjs')
    let module
    try {
      module = await import(pathToFileURL(path).href)
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') continue
      console.error(`[plugins] ${entry.name} failed to load:`, err.message)
      continue
    }

    const plugin = module.default
    const missing = REQUIRED.filter(key => typeof plugin?.[key] === 'undefined')
    if (missing.length) {
      console.error(`[plugins] ${entry.name} is missing: ${missing.join(', ')}`)
      continue
    }
    plugin.capabilities = { pullRequests: false, diffCounts: false, cherryPick: false, pullRequestWrites: false, ...plugin.capabilities }
    plugins.set(plugin.id, plugin)
  }

  return plugins
}

export async function plugins () {
  registry ??= discover()
  return registry
}

export async function allPlugins () {
  return [...(await plugins()).values()]
}

export async function pluginById (id) {
  return (await plugins()).get(id) || null
}

/** Picks the provider that recognises a pasted URL. */
export async function pluginForUrl (input) {
  const raw = String(input || '').trim()
  if (!raw) throw badRequest('A repository URL is required')

  let url
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw badRequest('That is not a valid URL')
  }
  url.username = ''
  url.password = ''   // clone URLs carry credentials

  for (const plugin of await allPlugins()) {
    if (plugin.matchesUrl(url)) return { plugin, url }
  }

  const names = (await allPlugins()).map(p => `${p.name} (${p.urlExample})`).join('\n  ')
  throw badRequest(`No provider recognises ${url.hostname}`, `Supported providers:\n  ${names}`)
}

export async function pluginForRepo (repo) {
  const plugin = await pluginById(repo.provider)
  if (!plugin) {
    throw badRequest(
      `Repository "${repo.name}" uses provider "${repo.provider}", which is not installed`,
      'The plugin may have been removed from server/plugins.'
    )
  }
  return plugin
}

/** Shape sent to the browser so the UI can label and explain each provider. */
export async function providerSummaries () {
  return (await allPlugins()).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon || 'mdi-source-repository',
    color: p.color || null,
    urlExample: p.urlExample || '',
    capabilities: p.capabilities,
    credential: p.credentialHint('<host>')
  }))
}
