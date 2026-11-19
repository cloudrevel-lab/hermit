<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { notify } from '../composables/useToast'
import { readStored, writeStored } from '../composables/useStored'
import TimeLoggerDayCard from '../components/TimeLoggerDayCard.vue'
import MarkdownText from '../components/MarkdownText.vue'

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
// Free text for the loaded range (filtered in the browser) and, separately, the
// result of a server-side scan across history.
const search = ref('')
const history = ref(null)
const historyLoading = ref(false)
const historyError = ref('')
const historyMs = ref(0)

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

// Latest first is the default: the day being worked on belongs at the top, not
// under a week of history. Remembered because it is a preference, not a result.
const storedSort = readStored('timeLoggerSort', 'desc')
const sortOrder = ref(storedSort === 'asc' ? 'asc' : 'desc')

/** The range as displayed. The server always sends days ascending. */
const days = computed(() => {
  const list = report.value?.days || []
  // Reverse a copy: report.days is what mergeEntry() splices into.
  return sortOrder.value === 'asc' ? list : [...list].reverse()
})

// ---------------------------------------------------------------- searching
//
// Two scopes, because they cost very different things:
//   - the loaded range is already in this page, so filtering it is free and
//     happens on every keystroke (visibleDays below);
//   - all history is not: Jira has no JQL field for worklog text, so the server
//     has to read every ticket's worklogs (one request each). That is a
//     deliberate, explicit action ("Search 12 months") and it is cached.
// Every term has to appear, and may be spread across the key, the summary and
// the comments.
// `clearable` sets the model to null, not '', so every read goes through this.
const query = computed(() => String(search.value || '').trim())

const searchTerms = computed(() =>
  query.value.toLowerCase().split(/\s+/).filter(Boolean)
)

function matchesTerms (text, terms) {
  const haystack = text.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

function entryMatches (entry, terms) {
  const head = `${entry.ticket} ${entry.summary}`
  if (matchesTerms(head, terms)) return true
  return entry.worklogs.some((w) => matchesTerms(`${head} ${w.comment || ''}`, terms))
}

/** The sorted days, narrowed to entries that match — the same cards, filtered. */
const visibleDays = computed(() => {
  if (!searchTerms.value.length) return days.value
  return days.value
    .map((day) => {
      const entries = day.entries.filter((e) => entryMatches(e, searchTerms.value))
      return entries.length ? { ...day, entries } : null
    })
    .filter(Boolean)
})

/** What the search box reports about the loaded range. */
const rangeHits = computed(() => {
  if (!searchTerms.value.length) return null
  const entries = visibleDays.value.reduce((n, day) => n + day.entries.length, 0)
  return { entries, days: visibleDays.value.length }
})

const canSearchHistory = computed(() => searchTerms.value.join(' ').length >= 2)

// Every scan gets a number, so a slow answer to an older query can be dropped
// instead of overwriting newer results or clearing a newer spinner.
let searchSeq = 0

/**
 * Scan the last 12 months on the server. Slower than the in-range filter (one
 * Jira request per ticket touched), so it only runs on an explicit click or
 * Enter — never while typing.
 */
async function searchHistory () {
  if (!canSearchHistory.value) return
  const term = query.value
  const seq = ++searchSeq
  historyLoading.value = true
  historyError.value = ''
  const at = Date.now()
  try {
    const res = await api.timeLoggerSearch(term)
    // The box may have moved on while the scan ran; those results answer an old
    // question and the watcher already cleared them.
    if (seq !== searchSeq || query.value !== term) return
    history.value = res
    historyMs.value = Date.now() - at
  } catch (e) {
    if (seq !== searchSeq || query.value !== term) return
    historyError.value = e.message
    notify(`Search failed: ${e.message}`, { color: 'error', hint: e.hint })
  } finally {
    if (seq === searchSeq) historyLoading.value = false
  }
}

/** A result row is a shortcut to the day it belongs to, where it can be fixed. */
function openDay (date) {
  history.value = null
  search.value = ''
  setRange(date, date)
  retrieve()
}

// Editing the query means a new search: the old results would answer a question
// nobody is asking any more.
watch(search, () => {
  history.value = null
  historyError.value = ''
})

function toggleSort () {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'
  writeStored('timeLoggerSort', sortOrder.value)
}

function setRange (from, to) {
  range.value = [from, to]
}

/** `day` two calendar months back, clamped to the end of a shorter month. */
function twoMonthsBefore (day) {
  const start = new Date(day.getFullYear(), day.getMonth() - 2, day.getDate())
  // JS rolls 31 Sep into 1 Oct; the window should end on the 30th instead.
  if (start.getDate() !== day.getDate()) start.setDate(0)
  return start
}

/** The page's default window: the two months up to and including `day`. */
function defaultRange (day) {
  return { from: twoMonthsBefore(day), to: new Date(day) }
}

function preset (name) {
  const today = new Date()
  const dow = (today.getDay() + 6) % 7 // Monday = 0
  const monday = new Date(today)
  monday.setDate(today.getDate() - dow)
  if (name === 'today') setRange(new Date(today), new Date(today))
  if (name === 'week') setRange(monday, new Date(today))
  // Broad enough that the last couple of months of worklogs are on hand to
  // filter, narrow enough to load in about a second.
  if (name === 'twoMonths') {
    const window = defaultRange(today)
    setRange(window.from, window.to)
  }
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
  // A fresh range means the range view, not yesterday's search results.
  history.value = null
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
async function perform ({ kind, date, ticket, id, hours, comment, confirm, before, what }) {
  if (confirm && !(await askConfirm(confirm))) return false
  try {
    // A comment string replaces the entry's comment — an empty one clears it.
    // Leaving it undefined keeps whatever Jira already holds.
    const body = { ticket, date, hours, ...(comment !== undefined ? { comment } : {}) }
    const res = await write(kind, { ticket, date, id, body })
    mergeEntry(date, res.entry)
    // Say what actually changed. The input already shows the number the user typed,
    // so without a before -> after the screen can look untouched on success.
    const was = before === undefined ? '' : `${before}h → `
    notify(
      `${ticket} on ${date}: ` +
        (what === 'comment' ? 'comment updated' : `${was}${res.entry.hours}h`)
    )
    flash(date, ticket)
    return true
  } catch (e) {
    error.value = `${ticket} on ${date}: ${e.message}`
    notify(`${ticket}: ${e.message}`, { color: 'error', hint: e.hint })
    return false
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

/**
 * The page tends to stay open all day (it is where time gets logged), but the
 * range is fixed when it loads, so a new calendar day would only appear after a
 * reload. Poll the local date — a string compare, no request — and when it has
 * moved, extend a range that ended on the old "today" and re-read it, so the
 * morning opens on the current day's card. A range pointed at the past gains
 * nothing from a new day, so it is left alone.
 */
const NEW_DAY_CHECK_MS = 10 * 60 * 1000
let todayIso = toISO(new Date())
let newDayTimer = null

function checkNewDay () {
  const now = toISO(new Date())
  if (!todayIso) {
    todayIso = now
    return
  }
  if (now === todayIso) return
  const previous = todayIso
  todayIso = now
  if (!ctx.value?.configured || !report.value || loading.value) return
  if (bounds.value?.to !== previous) return

  const from = bounds.value.from
  // The default window is "the last two months", so it rolls rather than grows:
  // the server refuses ranges over 92 days, and a tab left open for weeks would
  // otherwise creep into that. Anything the user chose otherwise keeps its start
  // and just gains the new day; a one-day range moves to the new day.
  const previousDefault = defaultRange(new Date(`${previous}T00:00:00`))
  if (from === toISO(previousDefault.from)) {
    const next = defaultRange(new Date())
    range.value = [next.from, next.to]
  } else {
    range.value = from === previous ? [now, now] : [from, now]
  }
  retrieve()
}

// A sleeping laptop throttles timers, so waking the tab is the moment that
// matters most: check then rather than waiting out the rest of the interval.
function onVisibility () {
  if (document.visibilityState === 'visible') checkNewDay()
}

onMounted(async () => {
  todayIso = toISO(new Date())
  newDayTimer = setInterval(checkNewDay, NEW_DAY_CHECK_MS)
  window.addEventListener('focus', checkNewDay)
  document.addEventListener('visibilitychange', onVisibility)
  try {
    ctx.value = await api.timeLoggerContext()
    // An unconfigured install shows the setup prompt instead of querying Jira.
    if (ctx.value.configured === false) return
    preset('twoMonths')
  } catch (e) {
    error.value = `Cannot reach the API: ${e.message}`
  }
})

onBeforeUnmount(() => {
  clearInterval(newDayTimer)
  window.removeEventListener('focus', checkNewDay)
  document.removeEventListener('visibilitychange', onVisibility)
  clearTimeout(flash.timer)
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
    <v-card class="mb-4 pa-4">
      <div class="search-row">
        <v-text-field
          v-model="search"
          label="Search tickets and comments"
          placeholder="AIE-4233, monitoring, standup…"
          prepend-inner-icon="mdi-magnify"
          density="comfortable"
          hide-details
          clearable
          class="search-field"
          @keydown.enter="searchHistory"
        />
        <v-tooltip
          text="Reads every ticket you logged time to in the last 12 months. Slower than the filter above."
          location="top"
          max-width="320"
        >
          <template #activator="{ props: tip }">
            <v-btn
              v-bind="tip"
              size="large"
              variant="tonal"
              prepend-icon="mdi-history"
              :loading="historyLoading"
              :disabled="!canSearchHistory"
              @click="searchHistory"
            >
              Search 12 months
            </v-btn>
          </template>
        </v-tooltip>
      </div>
      <div class="text-body-small text-medium-emphasis mt-2">
        <template v-if="historyLoading">
          Scanning every ticket you logged time to in the last 12 months…
        </template>
        <template v-else-if="history">
          <template v-if="history.days.length">
            Showing matches from the last 12 months. Click a result to load that day
            and fix it.
          </template>
          <template v-else>Try a word you remember typing in a comment.</template>
        </template>
        <template v-else-if="rangeHits">
          <template v-if="rangeHits.entries">
            {{ rangeHits.entries }} match{{ rangeHits.entries === 1 ? '' : 'es' }}
            on {{ rangeHits.days }} day{{ rangeHits.days === 1 ? '' : 's' }} in the loaded range.
          </template>
          <template v-else>
            Nothing in the loaded range matches — <strong>Search 12 months</strong>
            looks further back.
          </template>
        </template>
        <template v-else>
          Filters the days below as you type. “Search 12 months” also looks at logs
          outside the loaded range.
        </template>
      </div>
    </v-card>

    <v-alert
      v-if="historyError"
      type="error"
      variant="tonal"
      class="mb-4"
      closable
      @click:close="historyError = ''"
    >
      {{ historyError }}
    </v-alert>

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
        <v-tooltip
          :text="`Showing ${sortOrder === 'desc' ? 'latest' : 'earliest'} first — click to reverse`"
          location="top"
        >
          <template #activator="{ props: tip }">
            <v-btn
              v-bind="tip"
              size="large"
              variant="tonal"
              :prepend-icon="sortOrder === 'desc'
                ? 'mdi-sort-calendar-descending'
                : 'mdi-sort-calendar-ascending'"
              @click="toggleSort"
            >
              {{ sortOrder === 'desc' ? 'Latest first' : 'Earliest first' }}
            </v-btn>
          </template>
        </v-tooltip>
      </div>
      <div class="mt-3 d-flex align-center flex-wrap ga-2">
        <span class="text-body-small text-medium-emphasis mr-1">Quick range:</span>
        <v-btn size="small" variant="text" @click="preset('today')">Today</v-btn>
        <v-btn size="small" variant="text" @click="preset('week')">This week</v-btn>
        <v-btn size="small" variant="text" @click="preset('lastWeek')">Last week</v-btn>
        <v-btn size="small" variant="text" @click="preset('month')">This month</v-btn>
        <v-btn size="small" variant="text" @click="preset('lastMonth')">Last month</v-btn>
        <v-btn size="small" variant="text" @click="preset('twoMonths')">Last 2 months</v-btn>
      </div>
    </v-card>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card v-if="report && !history" class="mb-5 pa-4" variant="tonal">
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

    <v-card v-else-if="historyLoading" variant="tonal" class="pa-6 text-center">
      <v-progress-circular indeterminate color="primary" size="34" class="mb-3" />
      <div class="text-body-large">Searching the last 12 months…</div>
      <div class="text-body-small text-medium-emphasis">
        Jira cannot search worklog text, so every ticket you logged time to is read in turn.
      </div>
    </v-card>

    <template v-else-if="history">
      <v-alert v-if="history.unknownTicket" type="warning" variant="tonal" class="mb-4">
        <strong>{{ history.unknownTicket }}</strong> does not exist in Jira.
      </v-alert>

      <div class="d-flex align-center flex-wrap ga-2 mb-3">
        <v-icon icon="mdi-history" size="20" />
        <span class="text-title-small">
          {{ history.matched }} match{{ history.matched === 1 ? '' : 'es' }} for
          “{{ history.query }}”
        </span>
        <v-chip size="small" variant="tonal">{{ history.from }} → {{ history.to }}</v-chip>
        <v-chip size="small" variant="text">
          {{ history.scannedIssues }} ticket{{ history.scannedIssues === 1 ? '' : 's' }} scanned<template
            v-if="historyMs"
          > · {{ historyMs >= 1000 ? `${(historyMs / 1000).toFixed(1)}s` : `${historyMs}ms` }}</template>
        </v-chip>
        <v-spacer />
        <v-btn size="small" variant="text" prepend-icon="mdi-arrow-left" @click="history = null">
          Back to range
        </v-btn>
      </div>

      <v-alert v-if="history.truncated" type="info" variant="tonal" density="compact" class="mb-3">
        Showing the first 200 matches; add a word to narrow the search.
      </v-alert>

      <v-card v-if="!history.days.length" variant="tonal" class="pa-6 text-center text-medium-emphasis">
        No match in the last 12 months.
      </v-card>

      <div v-for="day in history.days" :key="day.date" class="mb-4">
        <div class="hit-day d-flex align-center ga-2">
          <span class="text-body-medium font-weight-medium">{{ day.label }}</span>
          <v-chip v-if="day.weekend" size="x-small" variant="tonal">weekend</v-chip>
        </div>
        <v-card variant="outlined">
          <div
            v-for="m in day.matches"
            :key="m.id"
            class="hit-row px-4 py-2"
            @click="openDay(day.date)"
          >
            <div class="hit-head">
              <a
                :href="m.url"
                target="_blank"
                rel="noopener"
                class="text-primary font-weight-medium"
                @click.stop
              >
                {{ m.ticket }}
              </a>
              <span class="text-body-small text-medium-emphasis hit-summary">{{ m.summary }}</span>
              <span class="text-body-small text-medium-emphasis hit-time">{{ m.started }} · {{ m.hours }}h</span>
            </div>
            <MarkdownText v-if="m.comment" :text="m.comment" class="hit-comment" />
            <div v-else class="hit-comment text-medium-emphasis font-italic">No comment</div>
          </div>
        </v-card>
      </div>
    </template>

    <template v-else-if="report">
      <TimeLoggerDayCard
        v-for="day in visibleDays"
        :key="day.date"
        :day="day"
        :hours-per-day="report.hoursPerDay"
        :perform="perform"
        :changed="changed"
        :search="query"
      />

      <v-card v-if="!visibleDays.length" variant="tonal" class="pa-8 text-center">
        <template v-if="query">
          <div class="text-body-large mb-1">No matches in this range</div>
          <div class="text-body-medium text-medium-emphasis mb-3">
            “{{ query }}” is not in any ticket, summary or comment shown here.
          </div>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-history"
            :loading="historyLoading"
            @click="searchHistory"
          >
            Search the last 12 months
          </v-btn>
        </template>
        <template v-else>
          <div class="text-body-large mb-1">Nothing logged in this range</div>
          <div class="text-body-medium text-medium-emphasis">
            Pick another range, or log time with the row at the foot of a day.
          </div>
        </template>
      </v-card>
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
.search-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.search-field {
  flex: 1 1 320px;
}
/* A history result row is a shortcut to its day; the ticket link inside stops
   the click so it keeps opening Jira. */
.hit-row + .hit-row {
  border-top: 1px solid rgb(var(--v-border-color), 0.12);
}
.hit-row {
  cursor: pointer;
}
.hit-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.hit-day {
  margin-bottom: 6px;
}
.hit-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.hit-summary {
  flex: 1 1 200px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-time {
  flex: 0 0 auto;
}
/* Comments can run long; keep the result list scannable. */
.hit-comment {
  margin-top: 4px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  word-break: break-word;
}
</style>
