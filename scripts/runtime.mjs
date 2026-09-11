import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RUN_DIR = join(ROOT, '.run')

/** Every managed process gets a <name>.pid file so `make down` works from any terminal. */
export const PROCS = ['app', 'api', 'web']

export function ensureRunDir () {
  mkdirSync(RUN_DIR, { recursive: true })
}

export const pidFile = name => join(RUN_DIR, `${name}.pid`)
export const logFile = name => join(RUN_DIR, `${name}.log`)
export const urlFile = join(RUN_DIR, 'url')

export function readPid (name) {
  const file = pidFile(name)
  if (!existsSync(file)) return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function writePid (name, pid) {
  ensureRunDir()
  writeFileSync(pidFile(name), String(pid))
}

export function clearPid (name) {
  try { unlinkSync(pidFile(name)) } catch { /* already gone */ }
}

export function isAlive (pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)   // signal 0 only tests for existence
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export function readUrl () {
  try { return readFileSync(urlFile, 'utf8').trim() } catch { return null }
}

export function writeUrl (url) {
  ensureRunDir()
  writeFileSync(urlFile, url)
}

export function clearUrl () {
  try { unlinkSync(urlFile) } catch { /* already gone */ }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
