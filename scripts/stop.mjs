import { PROCS, clearPid, clearUrl, isAlive, readPid, readUrl, sleep } from './runtime.mjs'

/** Signals the whole process group, falling back to the bare pid. */
function signal (pid, sig) {
  try { process.kill(-pid, sig) } catch { 
    try { process.kill(pid, sig) } catch { /* already gone */ }
  }
}

async function stop (name) {
  const pid = readPid(name)
  if (!pid) return null
  if (!isAlive(pid)) {
    clearPid(name)
    return { name, pid, state: 'stale' }
  }

  signal(pid, 'SIGTERM')
  for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100)

  if (isAlive(pid)) {
    signal(pid, 'SIGKILL')
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100)
  }

  clearPid(name)
  return { name, pid, state: isAlive(pid) ? 'refused' : 'stopped' }
}

const url = readUrl()
const results = (await Promise.all(PROCS.map(stop))).filter(Boolean)

if (!results.length) {
  console.log('Nothing is running.')
} else {
  for (const r of results) {
    const label = { stopped: 'stopped', stale: 'was already gone (cleaned up stale pid file)', refused: 'DID NOT STOP' }[r.state]
    console.log(`  ${r.name} (pid ${r.pid}) ${label}`)
  }
  if (url) console.log(`\n${url} is no longer served.`)
}

clearUrl()
if (results.some(r => r.state === 'refused')) process.exit(1)
