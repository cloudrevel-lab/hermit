import { ref } from 'vue'

/**
 * Timezone all dates are rendered in. Empty means "whatever the browser is set
 * to", which is the default. Held as a ref so that changing it in Settings
 * re-renders every date on screen without a reload — the format helpers read it
 * during render, so Vue tracks them.
 */
const timezone = ref('')

export function isValidTimezone (tz) {
  if (!tz) return true
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function setDisplayTimezone (tz) {
  // A zone the runtime does not know would throw on every date we format, so
  // an unusable value is dropped rather than allowed to break the page.
  timezone.value = isValidTimezone(tz) ? (tz || '') : ''
}

/** The zone actually in effect, with the browser default resolved to a name. */
export function resolvedTimezone () {
  return timezone.value || Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function browserTimezone () {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Adds the configured zone to Intl options, leaving the default alone. */
function zoned (options) {
  return timezone.value ? { ...options, timeZone: timezone.value } : options
}

// Each step is [how many of the current unit make one of the next, the unit you
// get by dividing]. Pairing a divisor with the unit being divided *from* is an
// easy mistake and silently labels everything one unit too small — 22 hours
// renders as "22 minutes".
const STEPS = [
  [60, 'minute'],
  [60, 'hour'],
  [24, 'day'],
  [7, 'week'],
  [4.348, 'month'],
  [12, 'year']
]

export function relativeTime (iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  let value = Math.round((Date.now() - then) / 1000)
  let unit = 'second'
  for (const [perNext, nextUnit] of STEPS) {
    if (Math.abs(value) < perNext) break
    value = Math.round(value / perNext)
    unit = nextUnit
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-value, unit)
}

function parsed (iso) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Calendar date beside a relative time, as "2026-09-07 Mon".
 *
 * Assembled from formatted parts rather than sliced off the ISO string: a
 * commit made late in the UTC day falls on the next day in Sydney, and slicing
 * would show the wrong one. Going through Intl also means the configured
 * timezone is honoured, which reading getDate() would not do.
 */
export function dateStamp (iso) {
  const date = parsed(iso)
  if (!date) return ''
  const parts = new Intl.DateTimeFormat(undefined, zoned({
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  })).formatToParts(date)
  const part = type => parts.find(p => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('weekday')}`
}

const ABSOLUTE = {
  weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
}

/** Full timestamp for the tooltip behind a relative time, zone included. */
export function absoluteTime (iso) {
  const date = parsed(iso)
  if (!date) return ''
  return date.toLocaleString(undefined, zoned(ABSOLUTE))
}

/**
 * The same rendering for an explicit zone, without touching the configured one
 * — so Settings can preview a zone the user has not committed to yet.
 */
export function absoluteTimeIn (iso, tz) {
  const date = parsed(iso)
  if (!date) return ''
  if (!isValidTimezone(tz)) return ''
  return date.toLocaleString(undefined, tz ? { ...ABSOLUTE, timeZone: tz } : ABSOLUTE)
}

export function shortDate (iso) {
  const date = parsed(iso)
  if (!date) return ''
  return date.toLocaleDateString(undefined, zoned({ day: '2-digit', month: 'short', year: 'numeric' }))
}

/** First line of a commit message, with the Azure "Merged PR 123: " noise kept but marked. */
export function commitTitle (message) {
  return String(message || '').split('\n')[0].trim()
}

export function commitBody (message) {
  const lines = String(message || '').split('\n').slice(1)
  return lines.join('\n').trim()
}

export function extractKeys (text, pattern = '[A-Z][A-Z0-9]+-\\d+') {
  return [...new Set(String(text || '').match(new RegExp(pattern, 'g')) || [])]
}

export function initials (name) {
  return String(name || '?')
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || '')
    .join('')
}
