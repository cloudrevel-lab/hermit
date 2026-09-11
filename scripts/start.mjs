import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, RUN_DIR, PROCS, ensureRunDir, isAlive, logFile, readPid, readUrl, sleep, writePid, writeUrl } from './runtime.mjs'

const dev = process.argv.includes('--dev')

// Refuse to start a second copy; `make down` first, or `make restart`.
for (const name of PROCS) {
  const pid = readPid(name)
  if (isAlive(pid)) {
    console.error(`Already running (${name} pid ${pid}) at ${readUrl() || 'unknown url'}.`)
    console.error('Use `make restart`, or `make down` first.')
    process.exit(1)
  }
}

ensureRunDir()

/**
 * Starts a detached child in its own process group so that stopping it also
 * stops anything it spawned (vite's workers, for example), and so that it
 * survives the terminal that ran `make up` going away.
 */
function launch (name, command, args, env) {
  appendFileSync(logFile(name), `\n=== started ${new Date().toISOString()} ===\n`)
  // Where this run's output begins. Logs are appended across restarts, so
  // scanning the whole file would match a READY line from a previous run.
  const offset = statSync(logFile(name)).size
  // The log file descriptor is handed straight to the child. Piping through
  // this process instead would keep its event loop alive, so `make up` would
  // never return to the shell.
  const fd = openSync(logFile(name), 'a')
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env }
  })
  writePid(name, child.pid)
  child.unref()
  return offset
}

// Vite colours its startup banner, and the escape codes land between the
// characters we match on ("Local\e[22m:"), so they have to come out first.
const stripAnsi = text => text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')

/** Polls this run's slice of the child's log for the line announcing its port. */
async function waitForLine (name, offset, pattern, timeoutMs = 60000) {
  const file = logFile(name)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const chunk = stripAnsi(readFileSync(file, 'utf8').slice(offset))
      const match = pattern.exec(chunk)
      if (match) return match
    }
    if (!isAlive(readPid(name))) {
      throw new Error(`${name} exited during startup. See ${file}`)
    }
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${name} to start. See ${file}`)
}

async function main () {
  if (dev) {
    // API and Vite run as two processes; Vite proxies /api to the API port.
    const apiOffset = launch('api', process.execPath, ['server/index.mjs'], { PORT: '0' })
    const [, apiUrl] = await waitForLine('api', apiOffset, /^READY (\S+)$/m)
    console.log(`  api  ${apiUrl}`)

    const webOffset = launch('web', 'npx', ['vite', '--host', '127.0.0.1'], { API_URL: apiUrl, NO_COLOR: '1', FORCE_COLOR: '0' })
    const [, webUrl] = await waitForLine('web', webOffset, /Local:\s+(\S+)/)
    const clean = webUrl.replace(/\/$/, '')
    writeUrl(clean)
    // One request kicks off dependency pre-bundling while we still have the
    // user's attention, so their first page load is not a re-optimize.
    await fetch(clean, { signal: AbortSignal.timeout(20000) }).catch(() => {})
    console.log(`  web  ${clean}   (hot reload)`)
    console.log(`\nHermit console is up at ${clean}`)
  } else {
    if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
      console.error('The UI is not built. Run `make build` first (or `make up` which builds for you).')
      process.exit(1)
    }
    const offset = launch('app', process.execPath, ['server/index.mjs'], { PORT: '0' })
    const [, url] = await waitForLine('app', offset, /^READY (\S+)$/m)
    writeUrl(url)
    console.log(`\nHermit console is up at ${url}`)
  }
  console.log(`Logs: ${RUN_DIR}/*.log     Stop: make down`)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
