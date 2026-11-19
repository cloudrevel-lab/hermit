<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import { absoluteTime, relativeTime } from '../composables/useFormat'
import EmptyHint from '../components/EmptyHint.vue'

const loading = ref(false)
const refreshing = ref(false)
const data = ref(null)
const filter = ref('')
// Set by clicking the "awaiting your review" banner; the chip beside the
// filter clears it again without losing a text search.
const awaitingOnly = ref(false)

const repos = computed(() => data.value?.repos || [])
const okRepos = computed(() => repos.value.filter(result => result.status === 'ok'))
const failedRepos = computed(() => repos.value.filter(result => result.status !== 'ok'))

const allPullRequests = computed(() =>
  okRepos.value.flatMap(result => result.pullRequests || [])
)
const openCount = computed(() => allPullRequests.value.length)
const draftCount = computed(() => allPullRequests.value.filter(pr => pr.draft).length)
const awaitingMine = computed(() =>
  allPullRequests.value.filter(pr =>
    (pr.reviewers || []).some(reviewer => reviewer.isCurrentUser && reviewer.state === 'awaiting')
  ).length
)
const reposWithPullRequests = computed(() =>
  okRepos.value.filter(result => result.pullRequests?.length).length
)
const emptyRepos = computed(() =>
  okRepos.value.filter(result => !result.pullRequests?.length)
)

// Review states are normalised by the server, so Azure's numeric votes and
// GitHub's pending requests render the same way here.
const REVIEW_STATES = {
  approved: { label: 'Approved', short: 'approved', color: 'success' },
  'approved-suggestions': { label: 'Approved with suggestions', short: 'approved', color: 'success' },
  awaiting: { label: 'Awaiting review', short: 'awaiting', color: 'warning' },
  'waiting-author': { label: 'Waiting for author', short: 'waiting on author', color: 'info' },
  rejected: { label: 'Rejected', short: 'rejected', color: 'error' }
}

function reviewMeta (reviewer) {
  return REVIEW_STATES[reviewer.state] || {
    label: reviewer.state || 'Reviewer',
    short: reviewer.state || 'reviewing',
    color: undefined
  }
}

function reviewLabel (reviewer) {
  return `${reviewer.isCurrentUser ? 'You' : reviewer.name} — ${reviewMeta(reviewer).label}`
}

// Every term has to appear somewhere, which makes "ace deploy" narrow to ace's
// deploy PRs instead of widening the result the way an OR would.
const terms = computed(() =>
  filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
)

function matches (pr, repo) {
  if (awaitingOnly.value &&
      !(pr.reviewers || []).some(reviewer => reviewer.isCurrentUser && reviewer.state === 'awaiting')) {
    return false
  }
  if (!terms.value.length) return true
  const haystack = [
    `pr ${pr.pullRequestId}`,
    String(pr.pullRequestId),
    pr.title,
    pr.createdBy,
    pr.sourceBranch,
    pr.targetBranch,
    repo.name,
    repo.namespace,
    repo.repo,
    repo.providerName,
    ...(pr.reviewers || []).map(reviewer => reviewer.name),
    ...(pr.reviewers || []).map(reviewer => reviewer.state),
    ...(pr.reviewers || []).filter(reviewer => reviewer.isCurrentUser).flatMap(() => ['you', 'me'])
  ].filter(Boolean).join(' ').toLowerCase()
  return terms.value.every(term => haystack.includes(term))
}

/** Repos are kept in configuration order; their PRs arrive newest first. */
const groups = computed(() => okRepos.value
  .map(result => ({
    ...result,
    pullRequests: (result.pullRequests || []).filter(pr => matches(pr, result.repo))
  }))
  .filter(result => result.pullRequests.length)
)

const filteredCount = computed(() =>
  groups.value.reduce((sum, group) => sum + group.pullRequests.length, 0)
)

function showAwaitingMine () {
  awaitingOnly.value = true
}

function clearFilters () {
  filter.value = ''
  awaitingOnly.value = false
}

async function load (refresh = false) {
  if (refresh) refreshing.value = true
  else loading.value = true
  try {
    data.value = await api.pullRequests(refresh)
    // Per-repo failures never fail the request, so report them here rather
    // than leaving the user to wonder why a repo is missing.
    for (const result of failedRepos.value) {
      notify(`${result.repo.name}: ${result.message}`, { color: 'error', hint: result.hint })
    }
  } catch (err) {
    notifyError(err)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

onMounted(() => load())
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6">
    <div class="d-flex align-center mb-4 ga-3 flex-wrap">
      <div class="text-body-medium text-medium-emphasis">
        Open pull requests from every registered repository. A repository disabled
        for release comparisons is still included here.
      </div>
      <v-spacer />
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="refreshing" @click="load(true)">
        Refresh
        <v-tooltip activator="parent" location="top" text="Bypass the two-minute cache" />
      </v-btn>
    </div>

    <v-progress-linear v-if="refreshing" indeterminate class="mb-3" />

    <EmptyHint
      v-if="!loading && data && !repos.length"
      icon="mdi-source-repository-multiple"
      title="No repositories configured"
      text="Add a repository to see its open pull requests."
      action-text="Add a repository"
      action-to="/repositories"
    />

    <v-alert v-else-if="!loading && !data" type="error" density="compact" class="mb-4">
      <div class="d-flex align-center ga-3 flex-wrap">
        <span>Could not load pull requests.</span>
        <v-btn size="small" variant="tonal" @click="load()">Retry</v-btn>
      </div>
    </v-alert>

    <v-skeleton-loader v-else-if="loading && !data" type="article, list-item-three-line@4" class="rounded-lg" />

    <template v-else-if="data">
      <v-row dense class="mb-1">
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Open pull requests</div>
            <div class="text-headline-large font-weight-bold numeric mt-1">{{ openCount }}</div>
          </v-card-text></v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Drafts</div>
            <div class="text-headline-large font-weight-bold numeric mt-1">{{ draftCount }}</div>
          </v-card-text></v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Repos with PRs</div>
            <div class="text-headline-large font-weight-bold numeric mt-1">
              {{ reposWithPullRequests }}
              <span class="text-title-large text-medium-emphasis">/ {{ okRepos.length }}</span>
            </div>
          </v-card-text></v-card>
        </v-col>
        <v-col cols="6" md="3">
          <v-card><v-card-text>
            <div class="section-label">Load errors</div>
            <div class="text-headline-large font-weight-bold numeric mt-1"
                 :class="failedRepos.length ? 'text-error' : ''">
              {{ failedRepos.length }}
            </div>
          </v-card-text></v-card>
        </v-col>
      </v-row>

      <v-alert
        v-if="awaitingMine && !awaitingOnly"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-3"
        prepend-icon="mdi-account-clock-outline"
        role="button"
        tabindex="0"
        style="cursor: pointer"
        @click="showAwaitingMine"
        @keydown.enter="showAwaitingMine"
        @keydown.space.prevent="showAwaitingMine"
      >
        <div class="d-flex align-center ga-3 flex-wrap">
          <span>{{ awaitingMine }} open pull request{{ awaitingMine === 1 ? '' : 's' }} awaiting your review.</span>
          <v-spacer />
          <span class="text-body-small font-weight-medium">
            Show these <v-icon icon="mdi-arrow-right" size="14" />
          </span>
        </div>
      </v-alert>

      <div class="d-flex align-center ga-2 mb-3 flex-wrap">
        <v-text-field
          v-model="filter"
          class="flex-grow-1"
          placeholder="Filter by title, number, reviewer, author, branch or repository"
          prepend-inner-icon="mdi-magnify"
          clearable
        />
        <v-chip
          v-if="awaitingOnly"
          closable
          color="warning"
          variant="tonal"
          prepend-icon="mdi-account-clock-outline"
          @click:close="awaitingOnly = false"
        >
          Awaiting my review ({{ awaitingMine }})
        </v-chip>
      </div>

      <EmptyHint
        v-if="okRepos.length && !openCount"
        icon="mdi-source-pull"
        title="No open pull requests"
        :text="`Checked ${okRepos.length} ${okRepos.length === 1 ? 'repository' : 'repositories'}. Nothing is open right now.`"
      />

      <div v-else-if="!filteredCount && (filter || awaitingOnly)" class="text-center py-8">
        <div class="text-body-medium text-medium-emphasis">
          No pull requests match<template v-if="filter"> &ldquo;{{ filter }}&rdquo;</template><template v-if="awaitingOnly"> while awaiting your review</template>.
        </div>
        <v-btn size="small" variant="text" class="mt-2" @click="clearFilters">Clear filters</v-btn>
      </div>

      <v-card v-for="group in groups" :key="group.repoId" class="mb-3">
        <v-card-title class="text-title-small d-flex align-center ga-2 flex-wrap">
          <v-icon :icon="group.repo.providerIcon" size="18" />
          <span>{{ group.repo.name }}</span>
          <v-chip size="x-small" variant="tonal">{{ group.repo.providerName }}</v-chip>
          <v-chip size="x-small" variant="tonal" color="primary">
            {{ group.pullRequests.length }} open
          </v-chip>
          <v-chip v-if="!group.repo.enabled" size="x-small" variant="text" class="text-medium-emphasis">
            not in release compare
          </v-chip>
          <v-chip v-if="group.cached" size="x-small" variant="text" prepend-icon="mdi-database-outline"
                  class="text-medium-emphasis">
            cached {{ relativeTime(group.fetchedAt) }}
          </v-chip>
          <v-spacer />
          <a :href="group.repo.url" target="_blank" rel="noopener"
             class="text-body-small text-decoration-none text-medium-emphasis">
            open repository <v-icon icon="mdi-open-in-new" size="12" />
          </a>
        </v-card-title>
        <v-divider />

        <v-table density="comfortable">
          <thead>
            <tr>
              <th class="text-left" style="width: 110px">PR</th>
              <th class="text-left" style="min-width: 260px">Title</th>
              <th class="text-left" style="width: 210px">Reviewers</th>
              <th class="text-left" style="min-width: 280px">Branches</th>
              <th class="text-left">Author</th>
              <th class="text-left" style="width: 150px">Opened</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pr in group.pullRequests" :key="pr.pullRequestId" class="hover-row">
              <td class="text-no-wrap">
                <a :href="pr.url" target="_blank" rel="noopener"
                   class="mono text-decoration-none">#{{ pr.pullRequestId }}</a>
                <v-chip v-if="pr.draft" size="x-small" color="warning" variant="tonal" class="ml-2">
                  Draft
                </v-chip>
              </td>
              <td class="wrap-anywhere">
                <a :href="pr.url" target="_blank" rel="noopener"
                   class="text-decoration-none font-weight-medium">
                  {{ pr.title || '(no title)' }}
                </a>
              </td>
              <td>
                <div v-if="pr.reviewers?.length" class="d-flex flex-wrap ga-1">
                  <v-tooltip v-for="reviewer in pr.reviewers" :key="reviewer.id || reviewer.name"
                             location="top" :text="reviewLabel(reviewer)">
                    <template #activator="{ props }">
                      <v-chip v-bind="props" size="x-small" variant="tonal"
                              :color="reviewMeta(reviewer).color"
                              :prepend-icon="reviewer.isCurrentUser ? 'mdi-account-star' : undefined">
                        {{ reviewer.isCurrentUser ? `You · ${reviewMeta(reviewer).short}` : reviewer.name }}
                      </v-chip>
                    </template>
                  </v-tooltip>
                </div>
                <span v-else class="text-body-small text-medium-emphasis">—</span>
              </td>
              <td>
                <div class="d-flex align-center ga-1 flex-wrap">
                  <v-chip size="x-small" variant="tonal" class="branch-chip">
                    {{ pr.sourceBranch || 'unknown' }}
                  </v-chip>
                  <v-icon icon="mdi-arrow-right" size="14" class="text-medium-emphasis" />
                  <v-chip size="x-small" variant="tonal" color="info" class="branch-chip">
                    {{ pr.targetBranch || 'unknown' }}
                  </v-chip>
                </div>
              </td>
              <td class="text-body-medium">{{ pr.createdBy || '—' }}</td>
              <td>
                <v-tooltip v-if="pr.createdAt" location="top" :text="absoluteTime(pr.createdAt)">
                  <template #activator="{ props }">
                    <span v-bind="props" class="text-body-medium">{{ relativeTime(pr.createdAt) }}</span>
                  </template>
                </v-tooltip>
                <span v-else class="text-medium-emphasis">—</span>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <v-card v-if="openCount && emptyRepos.length" class="mb-3">
        <v-card-title class="text-title-small">Repositories with no open pull requests</v-card-title>
        <v-divider />
        <v-card-text class="d-flex ga-2 flex-wrap">
          <v-chip v-for="result in emptyRepos" :key="result.repoId" size="small" variant="tonal"
                  :prepend-icon="result.repo.providerIcon">
            {{ result.repo.name }}
          </v-chip>
        </v-card-text>
      </v-card>

      <v-card v-if="failedRepos.length">
        <v-card-title class="text-title-small d-flex align-center ga-2">
          <v-icon icon="mdi-alert-circle-outline" size="18" color="error" />
          Repositories that could not be loaded
        </v-card-title>
        <v-divider />
        <v-list>
          <v-list-item v-for="result in failedRepos" :key="result.repoId">
            <template #prepend>
              <v-icon icon="mdi-alert-circle-outline" color="error" />
            </template>
            <v-list-item-title>{{ result.repo.name }}</v-list-item-title>
            <v-list-item-subtitle style="white-space: pre-line">
              {{ result.message }}<template v-if="result.hint">&#10;{{ result.hint }}</template>
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-card>
    </template>
  </v-container>
</template>
