#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The installed entry point (`hermit`).
 *
 * `make up` manages a detached server inside a source checkout; this is what
 * someone who installed the package runs. It starts the same server, opens a
 * browser and stays in the foreground so Ctrl-C stops it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const HELP = `hermit — a local git release and Jira console

Usage
  hermit [options]

Options
  -p, --port <n>      port to listen on (default: any free port)
      --host <addr>   interface to bind (default: 127.0.0.1)
      --data-dir <p>  where db.json and cache.json are stored
      --no-open       do not open a browser
  -h, --help          show this help
  -v, --version       print the version

The app binds to loopback only. It reads credentials from ~/.authinfo and never
sends them anywhere other than the hosts they belong to.`

function parseArgs (argv) {
  const opts = { port: 0, host: '127.0.0.1', open: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const value = () => inline ?? argv[++i]
    if (key === '--port' || key === '-p') opts.port = Number(value())
    else if (key === '--host') opts.host = value()
    else if (key === '--data-dir') opts.dataDir = value()
    else if (key === '--no-open') opts.open = false
    else if (key === '--help' || key === '-h') { console.log(HELP); process.exit(0) }
    else if (key === '--version' || key === '-v') { console.log(pkg.version); process.exit(0) }
    else { console.error(`Unknown option: ${arg}\n`); console.log(HELP); process.exit(1) }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('--port must be a number between 0 and 65535')
    process.exit(1)
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

const opts = parseArgs(process.argv.slice(2))
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
