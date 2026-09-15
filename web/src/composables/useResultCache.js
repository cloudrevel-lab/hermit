/**
 * Snapshot of an expensive, user-run page result, so a reload shows what was
 * already computed instead of asking for it again.
 *
 * sessionStorage, not localStorage: a wide comparison can carry hundreds of
 * commits, and localStorage is a small quota shared with the remembered
 * selections. sessionStorage survives a reload — which is the promise this
 * makes — and is discarded with the tab. Entries are keyed by the request
 * signature, so a snapshot is only ever served back for matching inputs.
 */
const PREFIX = 'hermit:cache:'

// One comparison of a big release can serialise to a few hundred kilobytes.
// Above this the entry is dropped rather than risk evicting the rest of the
// tab's storage; the page then behaves as if nothing had been cached.
const MAX_BYTES = 1_500_000

// Branch names move, so a branch-keyed snapshot is only trustworthy for a
// while. Past this a reload recomputes rather than showing day-old commits.
const MAX_AGE_MS = 24 * 60 * 60 * 1000

function storageKey (key) {
  return PREFIX + key
}

/** Drops snapshots that have aged out, to free quota for a fresh one. */
function pruneStale () {
  try {
    const now = Date.now()
    const stale = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const name = sessionStorage.key(i)
      if (!name?.startsWith(PREFIX)) continue
      let keep = false
      try {
        const entry = JSON.parse(sessionStorage.getItem(name))
        keep = entry && typeof entry.fetchedAt === 'string' &&
          now - Date.parse(entry.fetchedAt) <= MAX_AGE_MS
      } catch { /* an unreadable entry is dropped */ }
      if (!keep) stale.push(name)
    }
    for (const name of stale) sessionStorage.removeItem(name)
  } catch { /* storage unavailable; nothing to prune */ }
}

/** Returns `{ data, fetchedAt }` for a live snapshot, or null. */
export function readCachedResult (key) {
  if (!key) return null
  try {
    const raw = sessionStorage.getItem(storageKey(key))
    if (raw === null) return null
    const entry = JSON.parse(raw)
    if (!entry || typeof entry.fetchedAt !== 'string' || !('data' in entry)) return null
    if (Date.now() - Date.parse(entry.fetchedAt) > MAX_AGE_MS) {
      sessionStorage.removeItem(storageKey(key))
      return null
    }
    return entry
  } catch {
    return null
  }
}

/** Stores `data` and returns whether it fit. Never throws. */
export function writeCachedResult (key, data) {
  if (!key) return false
  try {
    const raw = JSON.stringify({ data, fetchedAt: new Date().toISOString() })
    if (raw.length > MAX_BYTES) return false
    try {
      sessionStorage.setItem(storageKey(key), raw)
      return true
    } catch {
      // Usually the quota. Drop aged-out snapshots and try once more; if it
      // still fails, having no cache is not worth interrupting the user.
      pruneStale()
      sessionStorage.setItem(storageKey(key), raw)
      return true
    }
  } catch {
    return false
  }
}

export function clearCachedResult (key) {
  try {
    if (key) sessionStorage.removeItem(storageKey(key))
  } catch { /* nothing to clean up */ }
}
