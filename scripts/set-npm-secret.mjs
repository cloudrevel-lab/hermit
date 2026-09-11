#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { loadAuthinfo } from '../server/lib/authinfo.mjs'

// Put the npm token from ~/.authinfo into the GitHub repository secret
// NPM_TOKEN, so the tag workflow can publish to npm. GitHub encrypts secrets
// with the repository's public key; gh does that for us and reads the value
// from stdin, so the token never appears in argv.
//
//   make secret                      # strict: fails if it cannot be set
//   make publish / make release      # best effort (--if-possible)
//
// Needs a GitHub token as well as the npm one:
//   machine github.com login <you> password <pat with repo scope>

const SECRET = 'NPM_TOKEN'
const ifPossible = process.argv.includes('--if-possible')

function pick (entries, hosts) {
  for (const host of hosts) {
    const exact = entries.find(entry => entry.machine === host && entry.password)
    if (exact) return exact
  }
  return null
}

function repoFromGit () {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:[.]git)?\s*$/.exec(r.stdout.trim())
  return m ? m[1] + '/' + m[2] : null
}

function stop (message) {
  console.error(message)
  process.exit(ifPossible ? 0 : 1)
}

const entries = await loadAuthinfo()
const npm = pick(entries, ['npmjs.com', 'registry.npmjs.org'])
if (!npm) stop('No npm token found in ~/.authinfo (machine npmjs.com).')

const repo = process.env.HERMIT_REPO || repoFromGit() || 'cloudrevel-lab/hermit'
const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN ||
  pick(entries, ['github.com', 'api.github.com'])?.password

if (!githubToken) {
  stop('NPM_TOKEN not set: no GitHub token.\n' +
    'Add a classic PAT with the repo scope to ~/.authinfo:\n' +
    '  machine github.com login <your-username> password <github-pat>\n' +
    'then run make secret. Until then the tag workflow skips the npm publish.')
}

const set = spawnSync('gh', ['secret', 'set', SECRET, '--repo', repo], {
  env: { ...process.env, GH_TOKEN: githubToken },
  input: npm.password,
  encoding: 'utf8'
})

if (set.error) stop('Could not run gh: ' + set.error.message)
if (set.status !== 0) {
  stop('gh could not set ' + SECRET + ' on ' + repo + ' (does the GitHub token have admin on it, with the repo scope?):\n' +
    String(set.stderr || '').trim().split('\n').slice(0, 3).join('\n'))
}

console.log('Set the ' + SECRET + ' secret on ' + repo + ' from the ~/.authinfo npm token.')
