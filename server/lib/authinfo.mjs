import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const AUTHINFO_PATH = process.env.AUTHINFO_PATH || join(homedir(), '.authinfo')

// ~/.authinfo uses the netrc token stream format:
//   machine dev.azure.com login jacob password <pat>
// Tokens may be spread over several lines, so we tokenise the whole file and
// walk it rather than parsing line by line. Lines starting with # are comments.
function tokenise (text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .join(' ')
    .split(/\s+/)
}

const KEYS = new Set(['machine', 'default', 'login', 'user', 'password', 'port', 'protocol', 'account'])

export function parseAuthinfo (text) {
  const tokens = tokenise(text)
  const entries = []
  let current = null

  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i]
    if (key === 'machine' || key === 'default') {
      if (current) entries.push(current)
      current = { machine: key === 'default' ? '*' : tokens[++i] }
      continue
    }
    if (!current || !KEYS.has(key)) continue
    const value = tokens[++i]
    if (value === undefined) break
    if (key === 'user') current.login = value
    else current[key] = value
  }
  if (current) entries.push(current)
  return entries
}

let cached = null

export async function loadAuthinfo ({ reload = false } = {}) {
  if (cached && !reload) return cached
  try {
    const text = await readFile(AUTHINFO_PATH, 'utf8')
    cached = parseAuthinfo(text)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    cached = []
  }
  return cached
}

// Matches the most specific entry for a host: exact match wins over a parent
// domain suffix, which wins over the netrc `default` catch-all.
export function findCredential (entries, host) {
  const needle = String(host || '').toLowerCase()
  const exact = entries.find(e => e.machine.toLowerCase() === needle)
  if (exact) return exact
  const suffix = entries
    .filter(e => e.machine !== '*' && needle.endsWith('.' + e.machine.toLowerCase()))
    .sort((a, b) => b.machine.length - a.machine.length)[0]
  if (suffix) return suffix
  return entries.find(e => e.machine === '*') || null
}

export async function credentialFor (host, opts) {
  return findCredential(await loadAuthinfo(opts), host)
}

/** Credential presence per host, safe to send to the browser (no secrets). */
export async function authStatus (opts) {
  const entries = await loadAuthinfo(opts)
  return {
    path: AUTHINFO_PATH,
    found: entries.length > 0,
    machines: entries.map(e => ({
      machine: e.machine,
      login: e.login || null,
      hasPassword: Boolean(e.password)
    }))
  }
}

export function invalidateAuthinfo () {
  cached = null
}
