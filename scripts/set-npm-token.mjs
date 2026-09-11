#!/usr/bin/env node
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

// Put an npm token into ~/.authinfo as the `machine npmjs.com` entry.
//
// The token is read from stdin, so it never lands in your shell history or the
// process list:
//
//   pbpaste | node scripts/set-npm-token.mjs                            # macOS
//   xclip -selection clipboard -o | node scripts/set-npm-token.mjs      # Linux
//
// Paste the FULL token. The token is checked against the registry before
// anything is written, so a bad paste cannot clobber a working entry.

const AUTHINFO = process.env.AUTHINFO_PATH || join(homedir(), '.authinfo')
const HOST = 'npmjs.com'

async function readStdin () {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

const token = await readStdin()

if (!token) {
  console.error('Usage: pbpaste | node scripts/set-npm-token.mjs')
  console.error('')
  console.error('Reads an npm token from stdin and stores it as the ' + HOST + ' entry')
  console.error('in ' + AUTHINFO + '. Paste the full token, not the masked display.')
  process.exit(1)
}

if (token.includes('.') || !/^npm_[A-Za-z0-9_-]+$/.test(token)) {
  console.error('That does not look like an npm token.')
  console.error('Use the full token, not the masked "npm_xxxx...yyyy" form shown in the token list.')
  process.exit(1)
}

if (token.length < 36) {
  console.error('That token looks too short to be complete (' + token.length + ' characters).')
  process.exit(1)
}

// Verify first, so a rejected token changes nothing.
const res = await fetch('https://registry.npmjs.org/-/whoami', {
  headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
})
if (!res.ok) {
  console.error('The registry rejected this token (HTTP ' + res.status + '). Nothing was changed.')
  console.error('Copy the token again from the page shown when it was created, or generate a new one.')
  process.exit(1)
}
const who = await res.json().catch(() => ({}))

let text = ''
try {
  text = await readFile(AUTHINFO, 'utf8')
} catch (err) {
  if (err.code !== 'ENOENT') throw err
}

const pattern = /(machine\s+npmjs\.com\s+login\s+\S+\s+password\s+)\S+/
const replacement = (match, prefix) => prefix + token
const next = pattern.test(text)
  ? text.replace(pattern, replacement)
  : text + (text.length && !text.endsWith('\n') ? '\n' : '') +
    'machine ' + HOST + ' login ' + (process.env.NPM_LOGIN || userInfo().username || 'npm') +
    ' password ' + token + '\n'

await writeFile(AUTHINFO, next, { mode: 0o600 })
await chmod(AUTHINFO, 0o600).catch(() => {})

console.log('Saved the npm token for ' + HOST + ' in ' + AUTHINFO + ' (mode 600).')
console.log('Verified as npm user: ' + (who.username || '(unknown)'))
console.log('Next: npm run publish:npm')
