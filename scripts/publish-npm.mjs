#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAuthinfo } from '../server/lib/authinfo.mjs'

// Publish to npm using the token the maintainer already keeps in ~/.authinfo
// (machine npmjs.com). npm itself does not read that file, so this bridges the
// two: it writes a throwaway .npmrc pointing npm at the token, verifies the
// token, publishes, then deletes the file. The token never reaches argv, the
// project directory, or ~/.npmrc.
//
//   npm run publish:npm                 # publish the current version
//   npm run publish:npm -- --dry-run    # rehearse without publishing
//   npm run publish:npm -- --otp 123456

const REGISTRY = 'https://registry.npmjs.org/'

function findNpmCredential (entries) {
  const matching = entries.filter(entry => entry.password && (
    entry.machine === 'npmjs.com' ||
    entry.machine.endsWith('.npmjs.com') ||
    entry.machine === 'registry.npmjs.org' ||
    entry.machine.endsWith('.npmjs.org')
  ))
  return matching.find(entry => entry.machine === 'npmjs.com') || matching[0] || null
}

const credential = findNpmCredential(await loadAuthinfo())

if (!credential) {
  console.error('No npm token found in ~/.authinfo.')
  console.error('Add a line such as:')
  console.error('  machine npmjs.com login <your-npm-username> password <npm-token>')
  console.error('Create a token at https://www.npmjs.com/settings/<user>/tokens')
  process.exit(1)
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

  // Fail clearly before publishing if the token is no good.
  const who = spawnSync(npm, ['--userconfig', npmrc, 'whoami'], { encoding: 'utf8' })
  if (who.status !== 0) {
    console.error('The npm token in ~/.authinfo (machine ' + credential.machine + ') was rejected.')
    console.error(String(who.stderr || who.stdout || '').trim().split('\n').slice(0, 4).join('\n'))
    console.error('Regenerate it at https://www.npmjs.com/settings/' + (credential.login || '') + '/tokens')
    console.error('and update the ~/.authinfo line.')
    process.exitCode = 1
  } else {
    console.log('Publishing to ' + REGISTRY + ' as ' + String(who.stdout).trim() + '.')
    const publish = spawnSync(
      npm,
      ['--userconfig', npmrc, 'publish', '--access', 'public', ...process.argv.slice(2)],
      { stdio: 'inherit' }
    )
    process.exitCode = publish.status === null ? 1 : publish.status
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
