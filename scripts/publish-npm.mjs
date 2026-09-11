#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { loadAuthinfo } from '../server/lib/authinfo.mjs'

// Publish a new version to npm, showing what is already published and asking
// for the version number. The npm token is read from ~/.authinfo
// (machine npmjs.com), which npm itself does not read: a throwaway .npmrc
// carries it, the token is verified first, and the file is removed afterwards.
//
//   make publish                              # interactive
//   HERMIT_VERSION=1.2.0 make publish         # skip the prompt
//   npm run publish:npm -- --dry-run          # show what would be published

const REGISTRY = 'https://registry.npmjs.org/'
const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const NAME = PACKAGE.name
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

function findNpmCredential (entries) {
  const matching = entries.filter(entry => entry.password && (
    entry.machine === 'npmjs.com' ||
    entry.machine.endsWith('.npmjs.com') ||
    entry.machine === 'registry.npmjs.org' ||
    entry.machine.endsWith('.npmjs.org')
  ))
  return matching.find(entry => entry.machine === 'npmjs.com') || matching[0] || null
}

/** Numeric comparison of the x.y.z part; enough for "which is newer". */
function compare (a, b) {
  const pa = String(a).replace(/[-+].*$/, '').split('.').map(Number)
  const pb = String(b).replace(/[-+].*$/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const delta = (pa[i] || 0) - (pb[i] || 0)
    if (delta !== 0) return delta
  }
  return 0
}

async function registry () {
  const res = await fetch(REGISTRY + encodeURIComponent(NAME), { headers: { Accept: 'application/json' } })
  if (res.status === 404) return { versions: [], times: {}, latest: null }
  if (!res.ok) throw new Error('registry responded HTTP ' + res.status + ' for ' + NAME)
  const body = await res.json()
  return {
    versions: Object.keys(body.versions || {}),
    times: body.time || {},
    latest: (body['dist-tags'] || {}).latest || null
  }
}

function ask (prompt) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, answer => { rl.close(); resolve(answer.trim()) })
  })
}

async function main () {
  const credential = findNpmCredential(await loadAuthinfo())
  if (!credential) {
    console.error('No npm token found in ~/.authinfo.')
    console.error('Add a line such as:')
    console.error('  machine npmjs.com login <your-npm-username> password <npm-token>')
    process.exitCode = 1
    return
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const dir = mkdtempSync(join(tmpdir(), 'hermit-npm-'))
  const npmrc = join(dir, '.npmrc')

  try {
    writeFileSync(
      npmrc,
      'registry=' + REGISTRY + '\n' +
      '//registry.npmjs.org/:_authToken=' + credential.password + '\n',
      { mode: 0o600 }
    )

    // 1. Verify the token before showing anything or touching package.json.
    const who = spawnSync(npm, ['--userconfig', npmrc, 'whoami'], { encoding: 'utf8' })
    if (who.status !== 0) {
      console.error('The npm token in ~/.authinfo (machine ' + credential.machine + ') was rejected.')
      console.error(String(who.stderr || who.stdout || '').trim().split('\n').slice(0, 4).join('\n'))
      console.error('Regenerate it at https://www.npmjs.com/settings/' + (credential.login || '') + '/tokens')
      process.exitCode = 1
      return
    }
    const user = String(who.stdout).trim()

    // 2. Show the versions already on npm.
    const { versions, times, latest } = await registry()
    const ordered = versions.slice().sort(compare)
    const recent = ordered.slice(-3).reverse()
    console.log('Publishing ' + NAME + ' to ' + REGISTRY + ' as ' + user + '.')
    if (recent.length) {
      console.log('Last 3 published:')
      for (const v of recent) {
        console.log('  ' + v.padEnd(10) + (times[v] ? times[v].slice(0, 10) : '') + (v === latest ? '  (latest)' : ''))
      }
    } else {
      console.log('Nothing published yet - this is the first release.')
    }

    // 3. Ask for the new version, suggesting the next patch above the newest.
    let suggestion = PACKAGE.version
    const newest = ordered[ordered.length - 1] || null
    if (newest && compare(suggestion, newest) <= 0) {
      const [major, minor, patch] = newest.replace(/[-+].*$/, '').split('.').map(Number)
      suggestion = major + '.' + minor + '.' + (patch + 1)
    }

    let version = process.env.HERMIT_VERSION ? process.env.HERMIT_VERSION.trim() : ''
    if (!version && !dryRun) {
      if (!process.stdin.isTTY) {
        console.error('No terminal to prompt on. Set HERMIT_VERSION=<version> instead.')
        process.exitCode = 1
        return
      }
      version = (await ask('New version [' + suggestion + ']: ')) || suggestion
    }

    if (dryRun) {
      console.log('Dry run: publishing ' + PACKAGE.version + ' without changing anything.')
    } else {
      if (!SEMVER.test(version)) {
        console.error('"' + version + '" is not a valid version (expected x.y.z).')
        process.exitCode = 1
        return
      }
      if (versions.includes(version)) {
        console.error('Version ' + version + ' is already published on npm.')
        process.exitCode = 1
        return
      }
      if (newest && compare(version, newest) < 0) {
        console.error('Version ' + version + ' is lower than the newest published version (' + newest + ').')
        process.exitCode = 1
        return
      }
      console.log('Setting version ' + PACKAGE.version + ' -> ' + version + ' ...')
      const bump = spawnSync(npm, ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'inherit' })
      if (bump.status !== 0) {
        console.error('Could not set the version; nothing was published.')
        process.exitCode = 1
        return
      }
    }

    // 4. Publish.
    const publish = spawnSync(npm, ['--userconfig', npmrc, 'publish', '--access', 'public', ...args], { stdio: 'inherit' })
    if (publish.status !== 0) {
      if (!dryRun) {
        console.error('Publish failed; reverting the version change.')
        spawnSync('git', ['checkout', '--', 'package.json', 'package-lock.json'], { stdio: 'inherit' })
      }
      process.exitCode = publish.status === null ? 1 : publish.status
      return
    }
    if (dryRun) return

    // 5. Record the release so the published version matches a commit.
    const dirty = spawnSync('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], { encoding: 'utf8' }).stdout.trim()
    if (dirty) {
      spawnSync('git', ['add', 'package.json', 'package-lock.json'], { stdio: 'inherit' })
      const commit = spawnSync('git', ['commit', '-m', 'Release v' + version], { stdio: 'inherit' })
      console.log(commit.status === 0
        ? 'Committed "Release v' + version + '". Push it with: git push'
        : 'Published, but the version bump was not committed - commit it yourself.')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
