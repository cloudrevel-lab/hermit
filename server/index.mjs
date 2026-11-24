import express from 'express'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { reposRouter } from './routes/repos.mjs'
import { gitRouter } from './routes/git.mjs'
import { jiraRouter } from './routes/jira.mjs'
import { timeLoggerRouter } from './routes/time-logger.mjs'
import { systemRouter } from './routes/system.mjs'
import { install as installCorpCert } from './lib/corp-cert.mjs'
import { recall as recallPort, remember as rememberPort } from './lib/port-memory.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = express()

// Set only by start({ demo: true }). The gate stays in front of the production
// routers so demo mode can be selected at start time without rebuilding the app.
let demoHandler = null

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

app.use('/api', (req, res, next) => {
  if (demoHandler) return demoHandler(req, res, next)
  next()
})

app.use('/api/repos', reposRouter)
app.use('/api/git', gitRouter)
app.use('/api/jira', jiraRouter)
app.use('/api/time-logger', timeLoggerRouter)
app.use('/api', systemRouter)

// The built SPA is served from the same origin as the API, so there is no CORS
// to configure and `make up` only has one process to manage.
const dist = join(root, 'web', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(dist, 'index.html')))
} else {
  app.get('/', (req, res) => res.status(503).type('text/plain').send(
    'The UI has not been built yet. Run `make build`, or use `make dev` for the hot-reload dev server.'
  ))
}

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }))

app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err)
  res.status(status).json({
    error: err.message || 'Unexpected error',
    hint: err.hint || null,
    // `code` and `details` let the UI offer a supported alternative instead of
    // matching on an error message: e.g. open the merge as a pull request.
    ...(err.code ? { code: err.code } : {}),
    ...(err.details ? { details: err.details } : {})
  })
})

/**
 * Start the HTTP server and resolve with it and the URL it bound to.
 *
 * `make up` runs this file directly and watches stdout for `READY`. The
 * installed CLI imports this function instead, so it can open a browser and own
 * the shutdown signals itself.
 *
 * Port 0 asks the OS for any free port, which is what keeps `make up` from
 * colliding with whatever else is already running. Before falling back to that,
 * the port from the previous run is tried, so the URL stays put across restarts.
 * An explicitly requested port is never second-guessed: if it is taken, that is
 * an error the caller asked for rather than something to work around.
 */
export async function start ({ port = Number(process.env.PORT || 0), host = process.env.HOST || '127.0.0.1', demo = false } = {}) {
  // A production start in the same process must not inherit an earlier demo
  // handler; the reverse only happens in tests that start one server at a time.
  if (!demo) demoHandler = null
  if (demo) {
    // The demo API is the only thing that should answer /api, and loading it
    // here keeps the production routers from reading ~/.authinfo or data/.
    const { createDemoRouter } = await import('../demo/api.mjs')
    demoHandler = createDemoRouter()
    console.log('demo mode: fictional Aurora data; no credentials, repositories or Jira calls are used')
  }

  // The corporate root CA has to be in the trust store before the first
  // outbound request, so it is loaded here rather than on demand. A failure
  // here is not fatal: the app still runs, it just cannot reach Jira from
  // inside an intercepting network until the certificate is sorted out. Demo
  // mode never makes an outbound request, so it skips the trust store entirely.
  if (!demo) {
    try {
      if (await installCorpCert()) console.log('Loaded the corporate root CA')
    } catch (err) {
      console.error('Could not load the corporate root CA:', err.message)
    }
  }

  // Only an automatic port (0) is open to being remembered or reassigned. A
  // demo never reads or writes the real data directory, so it asks for a fresh
  // port rather than competing with the production instance's remembered one.
  const automatic = !port && !demo
  const wanted = automatic ? (await recallPort()) ?? 0 : port

  let server
  try {
    server = await bind(wanted, host)
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || !wanted || !automatic) throw err
    console.log(`Port ${wanted} is in use, asking for another.`)
    server = await bind(0, host)
  }

  const actual = server.address().port
  const url = `http://${host}:${actual}`
  if (!demo) await rememberPort(actual)
  if (process.env.PORT_FILE) await writeFile(process.env.PORT_FILE, String(actual))
  console.log(`hermit listening on ${url}`)
  // The start script watches for this line to learn the port it got.
  console.log(`READY ${url}`)
  return { server, url }
}

/** Resolves with a listening server, or rejects with the bind error. */
function bind (port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host)
    server.once('listening', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
    server.once('error', reject)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start()
    .then(({ server }) => {
      for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
          console.log(`\nReceived ${signal}, shutting down.`)
          server.close(() => process.exit(0))
          setTimeout(() => process.exit(0), 3000).unref()
        })
      }
    })
    .catch(err => {
      console.error(err.message)
      process.exit(1)
    })
}