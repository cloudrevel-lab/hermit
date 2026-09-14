import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

import { DATA_DIR } from './db.mjs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))

export const BACKUP_FORMAT = 'hermit-backup'
export const BACKUP_FORMAT_VERSION = 1

/** db.json holds the setup; cache.json holds the fetched branch, commit and Jira data. */
export const BACKUP_FILES = ['db.json', 'cache.json']

/** Things that must never end up in a backup, recorded in its manifest. */
export const BACKUP_EXCLUDES = ['~/.authinfo', '.run/']

const pad = n => String(n).padStart(2, '0')

/** Local-time stamp used in the archive filename: 20260911-160300. */
export function backupStamp (date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function backupFilename (date = new Date()) {
  return `hermit-backup-${backupStamp(date)}.tar.gz`
}

/**
 * Turn an --out value into a concrete file. A path ending in .tar.gz/.tgz is
 * used as-is; anything else is treated as a directory and gets the timestamped
 * filename.
 */
export function resolveBackupPath (out, date = new Date()) {
  const target = resolve(out)
  return /\.(tar\.gz|tgz)$/i.test(target) ? target : join(target, backupFilename(date))
}

function uniquePath (path) {
  if (!existsSync(path)) return path
  const match = /^(.*?)(\.tar\.gz|\.tgz)$/i.exec(path)
  const base = match ? match[1] : path
  const ext = match ? match[2] : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find a free backup filename near ${path}`)
}

// --- minimal ustar packer -------------------------------------------------
// Backups hold a handful of small JSON files, so a dependency-free ustar
// writer/reader is enough and keeps the archive readable by system tar.

function tarHeader ({ name, size, mtime, mode = 0o644 }) {
  const buffer = Buffer.alloc(512)
  const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0'
  buffer.write(name, 0, 100, 'utf8')
  buffer.write(octal(mode & 0o7777, 8), 100, 8, 'utf8')
  buffer.write(octal(0, 8), 108, 8, 'utf8') // uid
  buffer.write(octal(0, 8), 116, 8, 'utf8') // gid
  buffer.write(octal(size, 12), 124, 12, 'utf8')
  buffer.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'utf8')
  buffer.write('        ', 148, 8, 'utf8') // checksum while it is computed
  buffer.write('0', 156, 1, 'utf8') // regular file
  buffer.write('ustar\0', 257, 6, 'utf8')
  buffer.write('00', 263, 2, 'utf8')
  buffer.write('hermit', 265, 32, 'utf8') // uname
  buffer.write('hermit', 297, 32, 'utf8') // gname
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buffer[i]
  buffer.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')
  return buffer
}

function tarPack (files) {
  const chunks = []
  for (const { name, data, mtime } of files) {
    chunks.push(tarHeader({ name, size: data.length, mtime }))
    chunks.push(data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024)) // two empty blocks end the archive
  return Buffer.concat(chunks)
}

function tarUnpack (buffer) {
  const files = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (prefix) name = `${prefix}/${name}`
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    const type = String.fromCharCode(header[156])
    offset += 512
    const data = Buffer.from(buffer.subarray(offset, offset + size))
    offset += size + ((512 - (size % 512)) % 512)
    if (type === '0' || type === '\0') files.push({ name: name.replace(/^\.\//, ''), data })
  }
  return files
}

function readManifest (entry) {
  if (!entry) return null
  try { return JSON.parse(entry.data.toString('utf8')) } catch { return null }
}

/**
 * Write db.json (and optionally cache.json) from dataDir into a timestamped
 * gzipped tar. Returns the resolved path and what went in.
 */
export async function createBackup ({ dataDir = DATA_DIR, out = process.cwd(), includeCache = true, now = new Date() } = {}) {
  const wanted = includeCache ? BACKUP_FILES : BACKUP_FILES.filter(name => name !== 'cache.json')
  const present = wanted.filter(name => existsSync(join(dataDir, name)))
  if (!present.length) {
    throw new Error(`Nothing to back up in ${resolve(dataDir)} (no ${wanted.join(' or ')}).`)
  }

  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    hermitVersion: pkg.version,
    createdAt: now.toISOString(),
    dataDir: resolve(dataDir),
    files: present,
    excludes: BACKUP_EXCLUDES,
    note: 'Credentials live in ~/.authinfo and are never included. Add them on the target machine.'
  }

  const entries = [{ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }]
  for (const name of present) {
    entries.push({ name, data: await readFile(join(dataDir, name)) })
  }
  const mtime = now.getTime()
  const tarball = await gzipAsync(tarPack(entries.map(entry => ({ ...entry, mtime }))))

  const target = uniquePath(resolveBackupPath(out, now))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, tarball)
  return { path: target, dataDir: resolve(dataDir), files: present, bytes: tarball.length, createdAt: manifest.createdAt, manifest }
}

/**
 * Load db.json/cache.json from a backup into dataDir. Existing files are only
 * replaced with force, and are kept as <file>.pre-restore-<stamp>.
 */
export async function restoreBackup ({ file, dataDir = DATA_DIR, force = false, now = new Date() } = {}) {
  if (!file) throw new Error('A backup file is required: hermit restore <file>')
  const source = resolve(file)
  if (!existsSync(source)) throw new Error(`Backup not found: ${source}`)

  let tarball
  try {
    tarball = await gunzipAsync(await readFile(source))
  } catch (err) {
    throw new Error(`${source} could not be read as a gzip tarball: ${err.message}`)
  }

  const byName = new Map(tarUnpack(tarball).map(entry => [entry.name, entry]))
  const manifest = readManifest(byName.get('manifest.json'))
  if (manifest && manifest.format && manifest.format !== BACKUP_FORMAT) {
    throw new Error(`${source} is not a Hermit backup (format: ${manifest.format}).`)
  }

  const payload = BACKUP_FILES.filter(name => byName.has(name)).map(name => [name, byName.get(name).data])
  if (!payload.length) {
    throw new Error(`${source} has no db.json or cache.json — is it a Hermit backup?`)
  }
  for (const [name, data] of payload) {
    try { JSON.parse(data.toString('utf8')) } catch (err) {
      throw new Error(`The backup's ${name} is not valid JSON: ${err.message}`)
    }
  }

  const destination = resolve(dataDir)
  await mkdir(destination, { recursive: true })
  const existing = payload.map(([name]) => join(destination, name)).filter(path => existsSync(path))
  if (existing.length && !force) {
    const names = existing.map(path => path.slice(destination.length + 1)).join(', ')
    const err = new Error(`Refusing to overwrite existing data in ${destination}: ${names}. Re-run with --force to replace it.`)
    err.code = 'EEXIST'
    throw err
  }

  const saved = []
  if (force) {
    for (const path of existing) {
      const aside = uniquePath(`${path}.pre-restore-${backupStamp(now)}`)
      await rename(path, aside)
      saved.push(aside)
    }
  }
  const restored = []
  for (const [name, data] of payload) {
    const target = join(destination, name)
    await writeFile(target, data)
    restored.push(target)
  }
  return { path: source, dataDir: destination, restored: payload.map(([name]) => name), saved, manifest }
}
