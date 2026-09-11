import { Router } from 'express'
import { addRepo, deleteRepo, listRepos, publicRepo, updateRepo } from '../lib/repos.mjs'
import { pluginForUrl, providerSummaries } from '../plugins/index.mjs'
import { dropCache } from '../lib/cache.mjs'

export const reposRouter = Router()

reposRouter.get('/', async (req, res, next) => {
  try {
    const repos = await listRepos()
    res.json({ repos: await Promise.all(repos.map(publicRepo)) })
  } catch (err) { next(err) }
})

/** Installed providers, so the UI can label repos and explain credentials. */
reposRouter.get('/providers', async (req, res, next) => {
  try {
    res.json({ providers: await providerSummaries() })
  } catch (err) { next(err) }
})

/** Identifies the provider from a pasted URL and confirms the repo is readable. */
reposRouter.post('/probe', async (req, res, next) => {
  try {
    const { plugin, url } = await pluginForUrl(req.body?.url)
    const coords = plugin.parseUrl(url)
    const info = await plugin.getRepository(coords)
    res.json({
      ok: true,
      provider: { id: plugin.id, name: plugin.name, icon: plugin.icon, capabilities: plugin.capabilities },
      described: plugin.describe(coords),
      info
    })
  } catch (err) { next(err) }
})

reposRouter.post('/', async (req, res, next) => {
  try {
    res.status(201).json({ repo: await publicRepo(await addRepo(req.body || {})) })
  } catch (err) { next(err) }
})

reposRouter.put('/:id', async (req, res, next) => {
  try {
    const repo = await updateRepo(req.params.id, req.body || {})
    if (!repo) return res.status(404).json({ error: 'No such repository' })
    await dropCache(`refs:${req.params.id}`)
    res.json({ repo: await publicRepo(repo) })
  } catch (err) { next(err) }
})

reposRouter.delete('/:id', async (req, res, next) => {
  try {
    const removed = await deleteRepo(req.params.id)
    if (!removed) return res.status(404).json({ error: 'No such repository' })
    await dropCache(`refs:${req.params.id}`)
    res.status(204).end()
  } catch (err) { next(err) }
})
