<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import { readStored, writeStored } from '../composables/useStored'
import EmptyHint from '../components/EmptyHint.vue'

const loading = ref(false)
const overview = ref(null)
const version = ref(null)
const selectedRepoIds = ref([])
const loadError = ref(null)

const SELECTION_KEY = 'releaseRepositories.selection'

const releases = computed(() => overview.value?.releases || [])
const repos = computed(() => overview.value?.repos || [])
const prefix = computed(() => overview.value?.prefix || 'release/')

/** A repo whose branch list failed cannot answer "has the branch?" either way. */
const selectableRepos = computed(() => repos.value.filter(repo => !repo.error))
const failedRepos = computed(() => repos.value.filter(repo => repo.error))

const versionOptions = computed(() => releases.value.map(release => ({
  title: release.version,
  value: release.version,
  props: {
    subtitle: release.isSemver
      ? `${release.repos.length} of ${repos.value.length} repositories`
      : `${release.repos.length} of ${repos.value.length} repositories · ad-hoc branch`
  }
})))

const repoOptions = computed(() => repos.value.map(repo => ({
  title: repo.name,
  value: repo.id,
  props: {
    subtitle: repo.error
      ? `Branch list failed: ${repo.error.message}`
      : `${repo.providerName} · ${repo.namespace}/${repo.repo}`,
    disabled: Boolean(repo.error)
  }
})))

const selectedRelease = computed(() =>
  releases.value.find(release => release.version === version.value) || null
)

/** The repos the user narrowed the page to; the dropdown is the filter. */
const scopedRepos = computed(() =>
  repos.value.filter(repo => !repo.error && selectedRepoIds.value.includes(repo.id))
)

/**
 * The answer the page exists for: one row per selected repo that actually has
 * `release/<version>`. The server collates `tips` and `urls` by repo id.
 */
const repositoriesWithBranch = computed(() => {
  const release = selectedRelease.value
  if (!release) return []
  return scopedRepos.value
    .filter(repo => release.repos.includes(repo.id))
    .map(repo => ({
      ...repo,
      branch: release.branch,
      tip: release.tips?.[repo.id] || null,
      branchUrl: release.urls?.[repo.id] || repo.url
    }))
})

/** The complement, shown separately so "not releasing" is explicit. */
const repositoriesWithoutBranch = computed(() => {
  const release = selectedRelease.value
  if (!release) return []
  return scopedRepos.value.filter(repo => !release.repos.includes(repo.id))
})

function defaultVersion (data) {
  return data.releases.find(release => release.isSemver)?.version || data.releases[0]?.version || null
}

/**
 * Restores the last version and repo filter. A branch that has since been
 * deleted, or a repo that has since been removed, is dropped rather than left
 * selected — `releaseOverview()` only reports branches that exist right now.
 */
function restoreSelection (data) {
  const availableVersions = new Set(data.releases.map(release => release.version))
  const stored = readStored(SELECTION_KEY)

  version.value = stored?.version && availableVersions.has(stored.version)
    ? stored.version
    : defaultVersion(data)

  const selectable = new Set(data.repos.filter(repo => !repo.error).map(repo => repo.id))
  const storedIds = Array.isArray(stored?.repoIds)
    ? stored.repoIds.filter(id => selectable.has(id))
    : []
  // An empty saved filter is not a useful view, so it falls back to every repo.
  selectedRepoIds.value = storedIds.length ? storedIds : [...selectable]
}

function applyOverview (data, { initial = false } = {}) {
  // If the user was looking at every repo, keep it that way when a repo is
  // added between visits. A narrower filter is preserved as-is.
  const hadAll = !initial && selectableRepos.value.length > 0 &&
    selectableRepos.value.every(repo => selectedRepoIds.value.includes(repo.id))

  overview.value = data

  if (initial) {
    restoreSelection(data)
  } else {
    const availableVersions = new Set(data.releases.map(release => release.version))
    if (!availableVersions.has(version.value)) version.value = defaultVersion(data)
  }

  const selectable = [...data.repos.filter(repo => !repo.error).map(repo => repo.id)]
  selectedRepoIds.value = hadAll ? selectable : selectedRepoIds.value.filter(id => selectable.includes(id))
}

async function load (refresh = false) {
  loading.value = true
  loadError.value = null
  try {
    const data = await api.releases(refresh)
    applyOverview(data, { initial: !overview.value })
  } catch (err) {
    loadError.value = err
    notifyError(err)
  } finally {
    loading.value = false
  }
}

watch([version, selectedRepoIds], () => {
  writeStored(SELECTION_KEY, { version: version.value, repoIds: selectedRepoIds.value })
}, { deep: true })

function copyRepositories () {
  const names = repositoriesWithBranch.value.map(repo => repo.name)
  if (!names.length) return
  navigator.clipboard.writeText(names.join('\n'))
    .then(() => notify(`Copied ${names.length} repository name${names.length === 1 ? '' : 's'}`))
    .catch(() => notify('Could not access the clipboard', { color: 'error' }))
}

onMounted(() => load())
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6">
    <div class="text-body-medium text-medium-emphasis mb-3">
      Pick a release version to see which repositories already have its release branch — those are
      the repositories to release for that version.
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <div class="d-flex align-center ga-2 mb-3">
          <span class="section-label">Release branch coverage by repository</span>
          <v-spacer />
          <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load(true)">
            Refresh branches
          </v-btn>
        </div>

        <v-row dense align="center">
          <v-col cols="12" md="4">
            <v-select
              v-model="version"
              :items="versionOptions"
              label="Release version"
              prepend-inner-icon="mdi-tag-outline"
              :loading="loading"
              no-data-text="No release branches found"
            />
          </v-col>

          <v-col cols="12" md="8">
            <v-select
              v-model="selectedRepoIds"
              :items="repoOptions"
              label="Repositories"
              prepend-inner-icon="mdi-source-repository-multiple"
              multiple
              chips
              closable-chips
              :loading="loading"
              no-data-text="No repositories configured"
            >
              <template #prepend-item>
                <v-list-item title="All repositories" @click="selectedRepoIds = selectableRepos.map(repo => repo.id)" />
                <v-divider />
              </template>
            </v-select>
          </v-col>
        </v-row>

        <div v-if="selectedRelease" class="d-flex align-center ga-2 mt-3 flex-wrap">
          <span class="text-body-small text-medium-emphasis">Release branch</span>
          <v-chip size="small" variant="tonal" class="branch-chip">
            {{ selectedRelease.branch }}
          </v-chip>
          <span class="text-body-small text-medium-emphasis">
            · showing {{ scopedRepos.length }} of {{ selectableRepos.length }} enabled repositories
          </span>
        </div>
      </v-card-text>
    </v-card>

    <v-alert
      v-if="loadError && !repos.length"
      type="error"
      density="compact"
      variant="tonal"
      class="mb-3"
    >
      <div class="d-flex align-center ga-3 flex-wrap">
        <span>Could not load release branches: {{ loadError.message }}</span>
        <v-btn size="x-small" variant="tonal" prepend-icon="mdi-refresh" :loading="loading" @click="load()">
          Retry
        </v-btn>
      </div>
    </v-alert>

    <EmptyHint
      v-else-if="!loading && !repos.length"
      icon="mdi-source-repository-multiple"
      title="No repositories yet"
      text="Add git repos to see which ones carry a release branch."
      action-text="Add a repository"
      action-to="/repositories"
    />

    <template v-else>
      <!-- A failed repo is called out, but the repos that did load still answer
           the question for themselves. -->
      <v-alert
        v-for="repo in failedRepos"
        :key="repo.id"
        type="warning"
        density="compact"
        variant="tonal"
        class="mb-3"
      >
        <strong>{{ repo.name }}</strong> could not be read: {{ repo.error.message }}
        <div v-if="repo.error.hint" class="text-body-small mt-1" style="white-space: pre-line">
          {{ repo.error.hint }}
        </div>
      </v-alert>

      <v-alert v-if="!loading && !releases.length" type="info" density="compact" variant="tonal" class="mb-3">
        No branches start with <span class="mono">{{ prefix }}</span> in any enabled repository.
        Check the release branch prefix in Settings.
      </v-alert>

      <v-alert v-if="selectedRelease && !selectedRepoIds.length" type="info" density="compact" variant="tonal" class="mb-3">
        Choose at least one repository to see whether it carries this release branch.
      </v-alert>

      <template v-if="selectedRelease && selectedRepoIds.length">
        <v-row dense class="mb-1">
          <v-col cols="12" sm="6" md="3">
            <v-card>
              <v-card-text>
                <div class="section-label">Repositories to release</div>
                <div class="text-headline-large font-weight-bold numeric mt-1">
                  {{ repositoriesWithBranch.length }}
                  <span class="text-title-large text-medium-emphasis">/ {{ scopedRepos.length }}</span>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-card>
              <v-card-text>
                <div class="section-label">Without the branch</div>
                <div class="text-headline-large font-weight-bold numeric mt-1">
                  {{ repositoriesWithoutBranch.length }}
                </div>
              </v-card-text>
            </v-card>
          </v-col>
          <v-col cols="12" md="6">
            <v-card>
              <v-card-text>
                <div class="section-label">Actions</div>
                <div class="d-flex ga-2 mt-2 flex-wrap">
                  <v-btn
                    size="small"
                    variant="tonal"
                    prepend-icon="mdi-content-copy"
                    :disabled="!repositoriesWithBranch.length"
                    @click="copyRepositories"
                  >
                    Copy repository names
                  </v-btn>
                  <v-btn size="small" variant="text" prepend-icon="mdi-compare-horizontal" to="/releases">
                    Compare releases
                  </v-btn>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <v-card class="mb-4">
          <v-card-title class="text-title-small d-flex align-center ga-2 flex-wrap">
            <v-icon icon="mdi-source-repository" size="18" />
            <span>Repositories with {{ selectedRelease.branch }}</span>
            <v-chip size="x-small" variant="tonal" color="primary">
              {{ repositoriesWithBranch.length }}
            </v-chip>
          </v-card-title>
          <v-divider />

          <EmptyHint
            v-if="!repositoriesWithBranch.length"
            icon="mdi-source-branch-remove"
            title="None of the selected repositories has this branch"
            text="Widen the Repositories filter, or check the release branch prefix in Settings."
          />

          <v-table v-else density="comfortable">
            <thead>
              <tr>
                <th class="text-left">Repository</th>
                <th class="text-left">Provider</th>
                <th class="text-left">Release branch</th>
                <th class="text-left">Branch tip</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="repo in repositoriesWithBranch" :key="repo.id" class="hover-row">
                <td>
                  <div class="font-weight-medium">{{ repo.name }}</div>
                  <a
                    :href="repo.url"
                    target="_blank"
                    rel="noopener"
                    class="text-body-small text-decoration-none text-medium-emphasis"
                  >
                    {{ repo.namespace }}/{{ repo.repo }} <v-icon icon="mdi-open-in-new" size="11" />
                  </a>
                </td>
                <td>
                  <v-chip size="small" variant="tonal" :prepend-icon="repo.providerIcon">
                    {{ repo.providerName }}
                  </v-chip>
                </td>
                <td>
                  <a
                    :href="repo.branchUrl"
                    target="_blank"
                    rel="noopener"
                    class="branch-chip text-decoration-none"
                  >
                    {{ repo.branch }} <v-icon icon="mdi-open-in-new" size="12" />
                  </a>
                </td>
                <td>
                  <span v-if="repo.tip" class="sha" :title="repo.tip">{{ repo.tip.slice(0, 10) }}</span>
                  <span v-else class="text-medium-emphasis">—</span>
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card>

        <v-card v-if="repositoriesWithoutBranch.length">
          <v-card-title class="text-title-small d-flex align-center ga-2 flex-wrap">
            <v-icon icon="mdi-source-branch-remove" size="18" />
            <span>Without {{ selectedRelease.branch }}</span>
            <v-chip size="x-small" variant="tonal">
              {{ repositoriesWithoutBranch.length }}
            </v-chip>
          </v-card-title>
          <v-divider />
          <v-card-text class="text-body-medium text-medium-emphasis">
            These selected repositories have no release branch for this version, so there is
            nothing to release there.
          </v-card-text>
          <v-list density="compact">
            <v-list-item v-for="repo in repositoriesWithoutBranch" :key="repo.id">
              <template #prepend>
                <v-icon icon="mdi-source-repository" size="18" class="text-medium-emphasis" />
              </template>
              <v-list-item-title>{{ repo.name }}</v-list-item-title>
              <v-list-item-subtitle>
                {{ repo.providerName }} · {{ repo.namespace }}/{{ repo.repo }}
              </v-list-item-subtitle>
              <template #append>
                <a
                  :href="repo.url"
                  target="_blank"
                  rel="noopener"
                  class="text-body-small text-decoration-none text-medium-emphasis"
                >
                  open <v-icon icon="mdi-open-in-new" size="11" />
                </a>
              </template>
            </v-list-item>
          </v-list>
        </v-card>
      </template>
    </template>
  </v-container>
</template>
