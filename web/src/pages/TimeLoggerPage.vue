<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import { notify } from '../composables/useToast'
import TimeLoggerDayCard from '../components/TimeLoggerDayCard.vue'

// Time logger: reconcile Jira worklogs against a date range and fix them.
// Ported from the standalone jira-tickets app; it now lives inside Hermit's
// shell (nav, app bar, theme and shared snackbar all come from App.vue).
const ctx = ref(null)
const range = ref([])
const report = ref(null)
const loading = ref(false)
const error = ref('')
const confirmDialog = ref({ show: false, text: '', resolve: null })
const changed = ref('')

/** Local calendar date, not UTC - toISOString() would shift the day in +10:00. */
function toISO (d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const bounds = computed(() => {
  const dates = (range.value || []).filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b)
  if (!dates.length) return null
  return { from: toISO(dates[0]), to: toISO(dates[dates.length - 1]) }
})

const capacity = computed(() => {
  if (!report.value || !ctx.value) return 0
  const workdays = report.value.days.filter((d) => !d.weekend).length
  return Math.round(workdays * ctx.value.hoursPerDay * 100) / 100
})

const shortfall = computed(() =>
  report.value ? Math.round((capacity.value - report.value.total) * 100) / 100 : 0
)

function setRange (from, to) {
  range.value = [from, to]
}

function preset (name) {
  const today = new Date()
  const dow = (today.getDay() + 6) % 7 // Monday = 0
  const monday = new Date(today)
  monday.setDate(today.getDate() - dow)
  if (name === 'today') setRange(new Date(today), new Date(today))
  if (name === 'week') setRange(monday, new Date(today))
  if (name === 'lastWeek') {
    const start = new Date(monday)
    start.setDate(monday.getDate() - 7)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    setRange(start, end)
  }
  if (name === 'month') setRange(new Date(today.getFullYear(), today.getMonth(), 1), new Date(today))
  if (name === 'lastMonth') {
    // Day 0 of this month is the last day of the previous one.
    setRange(
      new Date(today.getFullYear(), today.getMonth() - 1, 1),
      new Date(today.getFullYear(), today.getMonth(), 0)
    )
  }
  retrieve()
}

function askConfirm (text) {
  return new Promise((resolve) => {
    // If a question is already pending (double-click, or a second row), answer it
    // "no" rather than dropping its resolver - an orphaned promise would leave the
    // caller awaiting forever, and its row spinning.
    const pending = confirmDialog.value.resolve
    if (pending) pending(false)
    confirmDialog.value = { show: true, text, resolve }
  })
}

function answerConfirm (ok) {
  const { resolve } = confirmDialog.value
  confirmDialog.value = { show: false, text: '', resolve: null }
  if (resolve) resolve(ok)
}

async function retrieve () {
  if (!bounds.value) {
    error.value = 'Pick a date range first.'
    return
  }
  loading.value = true
  error.value = ''
  try {
    report.value = await api.timeLoggerRange(bounds.value.from, bounds.value.to)
  } catch (e) {
    error.value = e.message
    report.value = null
  } finally {
    loading.value = false
  }
}

/** One write call per kind. `id` targets a single worklog; without it the day's total moves. */
function write (kind, { ticket, date, id, body }) {
  if (kind === 'insert') return api.timeLoggerInsert(body)
  if (kind === 'entryUpdate') return api.timeLoggerUpdateEntry(id, body)
  if (kind === 'entryDelete') return api.timeLoggerDeleteEntry(id, { ticket, date })
  return api.timeLoggerUpdate(body)
}

/** Apply one write, then fold the server's fresh view of that ticket back in. */
async function perform ({ kind, date, ticket, id, hours, comment, confirm, before }) {
  if (confirm && !(await askConfirm(confirm))) return
  try {
    const body = { ticket, date, hours, ...(comment ? { comment } : {}) }
    const res = await write(kind, { ticket, date, id, body })
    mergeEntry(date, res.entry)
    // Say what actually changed. The input already shows the number the user typed,
    // so without a before -> after the screen can look untouched on success.
    const was = before === undefined ? '' : `${before}h → `
    notify(`${ticket} on ${date}: ${was}${res.entry.hours}h`)
    flash(date, ticket)
  } catch (e) {
    error.value = `${ticket} on ${date}: ${e.message}`
    notify(`${ticket}: ${e.message}`, { color: 'error', hint: e.hint })
  }
}

/** Briefly mark the row that just changed, so a successful write is visible. */
function flash (date, ticket) {
  changed.value = `${date}:${ticket}`
  clearTimeout(flash.timer)
  flash.timer = setTimeout(() => { changed.value = '' }, 2600)
}

function mergeEntry (date, entry) {
  const day = report.value?.days.find((d) => d.date === date)
  if (!day) return
  const at = day.entries.findIndex((e) => e.ticket === entry.ticket)
  if (entry.hours > 0) {
    if (at >= 0) day.entries.splice(at, 1, entry)
    else day.entries.push(entry)
  } else if (at >= 0) {
    day.entries.splice(at, 1)
  }
  day.entries.sort((a, b) => b.hours - a.hours || a.ticket.localeCompare(b.ticket))
  day.total = Math.round(day.entries.reduce((s, e) => s + e.hours, 0) * 100) / 100
  report.value.total =
    Math.round(report.value.days.reduce((s, d) => s + d.total, 0) * 100) / 100
}

onMounted(async () => {
  try {
    ctx.value = await api.timeLoggerContext()
    // An unconfigured install shows the setup prompt instead of querying Jira.
    if (ctx.value.configured === false) return
    preset('week')
  } catch (e) {
    error.value = `Cannot reach the API: ${e.message}`
  }
})
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6" style="max-width: 1000px">
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <v-icon icon="mdi-clock-edit-outline" size="22" />
      <span class="text-title-medium font-weight-medium">Jira time log</span>
      <v-chip v-if="ctx && ctx.configured" size="small" variant="tonal">
        {{ ctx.project }} · {{ ctx.hoursPerDay }}h/day
      </v-chip>
      <v-chip v-if="ctx && ctx.configured" size="small" variant="text" prepend-icon="mdi-account-circle">
        {{ ctx.displayName }}
      </v-chip>
    </div>

    <v-alert v-if="ctx && !ctx.configured" type="info" variant="tonal" class="mb-4">
      <div class="font-weight-medium mb-1">Time logger is not configured</div>
      <div class="text-body-medium">
        Enter your Jira site and project key in
        <router-link to="/settings">Settings</router-link>, then reopen this page.
      </div>
    </v-alert>

    <template v-if="!ctx || ctx.configured">
    <v-card class="mb-5 pa-4">
      <div class="controls">
        <v-date-input
          v-model="range"
          label="Date range"
          multiple="range"
          prepend-icon=""
          prepend-inner-icon="mdi-calendar-range"
          density="comfortable"
          hide-details
          class="range-field"
        />
        <v-btn
          color="primary"
          size="large"
          prepend-icon="mdi-cloud-download-outline"
          :loading="loading"
          :disabled="!bounds"
          @click="retrieve"
        >
          Retrieve
        </v-btn>
      </div>
      <div class="mt-3 d-flex align-center flex-wrap ga-2">
        <span class="text-body-small text-medium-emphasis mr-1">Quick range:</span>
        <v-btn size="small" variant="text" @click="preset('today')">Today</v-btn>
        <v-btn size="small" variant="text" @click="preset('week')">This week</v-btn>
        <v-btn size="small" variant="text" @click="preset('lastWeek')">Last week</v-btn>
        <v-btn size="small" variant="text" @click="preset('month')">This month</v-btn>
        <v-btn size="small" variant="text" @click="preset('lastMonth')">Last month</v-btn>
      </div>
    </v-card>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card v-if="report" class="mb-5 pa-4" variant="tonal">
      <div class="d-flex flex-wrap ga-6 align-center">
        <div>
          <div class="text-body-small text-medium-emphasis">Logged</div>
          <div class="text-title-large">{{ report.total }}h</div>
        </div>
        <div>
          <div class="text-body-small text-medium-emphasis">Capacity (weekdays)</div>
          <div class="text-title-large">{{ capacity }}h</div>
        </div>
        <div>
          <div class="text-body-small text-medium-emphasis">
            {{ shortfall >= 0 ? 'Shortfall' : 'Over' }}
          </div>
          <div class="text-title-large" :class="shortfall > 0 ? 'text-warning' : shortfall < 0 ? 'text-error' : 'text-success'">
            {{ Math.abs(shortfall) }}h
          </div>
        </div>
        <div>
          <div class="text-body-small text-medium-emphasis">Range</div>
          <div class="text-body-large">{{ report.from }} → {{ report.to }}</div>
        </div>
      </div>
    </v-card>

    <v-skeleton-loader v-if="loading" type="card, card" />

    <template v-else-if="report">
      <TimeLoggerDayCard
        v-for="day in report.days"
        :key="day.date"
        :day="day"
        :hours-per-day="report.hoursPerDay"
        :perform="perform"
        :changed="changed"
      />
    </template>

    <v-card v-else-if="!error" variant="tonal" class="pa-8 text-center text-medium-emphasis">
      Pick a date range and hit Retrieve.
    </v-card>
    </template>

    <v-dialog v-model="confirmDialog.show" max-width="520" persistent>
      <v-card>
        <v-card-title class="text-body-large">Confirm</v-card-title>
        <v-card-text>{{ confirmDialog.text }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="answerConfirm(false)">Cancel</v-btn>
          <v-btn color="error" @click="answerConfirm(true)">Proceed</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.controls {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.range-field {
  flex: 1 1 320px;
}
</style>
