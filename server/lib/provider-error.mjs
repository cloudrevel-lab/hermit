/**
 * Errors a provider plugin raises. Carrying a status and a hint lets the API
 * turn any plugin failure into a response the UI can act on, without the
 * routes knowing which provider produced it.
 *
 * `code` is for failures that have a supported alternative — a branch-policy
 * refusal can be retried as a pull request — so the UI can offer an action
 * rather than relying on the message text. `details` carries whatever that
 * action needs (the refs involved, whether the provider can open a PR).
 */
export class ProviderError extends Error {
  constructor (message, { status = 502, hint, code, details } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.hint = hint
    this.code = code
    this.details = details
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
