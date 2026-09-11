import { JSONFilePreset } from 'lowdb/node'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './db.mjs'

let cachePromise = null

async function store () {
  cachePromise ??= (async () => {
    await mkdir(DATA_DIR, { recursive: true })
    return JSONFilePreset(join(DATA_DIR, 'cache.json'), { entries: {} })
  })()
  return cachePromise
}

/**
 * Read-through cache on a JSON file.
 *
 * Commit ranges are keyed by the two commit SHAs, so an entry can never go
 * stale — a moved branch tip produces a different key. Those use a long ttl.
 * Ref listings are keyed by branch name and use a short ttl.
 */
export async function cached (key, ttlMs, produce) {
  const db = await store()
  const hit = db.data.entries[key]
  const now = Date.now()
  if (hit && now - hit.at < ttlMs) {
    return { value: hit.value, cached: true, at: hit.at }
  }
  const value = await produce()
  db.data.entries[key] = { at: now, value }
  await db.write()
  return { value, cached: false, at: now }
}

export async function dropCache (prefix = '') {
  const db = await store()
  let removed = 0
  for (const key of Object.keys(db.data.entries)) {
    if (!prefix || key.startsWith(prefix)) {
      delete db.data.entries[key]
      removed++
    }
  }
  await db.write()
  return removed
}

export async function cacheStats () {
  const db = await store()
  const keys = Object.keys(db.data.entries)
  const oldest = keys.reduce((min, k) => Math.min(min, db.data.entries[k].at), Infinity)
  return {
    entries: keys.length,
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    bytes: Buffer.byteLength(JSON.stringify(db.data))
  }
}

export const TTL = {
  refs: 2 * 60 * 1000,          // branch tips move often
  range: 30 * 24 * 60 * 60 * 1000, // SHA-keyed, effectively immutable
  jira: 10 * 60 * 1000
}
