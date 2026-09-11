import { reactive } from 'vue'

// One shared snackbar so any page can report success or failure.
export const toast = reactive({ show: false, text: '', color: 'success', hint: '' })

export function notify (text, { color = 'success', hint = '' } = {}) {
  toast.text = text
  toast.color = color
  toast.hint = hint
  toast.show = true
}

export function notifyError (err) {
  notify(err?.message || 'Something went wrong', { color: 'error', hint: err?.hint || '' })
}
