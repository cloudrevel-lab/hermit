import { X509Certificate } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'

/**
 * A root CA for TLS-intercepting corporate networks.
 *
 * Offices that terminate TLS at the edge re-sign every request with an internal
 * root. Browsers and curl trust it because the SOE put it in the OS store, but
 * Node ships its own CA bundle and ignores the OS, so `fetch` fails with
 * SELF_SIGNED_CERT_IN_CHAIN and nothing else in the app works on that network.
 *
 * NODE_EXTRA_CA_CERTS fixes it but is read once at process start, so the app
 * cannot set it for itself. Node 22 added a trust store that can be changed
 * while running, which is what lets the Settings page accept an upload and have
 * it take effect without a restart.
 */

// Overridable so tests (and anyone juggling two networks) can point elsewhere.
export const CERT_DIR = process.env.HERMIT_CERT_DIR || join(homedir(), '.hermit-console')
export const CERT_PATH = join(CERT_DIR, 'corp-ca.pem')

/** Node <22 has no runtime trust store; those users need NODE_EXTRA_CA_CERTS. */
export const canInstallAtRuntime = typeof tls.setDefaultCACertificates === 'function'

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

// Errors OpenSSL raises when a chain is real but signed by a root we do not
// trust. Anything else (DNS, refused, timeout) is not a certificate problem and
// must not trigger a retry.
const TRUST_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED'
])

// setDefaultCACertificates replaces the list outright, so the bundled roots are
// captured once up front. Reading them back after an install would fold our own
// certificates into the baseline and make removal impossible.
let baseline = null
const bundledRoots = () => (baseline ??= canInstallAtRuntime ? tls.getCACertificates('default') : [])

let installed = false

/**
 * Normalise whatever the OS handed the user before looking for PEM blocks.
 *
 * Windows is the awkward one: PowerShell 5.1 writes UTF-16LE by default, so
 * `... > corp-ca.pem` produces a file the browser decodes to ASCII interleaved
 * with NULs. Dropping the NULs recovers it, which is friendlier than telling
 * someone their certificate is corrupt when it is only the shell's encoding.
 * A UTF-8 BOM and CRLF line endings both survive as-is.
 */
function decode (text) {
  return String(text || '').replace(/\u0000/g, '').replace(/^\uFEFF/, '')
}

function splitPem (text) {
  return decode(text).match(PEM_BLOCK) || []
}

/** Certificate fields the Settings page shows, so the user can confirm what they uploaded. */
function describe (pem) {
  const cert = new X509Certificate(pem)
  const validTo = new Date(cert.validTo)
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    fingerprint: cert.fingerprint256,
    // A self-issued certificate is the root; the rest of a bundle are intermediates.
    isRoot: cert.subject === cert.issuer,
    isCa: cert.ca === true,
    expired: validTo.getTime() < Date.now()
  }
}

/** Parses and sanity-checks an uploaded bundle without storing it. */
export function inspect (text) {
  const blocks = splitPem(text)
  if (!blocks.length) {
    const err = new Error('That file contains no PEM certificate')
    err.status = 400
    err.hint = 'Export the root CA in PEM/Base-64 form — a text file starting with -----BEGIN CERTIFICATE-----. A binary DER file (.cer/.crt) converts with "certutil -encode ca.cer ca.pem" on Windows, or "openssl x509 -inform der -in ca.cer -out ca.pem" on macOS and Linux.'
    throw err
  }

  let certs
  try {
    certs = blocks.map(describe)
  } catch (cause) {
    const err = new Error(`That file is not a readable certificate: ${cause.message}`)
    err.status = 400
    throw err
  }

  if (!certs.some(c => c.isCa)) {
    const err = new Error('None of those certificates is a certificate authority')
    err.status = 400
    err.hint = 'This needs the root CA that signs the intercepted connections, not the certificate of a single site. It is the last certificate in the chain, the one whose subject and issuer are the same.'
    throw err
  }

  if (certs.every(c => c.expired)) {
    const err = new Error('Every certificate in that file has expired')
    err.status = 400
    err.hint = 'Ask your IT team for the current root CA, or export it again from this machine’s trust store.'
    throw err
  }

  return certs
}

export async function readStored () {
  try {
    return await readFile(CERT_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Merge the stored bundle into the trust store.
 *
 * The bundled roots are always kept: passing only the corporate CA would
 * authenticate the proxy and break every other TLS connection the app makes.
 */
export async function install () {
  if (!canInstallAtRuntime) return false
  const text = await readStored()
  // Only authorities go in. A chain pasted straight off the wire also carries
  // the site's own leaf certificate, and making that a trust anchor would widen
  // what the app accepts for no benefit.
  const blocks = splitPem(text).filter(pem => {
    try { return new X509Certificate(pem).ca === true } catch { return false }
  })
  if (!blocks.length) return false
  tls.setDefaultCACertificates([...bundledRoots(), ...blocks])
  installed = true
  return true
}

/** Drop back to the certificates Node shipped with. */
function uninstall () {
  if (!canInstallAtRuntime) return
  tls.setDefaultCACertificates(bundledRoots())
  installed = false
}

export async function save (text) {
  const certs = inspect(text)
  await mkdir(CERT_DIR, { recursive: true })
  // Stored as canonical LF-delimited PEM, so a file exported on Windows reads
  // the same as one exported anywhere else. OpenSSL accepts either, but this
  // keeps the file diffable and predictable to anyone who opens it.
  const canonical = splitPem(text).map(block => block.replace(/\r\n/g, '\n')).join('\n')
  await writeFile(CERT_PATH, canonical + '\n', 'utf8')
  await install()
  return certs
}

export async function remove () {
  await rm(CERT_PATH, { force: true })
  uninstall()
}

export async function status () {
  const text = await readStored()
  let certs = []
  let error = null
  if (text) {
    try { certs = inspect(text) } catch (err) { error = err.message }
  }
  return {
    present: Boolean(text),
    path: CERT_PATH,
    certs,
    error,
    installed,
    canInstallAtRuntime,
    nodeVersion: process.version,
    // What a Node 20 user has to do by hand, with the real path filled in.
    manualHint: canInstallAtRuntime
      ? null
      : `This Node (${process.version}) cannot load certificates while running. Start hermit with NODE_EXTRA_CA_CERTS="${CERT_PATH}" set, or upgrade to Node 22 or newer.`
  }
}

export const isTrustError = err => {
  for (let cause = err; cause; cause = cause.cause) {
    if (TRUST_ERRORS.has(cause.code)) return true
  }
  return false
}

/**
 * `fetch`, retried against the uploaded CA when the default roots reject the chain.
 *
 * The retry only fires on a trust failure that installing could actually fix —
 * once the certificate is in the store the first attempt succeeds and this is a
 * plain passthrough, so there is no cost on a normal network.
 */
export async function corpFetch (url, init) {
  try {
    return await fetch(url, init)
  } catch (err) {
    // Already installed means the store has been tried and still says no.
    if (installed || !isTrustError(err) || !canInstallAtRuntime) throw err
    if (!(await install())) throw err
    return await fetch(url, init)
  }
}

/**
 * Turns a TLS trust failure into advice, so a request that dies on a corporate
 * network says what to do instead of only "fetch failed".
 */
export function trustHint (err) {
  if (!isTrustError(err)) return null
  return canInstallAtRuntime
    ? 'This network re-signs HTTPS with its own root certificate, which this app does not trust yet. Upload it under Settings → Cert for corp network.'
    : `This network re-signs HTTPS with its own root certificate. This Node (${process.version}) cannot load one while running — start hermit with NODE_EXTRA_CA_CERTS pointing at the root CA, or upgrade to Node 22 or newer.`
}
