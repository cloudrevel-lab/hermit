import { Router } from 'express'
import { authStatus, invalidateAuthinfo } from '../lib/authinfo.mjs'
import { cacheStats, dropCache } from '../lib/cache.mjs'
import { getDb } from '../lib/db.mjs'
import { corpFetch, remove as removeCert, save as saveCert, status as certStatus } from '../lib/corp-cert.mjs'

export const systemRouter = Router()

systemRouter.get('/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, uptime: process.uptime() })
})

systemRouter.get('/auth', async (req, res, next) => {
  try {
    if (req.query.refresh === '1') invalidateAuthinfo()
    res.json(await authStatus())
  } catch (err) { next(err) }
})

systemRouter.get('/settings', async (req, res) => {
  const db = await getDb()
  res.json({ settings: db.data.settings })
})

systemRouter.put('/settings', async (req, res) => {
  const db = await getDb()
  db.data.settings = { ...db.data.settings, ...(req.body || {}) }
  await db.write()
  res.json({ settings: db.data.settings })
})

systemRouter.get('/cache', async (req, res) => {
  res.json(await cacheStats())
})

systemRouter.delete('/cache', async (req, res) => {
  res.json({ removed: await dropCache(req.query.prefix || '') })
})

systemRouter.get('/cert', async (req, res, next) => {
  try {
    res.json(await certStatus())
  } catch (err) { next(err) }
})

systemRouter.put('/cert', async (req, res, next) => {
  try {
    const pem = req.body?.pem
    if (!pem || typeof pem !== 'string') {
      return res.status(400).json({ error: 'No certificate was uploaded' })
    }
    await saveCert(pem)
    res.json(await certStatus())
  } catch (err) { next(err) }
})

systemRouter.delete('/cert', async (req, res, next) => {
  try {
    await removeCert()
    res.json(await certStatus())
  } catch (err) { next(err) }
})

/**
 * Try a real HTTPS request so the user can tell a fixed certificate from a
 * still-broken one without leaving the Settings page.
 */
systemRouter.post('/cert/test', async (req, res, next) => {
  try {
    const db = await getDb()
    const target = req.body?.url || db.data.settings.jiraBaseUrl || db.data.settings.timeLoggerSite
    if (!target) {
      return res.status(400).json({ error: 'Set a Jira base URL first, so there is something to test against' })
    }
    let url
    try {
      url = new URL(target.includes('://') ? target : `https://${target}`)
    } catch {
      return res.status(400).json({ error: `Not a valid URL: ${target}` })
    }
    try {
      // HEAD is enough to complete the handshake, and needs no credentials.
      const response = await corpFetch(url.origin, { method: 'HEAD' })
      res.json({ ok: true, host: url.host, status: response.status })
    } catch (err) {
      const code = err.cause?.code || err.code || null
      res.json({ ok: false, host: url.host, code, error: err.cause?.message || err.message })
    }
  } catch (err) { next(err) }
})
