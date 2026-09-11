import express from 'express'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { reposRouter } from './routes/repos.mjs'
import { gitRouter } from './routes/git.mjs'
import { jiraRouter } from './routes/jira.mjs'
import { timeLoggerRouter } from './routes/time-logger.mjs'
import { systemRouter } from './routes/system.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

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
  res.status(status).json({ error: err.message || 'Unexpected error', hint: err.hint || null })
})

// Port 0 asks the OS for any free port, which is what keeps `make up` from
// colliding with whatever else is already running.
const requested = Number(process.env.PORT || 0)
const host = process.env.HOST || '127.0.0.1'

const server = app.listen(requested, host, async () => {
  const { port } = server.address()
  const url = `http://${host}:${port}`
  if (process.env.PORT_FILE) await writeFile(process.env.PORT_FILE, String(port))
  console.log(`hermit listening on ${url}`)
  // The start script watches for this line to learn the port it got.
  console.log(`READY ${url}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}