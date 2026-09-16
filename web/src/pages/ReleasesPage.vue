<script setup>
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import { readStored, writeStored } from '../composables/useStored'
import { readCachedResult, writeCachedResult } from '../composables/useResultCache'
import { relativeTime, shortDate } from '../composables/useFormat'
import CommitRow from '../components/CommitRow.vue'
import EmptyHint from '../components/EmptyHint.vue'

const loading = ref(false)
const comparing = ref(false)
const overview = ref(null)
const comparison = ref(null)
const selectedRepoIds = ref([])
const target = ref(null)
const base = ref(null)
const filter = ref('')
const jira = ref({ loading: false, version: null, issues: [], byKey: {}, host: '' })
// Fix Versions pinned on the Jira releases page, offered here so a cross-check
// does not depend on pasting a version-report URL.
const pinnedReleases = ref([])
const pinnedReleaseId = ref(null)
const pinnedLoading = ref(false)
const settings = ref({})
// Set only when the comparison on screen came from a stored snapshot rather
// than a live fetch, so the page can say so and offer a recompute.
const restoredAt = ref(null)

const releases = computed(() => overview.value?.releases || [])
const repos = computed(() => overview.value?.repos || [])
const prefix = computed(() => overview.value?.prefix || 'release/')

/**
 * Identifies the exact comparison — the same branches over the same repos — so
 * a stored snapshot is only ever served back for matching inputs.
 */
const compareKey = computed(() => {
  if (!base.value || !target.value || !selectedRepoIds.value.length) return null
  const repos = [...selectedRepoIds.value].sort().join(',')
  return `releases:${prefix.value}${base.value}..${prefix.value}${target.value}|${repos}`
})

const releaseOptions = computed(() => releases.value.map(r => ({
  title: r.version,
  value: r.version,
  subtitle: `${r.repos.length} of ${repos.value.length} repos`,
  missing: r.missing.length
})))

// Pinned Fix Versions are stored by name, so the id is what identifies the pick
// and the label is what carries the meaning.
const pinnedReleaseOptions = computed(() => pinnedReleases.value.map(r => ({
  title: r.name,
  value: r.id,
  // Vuetify spreads an item's `props` onto the rendered list item; a top-level
  // subtitle is ignored, so the project key has to travel this way.
  props: r.projectKey ? { subtitle: r.projectKey } : {}
})))

/** Semver releases only, so "the previous release" skips date/ticket branches. */
const semverVersions = computed(() => releases.value.filter(r => r.isSemver).map(r => r.version))

watch(target, (next) => {
  if (!next) return
  const index = semverVersions.value.indexOf(next)
  const suggestion = index !== -1 ? semverVersions.value[index + 1] : null
  if (suggestion && (!base.value || base.value === next)) base.value = suggestion
})

const SELECTION_KEY = 'releases.selection'

/**
 * Restores the last comparison, falling back to the newest release and the one
 * below it. A remembered branch that no longer exists is ignored rather than
 * left selected — release branches do get deleted.
 */
function restoreSelection (releases) {
  const available = new Set(releases.map(r => r.version))
  const stored = readStored(SELECTION_KEY)

  // Target first: the watcher below fills in a base only when none is set, so
  // restoring the stored base afterwards wins.
  if (stored?.target && available.has(stored.target)) target.value = stored.target
  else if (!target.value) target.value = releases.find(r => r.isSemver)?.version || releases[0]?.version || null

  if (stored?.base && available.has(stored.base) && stored.base !== target.value) base.value = stored.base
}

/**
 * Refreshes the pinned Fix Version list. Best-effort: the URL field still works
 * if this fails, so a listing error is not worth interrupting the user for.
 */
async function loadPinnedReleases () {
  pinnedLoading.value = true
  try {
    const { releases: pinned } = await api.jiraReleases()
    pinnedReleases.value = pinned || []
    // A since-unpinned release must not stay selected.
    if (pinnedReleaseId.value && !pinnedReleases.value.some(r => r.id === pinnedReleaseId.value)) {
      pinnedReleaseId.value = null
    }
  } catch {
    // Ignored on purpose — see above.
  } finally {
    pinnedLoading.value = false
  }
}

watch([base, target], ([nextBase, nextTarget]) => {
  if (nextBase && nextTarget) writeStored(SELECTION_KEY, { base: nextBase, target: nextTarget })
})

async function load (refresh = false) {
  loading.value = true
  try {
    const [data, cfg] = await Promise.all([api.releases(refresh), api.settings()])
    overview.value = data
    settings.value = cfg.settings
    selectedRepoIds.value = data.repos.filter(r => !r.error).map(r => r.id)
    restoreSelection(data.releases)
    // Let the base/target watchers settle before looking up a snapshot, so the
    // key is the pair the user actually compared.
    await nextTick()
    restoreCachedComparison()
    for (const err of data.errors) notify(`${err.repo}: ${err.message}`, { color: 'error', hint: err.hint })
  } catch (err) {
    notifyError(err)
  } finally {
    loading.value = false
  }
  loadPinnedReleases()
}

/**
 * Puts back the last comparison for the restored selection, if a snapshot for
 * exactly that selection exists. Only the first load does this — a kept-alive
 * page still has its result in memory.
 */
function restoreCachedComparison () {
  if (comparison.value) return
  const cached = readCachedResult(compareKey.value)
  if (!cached) return
  comparison.value = cached.data.comparison
  jiraVersionUrl.value = cached.data.jiraVersionUrl || ''
  pinnedReleaseId.value = cached.data.pinnedReleaseId || null
  jira.value = { ...cached.data.jira, loading: false }
  restoredAt.value = cached.fetchedAt
}

/**
 * A kept-alive page does not remount, so pull the release metadata again when
 * the user returns — a repository added elsewhere should show up here. The
 * comparison on screen is left alone.
 */
async function refreshOverview () {
  try {
    const [data, cfg] = await Promise.all([api.releases(), api.settings()])
    overview.value = data
    settings.value = cfg.settings
    const selectable = new Set(data.repos.filter(r => !r.error).map(r => r.id))
    const next = selectedRepoIds.value.filter(id => selectable.has(id))
    for (const id of selectable) if (!next.includes(id)) next.push(id)
    selectedRepoIds.value = next
  } catch {
    // The data already on screen is still usable; the user can hit Refresh.
  }
  loadPinnedReleases()
}

async function runCompare (refresh = false) {
  if (!base.value || !target.value) return
  const key = compareKey.value
  comparing.value = true
  comparison.value = null
  restoredAt.value = null
  try {
    comparison.value = await api.compare({
      base: prefix.value + base.value,
      target: prefix.value + target.value,
      repoIds: selectedRepoIds.value,
      refresh
    })
    await loadJira(key)
    cacheComparison(key)
  } catch (err) {
    notifyError(err)
  } finally {
    comparing.value = false
  }
}

/**
 * Persists the comparison together with whatever cross-check is on screen, so
 * leaving the page and coming back (or reloading) does not ask for the same
 * Jira lookup again. Writes under `key` when given, because a compare captures
 * its key before awaiting and the selection can move while it is in flight.
 */
function cacheComparison (key = compareKey.value) {
  if (!comparison.value) return
  writeCachedResult(key, {
    comparison: comparison.value,
    jiraVersionUrl: jiraVersionUrl.value,
    pinnedReleaseId: pinnedReleaseId.value,
    jira: jira.value
  })
}

/**
 * Enriches commit issue keys and cross-checks them against the Jira release.
 * The release comes from the pinned picker or a pasted release-report URL; a
 * pinned release is looked up by id through its own endpoint, so no URL is
 * needed and the version metadata comes back with the issues.
 */
async function loadJira (key = compareKey.value) {
  const keys = [...commitKeys.value]
  const pinned = Boolean(pinnedReleaseId.value)
  if (!keys.length && !pinned) return
  if (!settings.value.jiraBaseUrl && !pinned) return
  jira.value.loading = true
  try {
    const [issuesRes, versionRes] = await Promise.all([
      // Issue-key enrichment needs a configured site; the version side can
      // still resolve from the pinned release's own host without one.
      keys.length && settings.value.jiraBaseUrl
        ? api.jiraIssues({ keys })
        : Promise.resolve({ host: '', issues: [] }),
      findVersion()
    ])
    jira.value.host = versionRes?.host || issuesRes.host
    jira.value.byKey = Object.fromEntries((issuesRes.issues || []).map(i => [i.key, i]))
    jira.value.version = versionRes?.version || null
    jira.value.issues = versionRes?.issues || []
  } catch (err) {
    notify(`Jira lookup skipped: ${err.message}`, { color: 'warning', hint: err.hint })
  } finally {
    jira.value.loading = false
  }
  // A standalone cross-check (pinned pick or the button) has to persist too —
  // not just the one that ran as part of Compare.
  cacheComparison(key)
}

const jiraVersionUrl = ref('')

/** Resolves the release to compare against, from the pinned pick or the URL. */
async function findVersion () {
  if (pinnedReleaseId.value) {
    const pinned = await api.jiraReleaseIssues(pinnedReleaseId.value)
    return {
      host: pinned.host,
      // A pinned name with no matching project version has no metadata.
      version: pinned.meta || { name: pinned.release?.name || '', releaseDate: null },
      issues: pinned.issues || []
    }
  }
  if (!jiraVersionUrl.value) return null
  return api.jiraVersion({ url: jiraVersionUrl.value })
}

/** Picking a pinned release is itself the cross-check when one is on screen. */
function onJiraReleasePicked () {
  // The picked id has to reach the ref before findVersion reads it.
  nextTick(() => {
    if (comparison.value && !comparing.value) loadJira()
  })
}

const allCommits = computed(() =>
  (comparison.value?.results || []).flatMap(r => r.commits || [])
)

const totalCommits = computed(() => allCommits.value.length)

// Keys come from the server, which reads them out of the commit message, the
// source branch name and the PR title — branches are where most of them live.
const commitKeys = computed(() => {
  const keys = new Set()
  for (const commit of allCommits.value) for (const key of commit.issueKeys || []) keys.add(key)
  return keys
})

/** The two directions of drift between the commit log and the Jira release. */
const jiraOnly = computed(() =>
  jira.value.issues.filter(issue => !commitKeys.value.has(issue.key))
)

const commitsOnly = computed(() => {
  const inRelease = new Set(jira.value.issues.map(i => i.key))
  return [...commitKeys.value].filter(key => !inRelease.has(key)).sort()
})

function matches (commit) {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return true
  const haystack = [
    commit.message,
    commit.author,
    commit.shortId,
    commit.sourceBranch,
    ...(commit.issueKeys || []),
    ...(commit.pullRequests || []).map(pr => `PR ${pr.pullRequestId} ${pr.title}`)
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(needle)
}

function visibleCommits (result) {
  return (result.commits || []).filter(matches)
}

/** One repo's section of the notes, in the same shape the full copy uses. */
function repoMarkdown (result) {
  const lines = [`## ${result.repo.name} (${result.commits.length})`]
  for (const c of result.commits) {
    const from = c.sourceBranch ? ` _(from \`${c.sourceBranch}\`)_` : ''
    lines.push(`- \`${c.shortId}\` ${c.message.split('\n')[0]} — ${c.author}${from}`)
  }
  return lines.join('\n')
}

function copyNotes (text, message) {
  navigator.clipboard.writeText(text)
    .then(() => notify(message))
    .catch(() => notify('Could not access the clipboard', { color: 'error' }))
}

function copyMarkdown () {
  const lines = [`# ${base.value} → ${target.value}`, '']
  for (const result of comparison.value?.results || []) {
    if (result.status !== 'ok' || !result.commits.length) continue
    lines.push(repoMarkdown(result))
    lines.push('')
  }
  copyNotes(lines.join('\n'), 'Release notes copied as Markdown')
}

function copyRepoMarkdown (result) {
  copyNotes(
    `# ${base.value} → ${target.value}\n\n${repoMarkdown(result)}`,
    `Notes for ${result.repo.name} copied as Markdown`
  )
}

const okResults = computed(() => (comparison.value?.results || []).filter(r => r.status === 'ok'))
const otherResults = computed(() => (comparison.value?.results || []).filter(r => r.status !== 'ok'))

onMounted(() => load())

onActivated(() => {
  // The first activation runs alongside onMounted, before the overview exists.
  if (overview.value) refreshOverview()
})
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6">
    <!-- Comparison controls -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <div class="d-flex align-center ga-2 mb-3">
          <span class="section-label">Compare releases</span>
          <v-spacer />
          <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load(true)">
            Refresh branches
          </v-btn>
        </div>

        <v-row dense align="center">
          <v-col cols="12" md="3">
            <v-select
              v-model="base"
              :items="releaseOptions"
              label="Base release (from)"
              prepend-inner-icon="mdi-source-branch"
              :loading="loading"
            />
          </v-col>

          <v-col cols="12" md="1" class="text-center d-none d-md-block">
            <v-icon icon="mdi-arrow-right" class="text-medium-emphasis" />
          </v-col>

          <v-col cols="12" md="3">
            <v-select
              v-model="target"
              :items="releaseOptions"
              label="Target release (to)"
              prepend-inner-icon="mdi-source-branch-check"
              :loading="loading"
            />
          </v-col>

          <v-col cols="12" md="3">
            <v-select
              v-model="selectedRepoIds"
              :items="repos.map(r => ({ title: r.name, value: r.id, props: { disabled: Boolean(r.error) } }))"
              label="Repositories"
              multiple
              chips
              closable-chips
            >
              <template #prepend-item>
                <v-list-item title="All repositories" @click="selectedRepoIds = repos.filter(r => !r.error).map(r => r.id)" />
                <v-divider />
              </template>
            </v-select>
          </v-col>

          <v-col cols="12" md="2">
            <v-btn
              block
              color="primary"
              prepend-icon="mdi-compare-horizontal"
              :loading="comparing"
              :disabled="!base || !target || base === target || !selectedRepoIds.length"
              @click="runCompare(false)"
            >
              Compare
            </v-btn>
          </v-col>
        </v-row>

        <div v-if="base && target" class="d-flex align-center ga-2 mt-3 flex-wrap">
          <v-chip size="small" variant="tonal" class="branch-chip">{{ prefix }}{{ base }}</v-chip>
          <v-icon icon="mdi-arrow-right" size="16" class="text-medium-emphasis" />
          <v-chip size="small" variant="tonal" color="primary" class="branch-chip">{{ prefix }}{{ target }}</v-chip>
          <span class="text-body-small text-medium-emphasis ml-2">
            shows what {{ target }} adds on top of {{ base }}
          </span>
        </div>
      </v-card-text>
    </v-card>

    <EmptyHint
      v-if="!loading && !repos.length"
      icon="mdi-source-repository-multiple"
      title="No repositories yet"
      text="Add git repos to start comparing their release branches."
      action-text="Add a repository"
      action-to="/repositories"
    />

    <!-- Release coverage across repos -->
    <v-card v-else-if="!comparison && !comparing" class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-view-grid-outline" size="18" /> Release branch coverage
      </v-card-title>
      <v-divider />
      <div class="scroll-pane" style="max-height: 460px">
        <v-table density="compact">
          <thead>
            <tr>
              <th class="text-left">Release</th>
              <th v-for="repo in repos" :key="repo.id" class="text-left">{{ repo.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="release in releases" :key="release.version" class="hover-row">
              <td>
                <span class="mono font-weight-medium">{{ release.version }}</span>
                <v-chip v-if="!release.isSemver" size="x-small" variant="tonal" class="ml-2">ad-hoc</v-chip>
              </td>
              <td v-for="repo in repos" :key="repo.id">
                <v-icon
                  :icon="release.repos.includes(repo.id) ? 'mdi-check-circle' : 'mdi-minus'"
                  :color="release.repos.includes(repo.id) ? 'success' : undefined"
                  size="16"
                  :class="release.repos.includes(repo.id) ? '' : 'text-disabled'"
                />
              </td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </v-card>

    <v-skeleton-loader v-if="comparing" type="article, list-item-three-line@3" class="rounded-lg" />

    <template v-if="comparison && !comparing">
      <v-alert v-if="restoredAt" type="info" density="compact" variant="tonal" class="mb-3">
        <div class="d-flex align-center ga-3 flex-wrap">
          <span>Showing the last comparison from cache ({{ relativeTime(restoredAt) }}).</span>
          <v-btn size="x-small" variant="tonal" prepend-icon="mdi-refresh"
                 :loading="comparing" @click="runCompare(true)">Recompute</v-btn>
        </div>
      </v-alert>

      <!-- Summary -->
      <v-row dense class="mb-1">
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Commits</div>
            <div class="text-headline-large font-weight-bold numeric mt-1">{{ totalCommits }}</div>
          </v-card-text></v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Repos with changes</div>
            <div class="text-headline-large font-weight-bold numeric mt-1">
              {{ okResults.filter(r => r.commits.length).length }}
              <span class="text-title-large text-medium-emphasis">/ {{ okResults.length }}</span>
            </div>
          </v-card-text></v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Issue keys</div>
            <div class="text-headline-large font-weight-bold numeric mt-1">{{ commitKeys.size }}</div>
          </v-card-text></v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Actions</div>
            <div class="d-flex ga-1 mt-2">
              <v-btn size="small" variant="tonal" prepend-icon="mdi-content-copy" @click="copyMarkdown">Copy notes</v-btn>
              <v-btn size="small" variant="text" icon="mdi-refresh" :loading="comparing" @click="runCompare(true)">
                <v-icon icon="mdi-refresh" /><v-tooltip activator="parent" text="Bypass the cache" />
              </v-btn>
            </div>
          </v-card-text></v-card>
        </v-col>
      </v-row>

      <!-- Jira cross-check -->
      <v-card class="mb-4">
        <v-card-title class="text-title-small d-flex align-center ga-2">
          <v-icon icon="mdi-jira" size="18" /> Jira cross-check
          <v-spacer />
          <v-chip v-if="jira.version" size="small" variant="tonal" color="info">
            {{ jira.version.name }}
            <template v-if="jira.version.releaseDate"> · due {{ shortDate(jira.version.releaseDate) }}</template>
          </v-chip>
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-row dense align="center" class="mb-2">
            <v-col cols="12" md="5">
              <div class="d-flex align-start ga-1">
                <v-select
                  v-model="pinnedReleaseId"
                  :items="pinnedReleaseOptions"
                  label="Pinned Jira release"
                  prepend-inner-icon="mdi-bookmark-outline"
                  :loading="pinnedLoading"
                  no-data-text="No pinned releases — pin one on the Jira releases page"
                  clearable
                  class="flex-grow-1"
                  @update:model-value="onJiraReleasePicked"
                />
                <v-btn icon variant="text" size="small" class="mt-1">
                  <v-icon icon="mdi-information-outline" size="18" class="text-medium-emphasis" />
                  <v-tooltip activator="parent" location="top" max-width="380">
                    Pin a Fix Version on the Jira releases page, then choose it here — no release URL to copy or paste.
                  </v-tooltip>
                </v-btn>
              </div>
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="jiraVersionUrl"
                label="Jira release URL (optional)"
                placeholder="https://your-site.atlassian.net/projects/PROJ/versions/1234/..."
                prepend-inner-icon="mdi-link-variant"
              />
            </v-col>
            <v-col cols="12" md="3">
              <v-btn block variant="tonal" :loading="jira.loading" prepend-icon="mdi-sync" @click="loadJira()">
                Cross-check
              </v-btn>
            </v-col>
          </v-row>

          <v-alert v-if="!settings.jiraBaseUrl" type="info" density="compact" class="mt-2">
            Set a Jira base URL in Settings to resolve issue keys found in commit messages.
          </v-alert>

          <v-row v-if="jira.version" dense class="mt-1">
            <v-col cols="12" md="6">
              <div class="section-label mb-2">In Jira release, no commit found ({{ jiraOnly.length }})</div>
              <div v-if="!jiraOnly.length" class="text-body-medium text-medium-emphasis">Every issue has a matching commit.</div>
              <div v-else class="d-flex ga-1 flex-wrap">
                <v-chip v-for="issue in jiraOnly" :key="issue.key" size="small" variant="tonal" color="warning"
                        :href="issue.url" target="_blank" rel="noopener" class="mono">
                  {{ issue.key }}
                  <v-tooltip activator="parent" location="top" max-width="380">
                    <div class="font-weight-medium">{{ issue.summary }}</div>
                    <div class="text-body-small">{{ issue.status }}</div>
                  </v-tooltip>
                </v-chip>
              </div>
            </v-col>
            <v-col cols="12" md="6">
              <div class="section-label mb-2">In commits, not in the Jira release ({{ commitsOnly.length }})</div>
              <div v-if="!commitsOnly.length" class="text-body-medium text-medium-emphasis">No unexpected issue keys.</div>
              <div v-else class="d-flex ga-1 flex-wrap">
                <v-chip v-for="key in commitsOnly" :key="key" size="small" variant="tonal" color="error"
                        :href="jira.byKey[key]?.url" target="_blank" rel="noopener" class="mono">
                  {{ key }}
                  <!-- A key parsed out of a commit may not exist in Jira; only
                       show the detail when the lookup actually found an issue. -->
                  <v-tooltip v-if="jira.byKey[key]" activator="parent" location="top" max-width="380">
                    <div class="font-weight-medium">{{ jira.byKey[key].summary }}</div>
                    <div class="text-body-small">{{ jira.byKey[key].status }}</div>
                  </v-tooltip>
                </v-chip>
              </div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <v-text-field
        v-model="filter"
        class="mb-3"
        placeholder="Filter commits by message, author, SHA, branch or ticket"
        prepend-inner-icon="mdi-magnify"
        clearable
      />

      <!-- Per-repo commit lists -->
      <v-card v-for="result in okResults" :key="result.repo.id" class="mb-3">
        <v-card-title class="text-title-small d-flex align-center ga-2 flex-wrap">
          <v-icon icon="mdi-source-repository" size="18" />
          <span>{{ result.repo.name }}</span>
          <v-chip size="x-small" variant="tonal" :color="result.commits.length ? 'primary' : undefined">
            {{ result.commits.length }} commits
          </v-chip>
          <v-btn class="btn-caption" size="x-small" variant="text" prepend-icon="mdi-content-copy"
                 :disabled="!result.commits.length"
                 @click="copyRepoMarkdown(result)">Copy notes</v-btn>
          <v-chip v-if="result.cached" size="x-small" variant="text" prepend-icon="mdi-database-outline"
                  class="text-medium-emphasis">
            cached {{ relativeTime(result.fetchedAt) }}
          </v-chip>
          <v-spacer />
          <a :href="result.targetUrl" target="_blank" rel="noopener" class="text-body-small text-decoration-none text-medium-emphasis">
            open in Azure DevOps <v-icon icon="mdi-open-in-new" size="12" />
          </a>
        </v-card-title>
        <v-divider />

        <div v-if="!result.commits.length" class="pa-4 text-body-medium text-medium-emphasis">
          Identical — {{ target }} has nothing that {{ base }} does not.
        </div>
        <div v-else class="scroll-pane" style="max-height: 640px">
          <template v-for="(commit, index) in visibleCommits(result)" :key="commit.commitId">
            <v-divider v-if="index" />
            <CommitRow :commit="commit" :issues="jira.byKey" :jira-host="jira.host" />
          </template>
          <div v-if="!visibleCommits(result).length" class="pa-4 text-body-medium text-medium-emphasis">
            No commits match "{{ filter }}".
          </div>
        </div>
      </v-card>

      <!-- Repos that could not be compared -->
      <v-card v-if="otherResults.length" class="mb-3">
        <v-card-title class="text-title-small">Not compared</v-card-title>
        <v-divider />
        <v-list>
          <v-list-item v-for="result in otherResults" :key="result.repo.id">
            <template #prepend>
              <v-icon :icon="result.status === 'error' ? 'mdi-alert-circle-outline' : 'mdi-minus-circle-outline'"
                      :color="result.status === 'error' ? 'error' : undefined" />
            </template>
            <v-list-item-title>{{ result.repo.name }}</v-list-item-title>
            <v-list-item-subtitle>{{ result.reason || result.message }}</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-card>
    </template>
  </v-container>
</template>
