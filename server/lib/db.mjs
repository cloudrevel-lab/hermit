import { JSONFilePreset } from 'lowdb/node'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Where db.json and cache.json live.
 *
 * A checkout has a data/ directory next to the code, so it keeps its data
 * there. An installed package has no data/ (and its directory may be
 * read-only), so it writes to a per-user location instead. Both are
 * overridable with HERMIT_DATA_DIR.
 */
function defaultDataDir () {
  const override = process.env.HERMIT_DATA_DIR || process.env.DATA_DIR
  if (override) return override
  if (existsSync(join(root, 'data'))) return join(root, 'data')
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Hermit')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Hermit')
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'hermit')
}

export const DATA_DIR = defaultDataDir()

const defaults = {
  repos: [],
  // Jira Fix Versions the user has pinned, so a release can be reopened later.
  jiraReleases: [],
  settings: {
    releaseBranchPrefix: 'release/',
    jiraBaseUrl: '',
    jiraProjectKey: '',
    issueKeyPattern: '[A-Z][A-Z0-9]+-\\d+',
    allowCherryPickWrites: false,
    // Letting the console complete the pull request merges into the target
    // branch without review, so it is a separate opt-in from the write switch.
    allowCherryPickAutoComplete: false,
    // Fast-forwarding the target branch straight onto the picked commits skips
    // the pull request, the review and the merge commit entirely — a third and
    // still more deliberate opt-in.
    allowCherryPickDirectMerge: false,
    // IANA zone name for rendering dates. Empty means the browser's own zone.
    timezone: '',
    // Time logger: the Jira site/project whose worklogs are reconciled, and the
    // working day used for capacity. Blank site/project fall back to the shared
    // Jira settings above; hours 0 means follow Jira's own setting.
    timeLoggerSite: '',
    timeLoggerProject: '',
    timeLoggerHoursPerDay: 8,
    timeLoggerDefaultLogTime: '09:00'
  }
}

let dbPromise = null

export function getDb () {
  dbPromise ??= (async () => {
    await mkdir(DATA_DIR, { recursive: true })
    const db = await JSONFilePreset(join(DATA_DIR, 'db.json'), defaults)
    // Fill in keys added by later versions of the app.
    db.data.settings = { ...defaults.settings, ...db.data.settings }
    db.data.repos ??= []
    db.data.jiraReleases ??= []
    await db.write()
    return db
  })()
  return dbPromise
}