import { credentialFor } from './authinfo.mjs'
import { ProviderError, unauthorised } from './provider-error.mjs'

/**
 * JSON HTTP for provider plugins.
 *
 * Plugins differ in how they authenticate but fail in the same ways, so the
 * retry-free error handling lives here: network failures, HTML sign-in pages
 * served instead of JSON, and rate limits all become a ProviderError with a
 * hint the UI can show.
 */
export async function requestJson (url, { method = 'GET', headers = {}, body, host, authHint } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (cause) {
    throw new ProviderError(`Cannot reach ${host || new URL(url).host}: ${cause.message}`)
  }

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('json')) {
    // Azure DevOps answers an unusable token with its HTML sign-in page, often
    // under a 200 or 203 rather than a 401.
    throw unauthorised(
      `${host || new URL(url).host} returned a sign-in page instead of data`,
      authHint || 'The token is probably expired or missing the required scope.'
    )
  }

  const payload = await res.json()
  if (res.ok) return { payload, headers: res.headers }

  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
      throw new ProviderError(`Rate limit reached on ${host}`, {
        status: 429,
        hint: reset
          ? `Resets at ${new Date(reset).toLocaleTimeString()}. Adding a token raises the limit substantially.`
          : 'Adding a token to ~/.authinfo raises the limit substantially.'
      })
    }
    throw unauthorised(messageOf(payload) || `Not authorised for ${host}`, authHint)
  }

  throw new ProviderError(messageOf(payload) || `${host} responded ${res.status}`, {
    status: res.status === 404 ? 404 : 502
  })
}

function messageOf (payload) {
  return payload?.message || payload?.error?.message || payload?.errorMessages?.join(' ') || null
}

/** Looks up a credential and throws a hint-carrying error when it is required but absent. */
export async function requireCredential (host, { required = true, hint } = {}) {
  const cred = await credentialFor(host)
  if (cred?.password) return cred
  if (!required) return null
  throw unauthorised(`No credential for ${host} in ~/.authinfo`, hint)
}

export const basicAuth = (user, secret) =>
  'Basic ' + Buffer.from(`${user}:${secret}`).toString('base64')

/** Runs tasks with a concurrency cap, preserving input order. */
export async function mapLimit (items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
