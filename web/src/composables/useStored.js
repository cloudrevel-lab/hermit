const PREFIX = 'hermit:'

/**
 * Small wrapper over localStorage for remembered UI selections.
 *
 * Every access is guarded: storage does not merely return null when
 * unavailable, it throws outright in private windows and when site data is
 * blocked, and a remembered dropdown is never worth breaking a page over.
 */
export function readStored (key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeStored (key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Not being able to remember the choice is not worth interrupting the user.
  }
}

export function clearStored (key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch { /* nothing to clean up */ }
}
