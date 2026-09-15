<script setup>
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import { relativeTime, shortDate } from '../composables/useFormat'
import { readStored, writeStored } from '../composables/useStored'
import EmptyHint from '../components/EmptyHint.vue'

const releases = ref([])
const settings = ref({})
const selectedId = ref(null)
const detail = ref(null)
const loading = ref(false)
const loadingIssues = ref(false)
const adding = ref(false)
const confirmDelete = ref(null)
const filter = ref('')

// Fix Versions defined on the project, offered as suggestions. Free text is
// still accepted — a version can be typed before anyone has created it.
const knownVersions = ref([])
const versionsError = ref(null)
const newVersion = ref(null)

const SELECTION_KEY = 'jiraReleases.selected'

async function load () {
  loading.value = true
  try {
    const [releaseRes, cfg] = await Promise.all([api.jiraReleases(), api.settings()])
    releases.value = releaseRes.releases
    settings.value = cfg.settings

    const stored = readStored(SELECTION_KEY)
    const remembered = releases.value.some(r => r.id === stored)
    selectedId.value = remembered ? stored : releases.value[0]?.id || null
  } catch (err) {
    notifyError(err)
  } finally {
    loading.value = false
  }
  loadKnownVersions()
}

async function loadKnownVersions (refresh = false) {
  if (!settings.value.jiraBaseUrl) return
  try {
    const data = await api.jiraProjectVersions(refresh)
    knownVersions.value = data.versions
    versionsError.value = null
  } catch (err) {
    // Suggestions are a convenience; typing a name by hand still works.
    versionsError.value = err.message
  }
}

const suggestions = computed(() => {
  const pinned = new Set(releases.value.map(r => r.name.toLowerCase()))
  return knownVersions.value
    .filter(v => !v.archived && !pinned.has(v.name.toLowerCase()))
    .map(v => ({
      title: v.name,
      value: v.name,
      // Vuetify applies an item's `props` to the rendered v-list-item. A custom
      // #item slot looks like the obvious way to add a subtitle here, but on
      // v-combobox it suppresses every option — do not reintroduce one.
      props: {
        subtitle: [v.released ? 'released' : 'unreleased', v.releaseDate ? shortDate(v.releaseDate) : null]
          .filter(Boolean).join(' · ')
      }
    }))
})

/**
 * v-combobox hands back the whole item object when the user picks from the
 * list, and a plain string only when they type free text. Both have to be
 * accepted, or selecting a suggestion throws instead of adding anything.
 */
const versionName = computed(() => {
  const value = newVersion.value
  if (!value) return ''
  return String(typeof value === 'string' ? value : value.title ?? value.value ?? '').trim()
})

async function addRelease () {
  const name = versionName.value
  if (!name) return
  adding.value = true
  try {
    const { release } = await api.addJiraRelease({ name })
    releases.value.push(release)
    newVersion.value = null
    selectedId.value = release.id
    notify(`Pinned ${release.name}`)
  } catch (err) {
    notifyError(err)
  } finally {
    adding.value = false
  }
}

async function removeRelease () {
  const release = confirmDelete.value
  try {
    await api.deleteJiraRelease(release.id)
    releases.value = releases.value.filter(r => r.id !== release.id)
    if (selectedId.value === release.id) selectedId.value = releases.value[0]?.id || null
    confirmDelete.value = null
    notify(`Removed ${release.name}`)
  } catch (err) {
    notifyError(err)
  }
}

async function loadIssues (refresh = false) {
  if (!selectedId.value) { detail.value = null; return }
  loadingIssues.value = true
  try {
    detail.value = await api.jiraReleaseIssues(selectedId.value, refresh)
  } catch (err) {
    detail.value = null
    notifyError(err)
  } finally {
    loadingIssues.value = false
  }
}

watch(selectedId, id => {
  if (id) writeStored(SELECTION_KEY, id)
  filter.value = ''
  loadIssues()
})

const selected = computed(() => releases.value.find(r => r.id === selectedId.value) || null)

const issues = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const all = detail.value?.issues || []
  if (!needle) return all
  return all.filter(i =>
    `${i.key} ${i.summary} ${i.status} ${i.type} ${i.assignee || ''}`.toLowerCase().includes(needle))
})

/** Progress at a glance: how much of the release is actually finished. */
const statusBreakdown = computed(() => {
  const counts = { done: 0, indeterminate: 0, new: 0 }
  for (const issue of detail.value?.issues || []) {
    counts[issue.statusCategory] = (counts[issue.statusCategory] || 0) + 1
  }
  const total = detail.value?.issues?.length || 0
  return { ...counts, total, percentDone: total ? Math.round((counts.done / total) * 100) : 0 }
})

function statusColor (category) {
  return { done: 'success', indeterminate: 'info', new: 'secondary' }[category] || 'secondary'
}

// Templates cannot reach `window`, so row clicks go through a method.
function openIssue (issue) {
  window.open(issue.url, '_blank', 'noopener')
}

function copyKeys () {
  navigator.clipboard.writeText(issues.value.map(i => i.key).join('\n'))
    .then(() => notify(`Copied ${issues.value.length} issue keys`))
    .catch(() => notify('Could not access the clipboard', { color: 'error' }))
}

onMounted(load)

onActivated(() => {
  // A kept-alive page holds its data. Re-read the pinned list and settings on
  // return so a change made in Settings is picked up; the ticket list stays.
  if (releases.value.length) load()
})
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6">
    <v-alert v-if="!loading && !settings.jiraBaseUrl" type="warning" density="compact" class="mb-4">
      No Jira site configured. Set the Jira base URL in Settings before pinning a release.
    </v-alert>

    <v-row dense>
      <!-- Pinned releases -->
      <v-col cols="12" md="4" lg="3">
        <v-card class="mb-3">
          <v-card-title class="text-subtitle-2 d-flex align-center ga-2">
            <v-icon icon="mdi-tag-plus-outline" size="18" /> Pin a Fix Version
          </v-card-title>
          <v-divider />
          <v-card-text class="d-flex flex-column ga-3">
            <v-combobox
              v-model="newVersion"
              :items="suggestions"
              label="Fix Version"
              placeholder="My Project 1.2.3 (Next Release)"
              prepend-inner-icon="mdi-tag-outline"
              :hint="versionsError
                ? 'Could not list the project\'s versions — type the name exactly as it appears in Jira.'
                : 'Pick one from the project, or type a name.'"
              persistent-hint
              clearable
              @keyup.enter="addRelease"
            />
            <v-btn color="primary" prepend-icon="mdi-plus" :loading="adding"
                   :disabled="!versionName" @click="addRelease">
              Add release
            </v-btn>
          </v-card-text>
        </v-card>

        <v-card>
          <v-card-title class="text-subtitle-2 d-flex align-center ga-2">
            <v-icon icon="mdi-bookmark-multiple-outline" size="18" /> Pinned
            <v-chip v-if="releases.length" size="x-small" variant="tonal">{{ releases.length }}</v-chip>
            <v-spacer />
            <span v-if="releases.length > 1" class="text-caption text-medium-emphasis">click to switch</span>
          </v-card-title>
          <v-divider />
          <v-progress-linear v-if="loading" indeterminate />
          <EmptyHint
            v-else-if="!releases.length"
            icon="mdi-bookmark-outline"
            title="Nothing pinned yet"
            text="Add a Fix Version above to see its tickets."
          />
          <v-list v-else nav density="compact" class="pa-2">
            <v-list-item
              v-for="release in releases"
              :key="release.id"
              :active="release.id === selectedId"
              color="primary"
              rounded="md"
              @click="selectedId = release.id"
            >
              <template #prepend>
                <v-icon
                  :icon="release.id === selectedId ? 'mdi-circle-slice-8' : 'mdi-circle-outline'"
                  size="12"
                  class="mr-2"
                />
              </template>
              <v-list-item-title class="text-body-2">{{ release.name }}</v-list-item-title>
              <v-list-item-subtitle v-if="release.projectKey" class="text-caption">
                {{ release.projectKey }}
              </v-list-item-subtitle>
              <template #append>
                <v-btn size="x-small" variant="text" icon="mdi-close" color="error"
                       @click.stop="confirmDelete = release" />
              </template>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>

      <!-- Tickets -->
      <v-col cols="12" md="8" lg="9">
        <EmptyHint
          v-if="!selected && !loading"
          icon="mdi-clipboard-list-outline"
          title="No release selected"
          text="Pin a Fix Version and select it to list its tickets."
        />

        <v-card v-else-if="selected">
          <v-card-title class="d-flex align-center ga-2 flex-wrap">
            <v-icon icon="mdi-clipboard-list-outline" size="18" />
            <span class="text-subtitle-1 font-weight-medium">{{ selected.name }}</span>
            <v-chip v-if="detail?.meta" size="small" variant="tonal"
                    :color="detail.meta.released ? 'success' : 'info'">
              {{ detail.meta.released ? 'released' : 'unreleased' }}
              <template v-if="detail.meta.releaseDate"> · {{ shortDate(detail.meta.releaseDate) }}</template>
            </v-chip>
            <v-spacer />
            <v-chip v-if="detail?.cached" size="x-small" variant="text" class="text-medium-emphasis"
                    prepend-icon="mdi-database-outline">
              cached {{ relativeTime(detail.fetchedAt) }}
            </v-chip>
            <v-btn size="small" variant="text" prepend-icon="mdi-refresh"
                   :loading="loadingIssues" @click="loadIssues(true)">
              Reload
            </v-btn>
          </v-card-title>
          <v-divider />

          <v-card-text v-if="detail && statusBreakdown.total" class="pb-2">
            <div class="d-flex align-center ga-3 flex-wrap mb-2">
              <div class="text-h5 font-weight-bold numeric">{{ statusBreakdown.total }}</div>
              <span class="text-body-2 text-medium-emphasis">tickets</span>
              <v-chip size="small" variant="tonal" color="success">{{ statusBreakdown.done }} done</v-chip>
              <v-chip size="small" variant="tonal" color="info">{{ statusBreakdown.indeterminate }} in progress</v-chip>
              <v-chip size="small" variant="tonal">{{ statusBreakdown.new }} to do</v-chip>
              <v-spacer />
              <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyKeys">
                Copy keys
              </v-btn>
            </div>
            <v-progress-linear :model-value="statusBreakdown.percentDone" color="success"
                               height="6" rounded bg-opacity="0.15" />
          </v-card-text>

          <v-progress-linear v-if="loadingIssues" indeterminate />

          <template v-if="detail">
            <v-divider />
            <div class="pa-3">
              <v-text-field
                v-model="filter"
                placeholder="Filter by key, summary, status or assignee"
                prepend-inner-icon="mdi-magnify"
                clearable
              />
            </div>
            <v-divider />

            <div v-if="!detail.issues.length" class="pa-8 text-center">
              <div class="text-subtitle-1">No tickets carry this Fix Version</div>
              <div class="text-body-2 text-medium-emphasis mt-1">
                Check the name matches Jira exactly — it is matched literally.
              </div>
            </div>

            <div v-else class="scroll-pane" style="max-height: 620px">
              <v-table density="comfortable">
                <thead>
                  <tr>
                    <th class="text-left" style="width: 1%">Key</th>
                    <th class="text-left">Summary</th>
                    <th class="text-left">Type</th>
                    <th class="text-left">Status</th>
                    <th class="text-left">Assignee</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="issue in issues" :key="issue.key" class="hover-row" style="cursor: pointer"
                      @click="openIssue(issue)">
                    <td>
                      <a :href="issue.url" target="_blank" rel="noopener"
                         class="mono text-decoration-none text-primary text-no-wrap" @click.stop>
                        {{ issue.key }}
                      </a>
                    </td>
                    <td class="text-body-2 wrap-anywhere">{{ issue.summary }}</td>
                    <td class="text-body-2 text-medium-emphasis">{{ issue.type }}</td>
                    <td>
                      <v-chip size="x-small" variant="tonal" :color="statusColor(issue.statusCategory)">
                        {{ issue.status }}
                      </v-chip>
                    </td>
                    <td class="text-body-2 text-medium-emphasis">{{ issue.assignee || '—' }}</td>
                  </tr>
                </tbody>
              </v-table>
              <div v-if="!issues.length" class="pa-4 text-body-2 text-medium-emphasis">
                No tickets match "{{ filter }}".
              </div>
            </div>
          </template>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog :model-value="Boolean(confirmDelete)" max-width="440" @update:model-value="confirmDelete = null">
      <v-card>
        <v-card-title class="text-subtitle-1">Unpin release?</v-card-title>
        <v-card-text class="text-body-2">
          <strong>{{ confirmDelete?.name }}</strong> will be removed from this list.
          Nothing in Jira is changed.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = null">Cancel</v-btn>
          <v-btn color="error" @click="removeRelease">Unpin</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
