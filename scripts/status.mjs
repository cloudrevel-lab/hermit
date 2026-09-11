import { PROCS, isAlive, logFile, readPid, readUrl } from './runtime.mjs'

const rows = PROCS.map(name => ({ name, pid: readPid(name) })).filter(r => r.pid)
const url = readUrl()

if (!rows.length) {
  console.log('Not running.  Start it with `make up`.')
  process.exit(0)
}

for (const { name, pid } of rows) {
  const alive = isAlive(pid)
  console.log(`  ${name.padEnd(4)} pid ${String(pid).padEnd(7)} ${alive ? 'running' : 'DEAD (stale pid file — run `make down`)'}`)
  if (!alive) console.log(`       last output: ${logFile(name)}`)
}

if (url) console.log(`\n  url  ${url}`)

// Confirm the server actually answers, not just that the process exists.
if (url && rows.some(r => isAlive(r.pid))) {
  try {
    const res = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(2500) })
    const body = await res.json()
    console.log(`  health  ok, up ${Math.round(body.uptime)}s`)
  } catch {
    console.log('  health  no response yet')
  }
}
