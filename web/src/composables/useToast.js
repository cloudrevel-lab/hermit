import { reactive } from 'vue'

// One shared snackbar so any page can report success or failure. `action` is an
// optional { label, run?, href? } shown as a snackbar button: `run` for an
// in-app follow-up (create the pull request), `href` for somewhere to go (open
// the pull request that was just created).
export const toast = reactive({ show: false, text: '', color: 'success', hint: '', action: null })

export function notify (text, { color = 'success', hint = '', action = null } = {}) {
  toast.text = text
  toast.color = color
  toast.hint = hint
  toast.action = action
  toast.show = true
}

export function dismissToast () {
  toast.show = false
  toast.action = null
}

/** Dismiss first, so a slow action cannot be fired twice by a second click. */
export function runToastAction () {
  const action = toast.action
  dismissToast()
  action?.run?.()
}

export function notifyError (err) {
  notify(err?.message || 'Something went wrong', { color: 'error', hint: err?.hint || '' })
}
