import { JSONFilePreset } from 'lowdb/node'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DATA_DIR = process.env.DATA_DIR || join(root, 'data')

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