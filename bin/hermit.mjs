#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The installed entry point (`hermit`).
 *
 * `make up` manages a detached server inside a source checkout; this is what
 * someone who installed the package runs. With no subcommand it starts the same
 * server, opens a browser and stays in the foreground so Ctrl-C stops it.
 * `hermit backup` and `hermit restore` move db.json + cache.json between
 * machines without ever touching ~/.authinfo.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const HELP = `hermit — a local git release and Jira console

Usage
  hermit [options]                 start the console
  hermit backup [options]          write a timestamped backup tarball
  hermit restore <file> [options]  load a backup into the data directory
  hermit help                      show this help
  hermit version                   print the version

Serve options
  -p, --port <n>      port to listen on (default: any free port)
      --host <addr>   interface to bind (default: 127.0.0.1)
      --data-dir <p>  where db.json and cache.json are stored
      --no-open       do not open a browser
  -h, --help          show this help
  -v, --version       print the version

Backup options
  -o, --out <path>    file, or a directory to write hermit-backup-<timestamp>.tar.gz into
      --data-dir <p>  data directory to back up (default: the active one)
      --no-cache      back up settings and repos only, without the API cache
      --json          print the result as JSON

Restore options
      --data-dir <p>  data directory to restore into (default: the active one)
  -f, --force         replace existing db.json/cache.json, keeping them as .pre-restore-<timestamp>
      --json          print the result as JSON

A backup contains db.json and cache.json only. Credentials in ~/.authinfo and the
runtime state in .run/ are never included. The app binds to loopback only. It
reads credentials from ~/.authinfo and never sends them anywhere other than the
hosts they belong to.`

function serveOptions (argv) {
  const opts = { port: 0, host: '127.0.0.1', open: true, help: false, version: false, dataDir: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const value = () => { const v = inline ?? argv[++i]; if (v === undefined) throw new Error(`${key} needs a value`); return v }
    if (key === '--port' || key === '-p') opts.port = Number(value())
    else if (key === '--host') opts.host = value()
    else if (key === '--data-dir') opts.dataDir = value()
    else if (key === '--no-open') opts.open = false
    else if (key === '--help' || key === '-h') opts.help = true
    else if (key === '--version' || key === '-v') opts.version = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('--port must be a number between 0 and 65535')
  }
  return opts
}

function backupOptions (argv) {
  const opts = { out: undefined, dataDir: undefined, includeCache: true, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const value = () => { const v = inline ?? argv[++i]; if (v === undefined) throw new Error(`${key} needs a value`); return v }
    if (key === '-o' || key === '--out') opts.out = value()
    else if (key === '--data-dir') opts.dataDir = value()
    else if (key === '--no-cache') opts.includeCache = false
    else if (key === '--json') opts.json = true
    else if (key === '--help' || key === '-h') opts.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return opts
}

function restoreOptions (argv) {
  const opts = { file: undefined, dataDir: undefined, force: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const value = () => { const v = inline ?? argv[++i]; if (v === undefined) throw new Error(`${key} needs a value`); return v }
    if (key === '--data-dir') opts.dataDir = value()
    else if (key === '-f' || key === '--force') opts.force = true
    else if (key === '--json') opts.json = true
    else if (key === '--help' || key === '-h') opts.help = true
    else if (key.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else if (!opts.file) opts.file = arg
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  return opts
}

function openBrowser (url) {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {
    // Opening a browser is a convenience; the URL is printed either way.
  }
}

function formatBytes (n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}

// --data-dir and the modules that resolve it are order-sensitive: set the
// override before importing, exactly like the server path below.
async function loadBackup () {
  return import('../server/lib/backup.mjs')
}

async function runServe (argv) {
  const opts = serveOptions(argv)
  if (opts.help) { console.log(HELP); return }
  if (opts.version) { console.log(pkg.version); return }
  if (opts.dataDir) process.env.HERMIT_DATA_DIR = opts.dataDir

  // Imported after the data-dir override so the store resolves the right path.
  const { start } = await import('../server/index.mjs')
  const { server, url } = await start({ port: opts.port, host: opts.host })
  if (opts.open) openBrowser(url)
  console.log('\nPress Ctrl-C to stop.')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
}

async function runBackup (argv) {
  const opts = backupOptions(argv)
  if (opts.help) { console.log(HELP); return }
  if (opts.dataDir) process.env.HERMIT_DATA_DIR = opts.dataDir

  const { createBackup } = await loadBackup()
  const result = await createBackup({ dataDir: opts.dataDir, out: opts.out, includeCache: opts.includeCache })
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Backed up ${result.files.join(', ')} to ${result.path} (${formatBytes(result.bytes)}).`)
  console.log('Credentials in ~/.authinfo are not included; add them on the target machine.')
}

async function runRestore (argv) {
  const opts = restoreOptions(argv)
  if (opts.help) { console.log(HELP); return }
  if (opts.dataDir) process.env.HERMIT_DATA_DIR = opts.dataDir

  const { restoreBackup } = await loadBackup()
  const result = await restoreBackup({ file: opts.file, dataDir: opts.dataDir, force: opts.force })
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Restored ${result.restored.join(', ')} into ${result.dataDir}.`)
  for (const path of result.saved) console.log(`Previous file kept as ${path}.`)
  console.log('If Hermit is running, stop and start it again so it reloads the restored data.')
}

const argv = process.argv.slice(2)
const command = argv[0]
const known = command === 'backup' || command === 'restore' || command === 'serve' || command === 'help' || command === 'version'

try {
  if (known) {
    const args = argv.slice(1)
    if (command === 'backup') await runBackup(args)
    else if (command === 'restore') await runRestore(args)
    else if (command === 'serve') await runServe(args)
    else if (command === 'version') console.log(pkg.version)
    else console.log(HELP)
  } else {
    await runServe(argv)
  }
} catch (err) {
  console.error(`hermit: ${err.message}`)
  process.exitCode = 1
}
