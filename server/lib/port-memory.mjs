import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './db.mjs'

/**
 * The port the app last bound to.
 *
 * Binding to port 0 lets the OS pick, which never collides but hands the user a
 * different URL every restart — bookmarks and open tabs go stale. Remembering
 * the last port and asking for it first keeps the URL stable across restarts
 * while still stepping aside when something else has taken it.
 *
 * This is machine-local state, so it lives beside the database rather than in
 * it: db.json travels between machines through backup and restore, and a port
 * from another machine is not worth carrying.
 */
export const PORT_MEMORY_PATH = join(DATA_DIR, 'last-port')

// `make dev` runs the API on a throwaway port behind Vite, so that process opts
// out — the port the user actually visits is Vite's, and that is what gets
// remembered instead.
const enabled = process.env.HERMIT_PORT_MEMORY !== '0'

const valid = port => Number.isInteger(port) && port > 0 && port <= 65535

/** The remembered port, or null when there is none worth trying. */
export async function recall () {
  if (!enabled) return null
  try {
    const port = Number((await readFile(PORT_MEMORY_PATH, 'utf8')).trim())
    return valid(port) ? port : null
  } catch {
    // Absent, unreadable or garbage all mean the same thing: pick a fresh port.
    return null
  }
}

export async function remember (port) {
  if (!enabled || !valid(port)) return
  try {
    await mkdir(dirname(PORT_MEMORY_PATH), { recursive: true })
    await writeFile(PORT_MEMORY_PATH, `${port}\n`, 'utf8')
  } catch {
    // Losing the port is a worse URL next time, not a failure to start.
  }
}
