<script setup>
import { computed, ref, watch } from 'vue'

// One day of the time-logger report. Ported from the old jira-tickets app,
// with the theme coming from the Hermit shell instead of a local v-app.
const props = defineProps({
  day: { type: Object, required: true },
  hoursPerDay: { type: Number, default: 8 },
  perform: { type: Function, required: true },
  changed: { type: String, default: '' }
})

// One editable value per ticket, seeded from what Jira currently holds.
const draft = ref({})
const newTicket = ref('')
const newHours = ref(null)
const newComment = ref('')
const busyKey = ref(null)
// Ticket -> whether its row is expanded to show worklog comments.
const expanded = ref({})

/** A row opens when it has a comment to read, or more than one entry to break down. */
function hasDetail (entry) {
  return entry.worklogs.length > 1 || entry.worklogs.some((w) => w.comment)
}

function toggle (entry) {
  if (!hasDetail(entry)) return
  expanded.value = { ...expanded.value, [entry.ticket]: !expanded.value[entry.ticket] }
}

watch(
  () => props.day,
  (day) => {
    const next = {}
    for (const e of day.entries) next[e.ticket] = e.hours
    draft.value = next
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

async function onAdd () {
  const hours = num(newHours.value)
  if (!newTicket.value.trim() || !hours || hours <= 0) return
  await run('add', () =>
    props.perform({
      kind: 'insert',
      date: props.day.date,
      ticket: newTicket.value.trim(),
      hours,
      comment: newComment.value.trim() || undefined
    })
  )
  newTicket.value = ''
  newHours.value = null
  newComment.value = ''
}
</script>

<template>
  <v-card class="mb-4" :variant="day.entries.length ? 'elevated' : 'tonal'">
    <v-card-item>
      <template #prepend>
        <v-avatar :color="totalColor" variant="tonal" size="46">
          <span class="text-caption font-weight-bold">{{ day.total }}h</span>
        </v-avatar>
      </template>
      <v-card-title class="text-body-1 font-weight-medium">
        {{ day.label }}
        <v-chip v-if="day.weekend" size="x-small" class="ml-2" variant="tonal">weekend</v-chip>
      </v-card-title>
      <v-card-subtitle>
        {{ day.entries.length }} ticket{{ day.entries.length === 1 ? '' : 's' }} · {{ totalHint }}
      </v-card-subtitle>
    </v-card-item>

    <v-divider v-if="day.entries.length" />

    <v-card-text v-if="day.entries.length" class="py-2">
      <template v-for="entry in day.entries" :key="entry.ticket">
      <div
        class="entry-row py-2"
        :class="{
          'entry-changed': changed === `${day.date}:${entry.ticket}`,
          'entry-clickable': hasDetail(entry)
        }"
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
          <v-icon v-if="hasDetail(entry)" size="small" class="ml-1 entry-toggle">
            {{ expanded[entry.ticket] ? 'mdi-chevron-up' : 'mdi-chevron-down' }}
          </v-icon>
          <div class="text-caption text-medium-emphasis entry-summary">{{ entry.summary }}</div>
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

      <div v-if="expanded[entry.ticket]" class="entry-detail px-4 pb-3">
        <div v-for="w in entry.worklogs" :key="w.id" class="detail-row">
          <div class="detail-meta text-caption text-medium-emphasis">
            {{ w.started }} · {{ w.hours }}h
          </div>
          <div v-if="w.comment" class="detail-comment">{{ w.comment }}</div>
          <div v-else class="detail-comment text-medium-emphasis font-italic">No comment</div>
        </div>
      </div>
      </template>
    </v-card-text>

    <v-divider />

    <v-card-actions class="add-row px-4 py-3">
      <v-text-field
        v-model="newTicket"
        label="Add ticket"
        placeholder="PROJ-1234"
        density="compact"
        hide-details
        class="add-ticket"
        @keyup.enter="onAdd"
      />
      <v-text-field
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
      <v-text-field
        v-model="newComment"
        label="Comment (optional)"
        density="compact"
        hide-details
        class="add-comment"
        @keyup.enter="onAdd"
      />
      <v-btn
        color="primary"
        variant="tonal"
        prepend-icon="mdi-plus"
        :loading="busyKey === 'add'"
        :disabled="!newTicket.trim() || !newHours"
        @click="onAdd"
      >
        Log
      </v-btn>
    </v-card-actions>
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
  margin-top: 8px;
}
.detail-comment {
  white-space: pre-wrap;
  word-break: break-word;
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
}
.add-ticket {
  flex: 0 1 170px;
}
.add-hours {
  flex: 0 1 120px;
}
.add-comment {
  flex: 1 1 200px;
}
</style>
