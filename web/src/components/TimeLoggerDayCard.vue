<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '../api'
import { notify } from '../composables/useToast'
import MarkdownText from './MarkdownText.vue'

// One day of the time-logger report. Ported from the old jira-tickets app,
// with the theme coming from the Hermit shell instead of a local v-app.
const props = defineProps({
  day: { type: Object, required: true },
  hoursPerDay: { type: Number, default: 8 },
  perform: { type: Function, required: true },
  changed: { type: String, default: '' },
  // The active search text, when the page is filtering the range. Rows open by
  // default then, so the comment that matched is visible without a second click.
  search: { type: String, default: '' }
})

// One editable value per ticket, seeded from what Jira currently holds.
const draft = ref({})
const newTicket = ref('')
const newHours = ref(null)
const newComment = ref('')
const busyKey = ref(null)
// Typo guard: a typed key is checked against the tickets the user has logged
// time to recently, and anything outside that set is confirmed before a write.
// `verifiedTicket` remembers the accepted value so a later blur (or the Log
// click) does not ask twice for the same key.
const ticketPattern = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const verifiedTicket = ref('')
const checkingTicket = ref(false)
const ticketAlert = ref(null)
const ticketResolve = ref(null)
// What the last check learned about the verified key, so hovering the box can
// show the ticket's title rather than only the number.
const ticketInfo = ref(null)
let checkInFlight = null
const ticketField = ref(null)
const hoursField = ref(null)

const ticketChecked = computed(() => {
  const key = newTicket.value.trim().toUpperCase()
  return Boolean(key) && verifiedTicket.value === key
})

/** Null until the box holds a key this component has actually checked. */
const ticketHover = computed(() => {
  const key = newTicket.value.trim().toUpperCase()
  if (!key || verifiedTicket.value !== key) return null
  const info = ticketInfo.value
  if (!info || info.ticket !== key) return null
  return { text: info.summary || 'Ticket verified', status: info.status || null }
})

function rememberTicket (key, summary, status) {
  ticketInfo.value = {
    ticket: key.toUpperCase(),
    summary: summary || '',
    status: status || null
  }
}
// Ticket -> whether its row is expanded to show worklog comments.
const expanded = ref({})
// Worklog id -> editable hours for that single entry, independent of the
// ticket-level box above it.
const logDraft = ref({})
// Comment editing is one entry at a time, so a single draft is enough:
// - worklog id being edited, or null
// - the text being typed, seeded from the comment Jira currently holds
const commentEditId = ref(null)
const commentDraft = ref('')

/**
 * Every row opens, even a single entry without a comment: the panel is where an
 * entry's start time and comment are shown, and where a comment is added or
 * edited after the worklog was logged. While a search is active a row starts
 * open, because the matched comment is usually inside it; an explicit toggle
 * still wins.
 */
function toggle (entry) {
  expanded.value = { ...expanded.value, [entry.ticket]: !isOpen(entry) }
}

function isOpen (entry) {
  return expanded.value[entry.ticket] ?? Boolean(props.search)
}

watch(
  () => props.day,
  (day) => {
    const next = {}
    const logs = {}
    for (const e of day.entries) {
      next[e.ticket] = e.hours
      for (const w of e.worklogs) logs[w.id] = w.hours
    }
    draft.value = next
    logDraft.value = logs
    busyKey.value = null
  },
  { immediate: true, deep: true }
)

const totalColor = computed(() => {
  if (props.day.weekend && props.day.total === 0) return 'default'
  const delta = props.day.total - props.hoursPerDay
  if (Math.abs(delta) < 0.05) return 'success'
  return delta > 0 ? 'error' : 'warning'
})

const totalHint = computed(() => {
  const delta = Math.round((props.day.total - props.hoursPerDay) * 100) / 100
  if (props.day.weekend && props.day.total === 0) return 'weekend'
  if (Math.abs(delta) < 0.05) return 'full day'
  return delta > 0 ? `${delta}h over` : `${Math.abs(delta)}h short`
})

/**
 * "2 tickets · 3h short", or "2 matching tickets" while the range is filtered.
 * The day's total stays the real one — filtering narrows which rows are shown,
 * it does not pretend the rest of the day's time is gone.
 */
const subtitle = computed(() => {
  const n = props.day.entries.length
  const tickets = `${n}${props.search ? ' matching' : ''} ticket${n === 1 ? '' : 's'}`
  return `${tickets} · ${totalHint.value}`
})

function num (value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Updating replaces the day's entries, so warn when that destroys something. */
function updateWarning (entry) {
  const next = num(draft.value[entry.ticket])
  if (next === 0) return `Delete all ${entry.worklogs.length} entry(s) for ${entry.ticket} on ${props.day.label}?`
  if (entry.worklogs.length > 1) {
    return `${entry.ticket} has ${entry.worklogs.length} entries that day (${entry.worklogs
      .map((w) => `${w.hours}h at ${w.started}`)
      .join(', ')}). Updating collapses them into a single ${next}h entry.`
  }
  return null
}

function updateTip (entry) {
  const next = num(draft.value[entry.ticket])
  if (next === null) return 'Enter a number first'
  if (next === 0) return `Delete the ${entry.hours}h logged on ${props.day.label}`
  return `Set ${props.day.label} to ${next}h (currently ${entry.hours}h)`
}

function insertTip (entry) {
  const extra = num(draft.value[entry.ticket])
  if (!extra) return 'Enter hours to add'
  return `Add ${extra}h on top - ${entry.hours}h becomes ${Math.round((entry.hours + extra) * 100) / 100}h`
}

async function run (key, fn) {
  busyKey.value = key
  try {
    await fn()
  } finally {
    busyKey.value = null
  }
}

function onUpdate (entry) {
  const hours = num(draft.value[entry.ticket])
  if (hours === null || hours < 0) return
  run(`u:${entry.ticket}`, () =>
    props.perform({
      kind: 'update',
      date: props.day.date,
      ticket: entry.ticket,
      hours,
      before: entry.hours,
      confirm: updateWarning(entry)
    })
  )
}

function onInsert (entry) {
  const hours = num(draft.value[entry.ticket])
  if (!hours || hours <= 0) return
  run(`i:${entry.ticket}`, () =>
    props.perform({
      kind: 'insert',
      date: props.day.date,
      ticket: entry.ticket,
      hours,
      before: entry.hours
    })
  )
}

function onDelete (entry) {
  run(`d:${entry.ticket}`, () =>
    props.perform({
      kind: 'update',
      date: props.day.date,
      ticket: entry.ticket,
      hours: 0,
      before: entry.hours,
      confirm: `Delete all time logged on ${entry.ticket} for ${props.day.label} (${entry.hours}h)?`
    })
  )
}

/** Retime one worklog. Zero is not accepted here - deleting has its own button. */
function onLogUpdate (entry, log) {
  const hours = num(logDraft.value[log.id])
  if (!hours || hours <= 0) return
  run(`lu:${log.id}`, () =>
    props.perform({
      kind: 'entryUpdate',
      date: props.day.date,
      ticket: entry.ticket,
      id: log.id,
      hours,
      before: entry.hours
    })
  )
}

function onLogDelete (entry, log) {
  run(`ld:${log.id}`, () =>
    props.perform({
      kind: 'entryDelete',
      date: props.day.date,
      ticket: entry.ticket,
      id: log.id,
      before: entry.hours,
      confirm: `Delete the ${log.hours}h entry at ${log.started} on ${entry.ticket} (${props.day.label})?`
    })
  )
}

function logUpdateTip (log) {
  const next = num(logDraft.value[log.id])
  if (!next || next <= 0) return 'Enter hours greater than 0'
  return `Set this entry to ${next}h (currently ${log.hours}h); the day's other entries are untouched`
}

function startCommentEdit (log) {
  commentEditId.value = log.id
  commentDraft.value = log.comment || ''
}

function cancelCommentEdit () {
  commentEditId.value = null
  commentDraft.value = ''
}

/**
 * Save an edited comment without touching the entry's hours.
 *
 * Jira's own comment text is plain, and the read path escapes anything that
 * would otherwise look like Markdown, so an ordinary comment survives this round
 * trip unchanged. A comment that was *formatted* in Jira comes back as Markdown
 * and is re-saved as those literal characters — the edit box is plain text, like
 * the one that created it. An empty box clears the comment.
 */
async function onCommentSave (entry, log) {
  const text = commentDraft.value.trim()
  if (text === (log.comment || '').trim()) {
    cancelCommentEdit()
    return
  }
  let saved = false
  await run(`lc:${log.id}`, async () => {
    saved = await props.perform({
      kind: 'entryUpdate',
      date: props.day.date,
      ticket: entry.ticket,
      id: log.id,
      hours: log.hours,
      comment: text,
      what: 'comment'
    })
  })
  // Leave the box open with the typed text when the write failed, so nothing is
  // lost and the user can retry or copy it.
  if (saved) cancelCommentEdit()
}

// Shown in the Log button's tooltip so the shortcut is discoverable; the
// handler itself accepts either modifier regardless of platform.
const isMac = typeof navigator !== 'undefined' &&
  /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '')
const submitHint = isMac ? '\u2318 + Enter' : 'Ctrl + Enter'

/**
 * In the comment box Enter belongs to the textarea, so only the modified
 * combination logs the entry. Both modifiers are accepted: Cmd is the Mac
 * idiom, Ctrl the one everywhere else, and honouring each costs nothing.
 */
function onCommentKey (event) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  onAdd()
}

function focusTicket () {
  nextTick(() => {
    const input = ticketField.value?.$el?.querySelector('input')
    input?.focus()
    input?.select()
  })
}

function focusHours () {
  nextTick(() => hoursField.value?.focus())
}

/**
 * Ask the user to confirm a key that is not among their recent tickets. Resolves
 * 'continue' (write it), 'reject' (go back and fix it) or 'pick' (a suggested
 * recent ticket took its place).
 */
function askTicket (verdict) {
  return new Promise((resolve) => {
    // Answer a question that is already open "no" rather than dropping its
    // resolver, which would leave its caller awaiting forever.
    const pending = ticketResolve.value
    if (pending) pending('reject')
    ticketAlert.value = verdict
    ticketResolve.value = resolve
  })
}

function answerTicket (decision) {
  const resolve = ticketResolve.value
  ticketAlert.value = null
  ticketResolve.value = null
  if (resolve) resolve(decision)
}

/** A suggestion is one of the user's recent tickets, so it is already trusted. */
function useSuggestion (key) {
  const suggestion = ticketAlert.value?.suggestions?.find(s => s.ticket === key)
  newTicket.value = key
  verifiedTicket.value = key.toUpperCase()
  rememberTicket(key, suggestion?.summary)
  answerTicket('pick')
}

async function runTicketCheck (key) {
  checkingTicket.value = true
  let verdict
  try {
    verdict = await api.timeLoggerVerifyTicket(key)
  } catch (e) {
    // A failed check must not block a write the user asked for; Jira still
    // rejects a bad key on the write itself.
    notify('Could not check ' + key + ': ' + e.message, { color: 'warning', hint: e.hint })
    verifiedTicket.value = key
    return true
  } finally {
    checkingTicket.value = false
  }
  if (verdict.recent) {
    verifiedTicket.value = key
    rememberTicket(key, verdict.summary, verdict.status)
    return true
  }
  const decision = await askTicket(verdict)
  if (decision === 'reject') {
    focusTicket()
    return false
  }
  if (decision === 'pick') {
    focusHours()
    return true
  }
  // "Continue anyway" is the user's cue to carry on with hours and comment.
  focusHours()
  verifiedTicket.value = key
  rememberTicket(key, verdict.summary, verdict.status)
  return true
}

/** Resolves true when the key is safe to write; runs at most once per value. */
function ensureTicketVerified (key) {
  const trimmed = key.trim()
  // A key that is not ticket-shaped is left to the write path, which rejects it
  // with a useful message rather than a pointless lookup.
  if (!ticketPattern.test(trimmed)) return Promise.resolve(true)
  const normalized = trimmed.toUpperCase()
  if (verifiedTicket.value === normalized) return Promise.resolve(true)
  if (checkInFlight?.key === normalized) return checkInFlight.promise
  const promise = runTicketCheck(normalized).finally(() => {
    if (checkInFlight?.promise === promise) checkInFlight = null
  })
  checkInFlight = { key: normalized, promise }
  return promise
}

async function onTicketBlur () {
  const key = newTicket.value.trim()
  if (!key || !ticketPattern.test(key)) return
  await ensureTicketVerified(key)
}

async function onAdd () {
  const ticket = newTicket.value.trim()
  const hours = num(newHours.value)
  if (!ticket || !hours || hours <= 0) return
  // Reaching Log without leaving the field still has to clear the guard.
  if (!(await ensureTicketVerified(ticket))) return
  await run('add', () =>
    props.perform({
      kind: 'insert',
      date: props.day.date,
      ticket,
      hours,
      comment: newComment.value.trim() || undefined
    })
  )
  newTicket.value = ''
  newHours.value = null
  newComment.value = ''
  verifiedTicket.value = ''
  ticketInfo.value = null
}
</script>

<template>
  <v-card class="mb-4" :variant="day.entries.length ? 'elevated' : 'tonal'">
    <v-card-item>
      <template #prepend>
        <v-avatar :color="totalColor" variant="tonal" size="46">
          <span class="text-body-small font-weight-bold">{{ day.total }}h</span>
        </v-avatar>
      </template>
      <v-card-title class="text-body-large font-weight-medium">
        {{ day.label }}
        <v-chip v-if="day.weekend" size="x-small" class="ml-2" variant="tonal">weekend</v-chip>
      </v-card-title>
      <v-card-subtitle>{{ subtitle }}</v-card-subtitle>
    </v-card-item>

    <v-divider v-if="day.entries.length" />

    <v-card-text v-if="day.entries.length" class="py-2">
      <template v-for="entry in day.entries" :key="entry.ticket">
      <div
        class="entry-row py-2 entry-clickable"
        :class="{ 'entry-changed': changed === `${day.date}:${entry.ticket}` }"
        @click="toggle(entry)"
      >
        <div class="entry-ident">
          <a
            :href="entry.url"
            target="_blank"
            rel="noopener"
            class="text-primary font-weight-medium"
            @click.stop
          >
            {{ entry.ticket }}
          </a>
          <v-chip
            v-if="entry.worklogs.length > 1"
            size="x-small"
            color="warning"
            variant="tonal"
            class="ml-2"
          >
            {{ entry.worklogs.length }} entries
          </v-chip>
          <v-icon size="small" class="ml-1 entry-toggle">
            {{ isOpen(entry) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}
          </v-icon>
          <div class="text-body-small text-medium-emphasis entry-summary">{{ entry.summary }}</div>
        </div>

        <v-text-field
          v-model="draft[entry.ticket]"
          type="number"
          @click.stop
          step="0.25"
          min="0"
          max="24"
          density="compact"
          hide-details
          suffix="h"
          class="entry-hours"
        />

        <div class="entry-actions" @click.stop>
          <v-tooltip :text="updateTip(entry)" location="top">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                size="small"
                color="primary"
                :loading="busyKey === `u:${entry.ticket}`"
                @click="onUpdate(entry)"
              >
                Update
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip :text="insertTip(entry)" location="top">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                size="small"
                color="primary"
                variant="tonal"
                :loading="busyKey === `i:${entry.ticket}`"
                @click="onInsert(entry)"
              >
                Insert
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip text="Delete this day's time for the ticket" location="top">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                size="small"
                variant="text"
                icon="mdi-trash-can-outline"
                :loading="busyKey === `d:${entry.ticket}`"
                @click="onDelete(entry)"
              />
            </template>
          </v-tooltip>
        </div>
      </div>

      <div v-if="isOpen(entry)" class="entry-detail px-4 pb-3">
        <div v-for="w in entry.worklogs" :key="w.id" class="detail-row">
          <div class="detail-head">
            <div class="detail-meta text-body-small text-medium-emphasis">
              {{ w.started }} · {{ w.hours }}h
            </div>
            <div class="detail-actions">
              <v-text-field
                v-model="logDraft[w.id]"
                type="number"
                step="0.25"
                min="0"
                max="24"
                density="compact"
                hide-details
                suffix="h"
                class="detail-hours"
              />
              <v-tooltip :text="logUpdateTip(w)" location="top">
                <template #activator="{ props: tip }">
                  <v-btn
                    v-bind="tip"
                    size="x-small"
                    color="primary"
                    variant="tonal"
                    :loading="busyKey === `lu:${w.id}`"
                    @click="onLogUpdate(entry, w)"
                  >
                    Update
                  </v-btn>
                </template>
              </v-tooltip>
              <v-tooltip :text="w.comment ? 'Edit this comment' : 'Add a comment'" location="top">
                <template #activator="{ props: tip }">
                  <v-btn
                    v-bind="tip"
                    size="x-small"
                    variant="text"
                    icon="mdi-comment-edit-outline"
                    :disabled="commentEditId === w.id"
                    @click="startCommentEdit(w)"
                  />
                </template>
              </v-tooltip>
              <v-tooltip text="Delete just this entry" location="top">
                <template #activator="{ props: tip }">
                  <v-btn
                    v-bind="tip"
                    size="x-small"
                    variant="text"
                    icon="mdi-trash-can-outline"
                    :loading="busyKey === `ld:${w.id}`"
                    @click="onLogDelete(entry, w)"
                  />
                </template>
              </v-tooltip>
            </div>
          </div>
          <div v-if="commentEditId === w.id" class="detail-comment-edit">
            <v-textarea
              v-model="commentDraft"
              label="Comment"
              placeholder="Leave blank to remove the comment"
              density="compact"
              hide-details
              rows="1"
              max-rows="8"
              auto-grow
              autofocus
              @keydown.enter.meta.prevent="onCommentSave(entry, w)"
              @keydown.enter.ctrl.prevent="onCommentSave(entry, w)"
              @keydown.esc="cancelCommentEdit"
            />
            <div class="d-flex align-center ga-2 mt-2">
              <v-btn
                size="x-small"
                color="primary"
                variant="tonal"
                :loading="busyKey === `lc:${w.id}`"
                @click="onCommentSave(entry, w)"
              >
                Save
              </v-btn>
              <v-btn size="x-small" variant="text" @click="cancelCommentEdit">Cancel</v-btn>
              <span class="text-body-small text-medium-emphasis">
                Blank removes it · {{ submitHint }} saves
              </span>
            </div>
          </div>
          <template v-else>
            <MarkdownText v-if="w.comment" :text="w.comment" class="detail-comment" />
            <div v-else class="detail-comment text-medium-emphasis font-italic">No comment</div>
          </template>
        </div>
      </div>
      </template>
    </v-card-text>

    <v-divider />

    <v-card-actions class="add-row px-4 py-3">
      <v-tooltip :disabled="!ticketHover" location="top" max-width="380">
        <template #activator="{ props: tip }">
          <div v-bind="tip" class="add-ticket">
            <v-text-field
              ref="ticketField"
              v-model="newTicket"
              label="Add ticket"
              placeholder="PROJ-1234"
              density="compact"
              hide-details
              :loading="checkingTicket"
              :append-inner-icon="ticketChecked ? 'mdi-check-circle' : undefined"
              @blur="onTicketBlur"
              @keydown.enter.prevent="focusHours"
            />
          </div>
        </template>
        <div class="text-body-medium">{{ ticketHover?.text }}</div>
        <div v-if="ticketHover?.status" class="text-body-small text-medium-emphasis mt-1">
          {{ ticketHover.status }}
        </div>
      </v-tooltip>
      <v-text-field
        ref="hoursField"
        v-model="newHours"
        label="Hours"
        type="number"
        step="0.25"
        min="0"
        max="24"
        density="compact"
        hide-details
        suffix="h"
        class="add-hours"
        @keyup.enter="onAdd"
      />
      <v-textarea
        v-model="newComment"
        label="Comment (optional)"
        density="compact"
        hide-details
        rows="1"
        max-rows="8"
        auto-grow
        class="add-comment"
        @keydown="onCommentKey"
      />
      <v-tooltip :text="`Log the entry (${submitHint})`" location="top">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-plus"
            :loading="busyKey === 'add'"
            :disabled="!newTicket.trim() || !newHours"
            @click="onAdd"
          >
            Log
          </v-btn>
        </template>
      </v-tooltip>
    </v-card-actions>

    <!-- The typo guard's reminder: shown when a typed key is not one of the
         tickets the user logged time to in the lookback window. -->
    <v-dialog :model-value="Boolean(ticketAlert)" max-width="580" persistent>
      <v-card v-if="ticketAlert">
        <v-card-title class="d-flex align-center ga-2 text-title-small">
          <v-icon
            :color="ticketAlert.exists ? 'warning' : 'error'"
            :icon="ticketAlert.exists ? 'mdi-help-circle-outline' : 'mdi-alert-circle-outline'"
          />
          {{ ticketAlert.exists ? 'Double-check this ticket' : 'Ticket not found' }}
        </v-card-title>
        <v-card-text>
          <template v-if="ticketAlert.exists">
            <div class="d-flex align-center flex-wrap ga-2 mb-1">
              <a
                :href="ticketAlert.url"
                target="_blank"
                rel="noopener"
                class="text-primary font-weight-medium text-title-medium"
              >
                {{ ticketAlert.ticket }}
              </a>
              <v-chip v-if="ticketAlert.status" size="x-small" variant="tonal">{{ ticketAlert.status }}</v-chip>
            </div>
            <div class="text-body-large mb-4">{{ ticketAlert.summary }}</div>
            <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
              <template v-if="ticketAlert.lastLogged">
                You have not logged time to this ticket in the last {{ ticketAlert.windowDays }} days;
                the last time was {{ ticketAlert.lastLogged }}.
              </template>
              <template v-else>
                You have never logged time to this ticket.
              </template>
              Make sure it is the one you mean before logging.
            </v-alert>
          </template>
          <v-alert v-else type="error" variant="tonal" density="compact" class="mb-3">
            <strong>{{ ticketAlert.ticket }}</strong> does not exist in Jira. The number is probably mistyped.
          </v-alert>

          <template v-if="ticketAlert.suggestions && ticketAlert.suggestions.length">
            <div class="text-body-medium text-medium-emphasis mb-1">
              Closest tickets you have logged recently — did you mean one of these?
            </div>
            <v-list density="compact" class="ticket-suggestions">
              <v-list-item
                v-for="s in ticketAlert.suggestions"
                :key="s.ticket"
                :title="s.ticket"
                :subtitle="s.summary"
                @click="useSuggestion(s.ticket)"
              >
                <template #prepend>
                  <v-icon icon="mdi-history" size="18" />
                </template>
              </v-list-item>
            </v-list>
          </template>
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" prepend-icon="mdi-pencil-outline" @click="answerTicket('reject')">
            Not the one
          </v-btn>
          <v-spacer />
          <v-btn color="primary" variant="tonal" prepend-icon="mdi-check" @click="answerTicket('continue')">
            Continue anyway
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.entry-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
/* General sibling, not adjacent: an expanded detail panel sits between rows. */
.entry-row ~ .entry-row {
  border-top: 1px solid rgb(var(--v-border-color), 0.12);
}
/* A successful write often leaves the number the user typed on screen unchanged,
   so mark the row itself for a moment. */
.entry-changed {
  animation: flash 2.4s ease-out;
  border-radius: 6px;
}
@keyframes flash {
  0%,
  40% {
    background: rgba(var(--v-theme-success), 0.22);
  }
  100% {
    background: transparent;
  }
}
.entry-clickable {
  cursor: pointer;
}
.entry-clickable:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-radius: 6px;
}
.entry-toggle {
  color: rgb(var(--v-theme-on-surface-variant));
}
.entry-detail {
  border-top: 1px dashed rgba(var(--v-border-color), 0.16);
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.detail-row + .detail-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(var(--v-border-color), 0.1);
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.detail-meta {
  flex: 1 1 auto;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.detail-hours {
  flex: 0 0 92px;
}
.detail-comment {
  word-break: break-word;
}
.detail-comment-edit {
  margin-top: 10px;
}
.entry-ident {
  flex: 1 1 260px;
  min-width: 0;
}
.entry-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-hours {
  flex: 0 0 110px;
}
.entry-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.add-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  /* The comment box grows downward, so anchor the row rather than letting the
     other controls drift down the middle of it. */
  align-items: flex-start;
}
.add-row .v-btn {
  /* Line the button up with the single-row height of the fields beside it. */
  margin-top: 2px;
}
.add-ticket {
  flex: 0 1 170px;
  min-width: 0;
}
.add-hours {
  flex: 0 1 120px;
}
.add-comment {
  flex: 1 1 200px;
}
/* Suggested tickets carry whole summaries; let them wrap and clamp rather than
   stretching the dialog to fit the longest one. */
.ticket-suggestions {
  background: transparent;
}
.ticket-suggestions :deep(.v-list-item-subtitle) {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: normal;
}
</style>
