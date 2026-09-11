/**
 * Errors a provider plugin raises. Carrying a status and a hint lets the API
 * turn any plugin failure into a response the UI can act on, without the
 * routes knowing which provider produced it.
 */
export class ProviderError extends Error {
  constructor (message, { status = 502, hint } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.hint = hint
  }
}

export function notFound (message, hint) {
  return new ProviderError(message, { status: 404, hint })
}

export function unauthorised (message, hint) {
  return new ProviderError(message, { status: 401, hint })
}

export function badRequest (message, hint) {
  return new ProviderError(message, { status: 400, hint })
}
