import { Router } from 'express'
import { authStatus, invalidateAuthinfo } from '../lib/authinfo.mjs'
import { cacheStats, dropCache } from '../lib/cache.mjs'
import { getDb } from '../lib/db.mjs'

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
