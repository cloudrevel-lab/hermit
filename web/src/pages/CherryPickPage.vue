<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import { readStored, writeStored } from '../composables/useStored'
import CommitRow from '../components/CommitRow.vue'
import EmptyHint from '../components/EmptyHint.vue'

const repos = ref([])
const repoId = ref(null)
const branches = ref([])
const left = ref(null)
const right = ref(null)
const loadingBranches = ref(false)
const comparing = ref(false)
const result = ref(null)
const settings = ref({})

// Commits staged to move, keyed by the side they came FROM.
const staged = ref({ left: new Set(), right: new Set() })
const applyDialog = ref(null)
const lastResult = ref(null)
const activeRepo = computed(() => repos.value.find(r => r.id === repoId.value) || null)
// Some providers (GitHub) have no cherry-pick endpoint at all.
const providerCanCherryPick = computed(() => activeRepo.value?.capabilities?.cherryPick ?? false)
const writesAllowed = computed(() => settings.value.allowCherryPickWrites && providerCanCherryPick.value)
const applying = ref(false)
const topicBranch = ref('')
const landMode = ref('auto')

// How far the console carries the commits. They always reach a topic branch
// first; the rest is what Azure's API cannot do in one step.
const landModes = computed(() => [
  {
    value: 'auto',
    title: 'Merge into the target branch',
    subtitle: `Opens a PR into ${applyDialog.value?.ontoRef || 'the target'} and completes it once policies pass`,
    disabled: !settings.value.allowCherryPickAutoComplete,
    disabledHint: 'Enable "Let the console complete the pull request" in Settings'
  },
  {
    value: 'pr',
    title: 'Open a pull request, leave it to review',
    subtitle: 'Creates the PR but does not complete it',
    disabled: false
  },
  {
    value: 'branch',
    title: 'Topic branch only',
    subtitle: 'You raise the pull request yourself',
    disabled: false
  }
])

const SELECTION_KEY = 'cherryPick.selection'

// Held until the branch list for the restored repo has loaded; the refs cannot
// be applied before then because changing the repo clears them.
let pendingRestore = readStored(SELECTION_KEY)

watch([repoId, left, right], ([repo, leftRef, rightRef]) => {
  if (repo && leftRef && rightRef) {
    writeStored(SELECTION_KEY, { repoId: repo, left: leftRef, right: rightRef })
  }
})

async function loadRepos () {
  try {
    const data = await api.repos()
    repos.value = data.repos.filter(r => r.enabled)
    settings.value = (await api.settings()).settings

    const remembered = repos.value.some(r => r.id === pendingRestore?.repoId)
    if (remembered) repoId.value = pendingRestore.repoId
    else if (repos.value.length === 1) repoId.value = repos.value[0].id
  } catch (err) {
    notifyError(err)
  }
}

watch(repoId, async (id) => {
  left.value = right.value = null
  result.value = null
  branches.value = []
  if (!id) return
  loadingBranches.value = true
  try {
    const data = await api.branches(id)
    branches.value = data.branches.map(b => b.name)

    // A remembered ref that has since been deleted is simply not restored.
    if (pendingRestore?.repoId === id) {
      if (branches.value.includes(pendingRestore.left)) left.value = pendingRestore.left
      if (branches.value.includes(pendingRestore.right)) right.value = pendingRestore.right
      pendingRestore = null
    }
  } catch (err) {
    notifyError(err)
  } finally {
    loadingBranches.value = false
  }
})

/** Flip the two refs, as `git log left..right` becomes `git log right..left`. */
function swapSides () {
  ;[left.value, right.value] = [right.value, left.value]
  // Keep any result already on screen consistent with the new sides rather than
  // leaving the panes reading in the opposite order to the selects.
  if (result.value) {
    result.value = { ...result.value, left: result.value.right, right: result.value.left }
    staged.value = { left: staged.value.right, right: staged.value.left }
  }
}

async function compare (refresh = false) {
  if (!repoId.value || !left.value || !right.value) return
  comparing.value = true
  result.value = null
  staged.value = { left: new Set(), right: new Set() }
  try {
    result.value = await api.compareRefs({ repoId: repoId.value, left: left.value, right: right.value, refresh })
  } catch (err) {
    notifyError(err)
  } finally {
    comparing.value = false
  }
}

function isStaged (side, id) {
  return staged.value[side].has(id)
}

function setStaged (side, id, on) {
  const next = new Set(staged.value[side])
  on ? next.add(id) : next.delete(id)
  staged.value = { ...staged.value, [side]: next }
}

function stageAll (side) {
  const commits = result.value?.[side]?.commits || []
  staged.value = { ...staged.value, [side]: new Set(commits.map(c => c.commitId)) }
}

function clearStaged (side) {
  staged.value = { ...staged.value, [side]: new Set() }
}

/** Commits selected on `from` are applied onto the opposite branch. */
function openApply (from) {
  const to = from === 'left' ? 'right' : 'left'
  const ids = [...staged.value[from]]
  if (!ids.length) return
  const commits = (result.value[from].commits || []).filter(c => ids.includes(c.commitId))
  // Azure applies commits in the order given; oldest first matches git's behaviour.
  const ordered = [...commits].reverse()
  applyDialog.value = { from, to, ontoRef: result.value[to].ref, commits: ordered }
  topicBranch.value = `cherry-pick/${result.value[to].ref.replace(/[^\w.-]+/g, '-')}-${Date.now().toString(36)}`
  landMode.value = settings.value.allowCherryPickAutoComplete ? 'auto' : 'pr'
}

const gitCommands = computed(() => {
  const dialog = applyDialog.value
  if (!dialog) return ''
  const lines = [
    `git fetch origin`,
    `git switch -c ${topicBranch.value} origin/${dialog.ontoRef}`,
    `git cherry-pick ${dialog.commits.map(c => c.commitId.slice(0, 10)).join(' ')}`,
    `git push -u origin ${topicBranch.value}`
  ]
  // The console reaches the target through a PR; the local equivalent is a merge.
  if (landMode.value !== 'branch') {
    lines.push(
      ``,
      `# then, once reviewed:`,
      `git switch ${dialog.ontoRef} && git merge --no-ff ${topicBranch.value}`,
      `git push origin ${dialog.ontoRef}`
    )
  }
  return lines.join('\n')
})

function copyCommands () {
  navigator.clipboard.writeText(gitCommands.value)
    .then(() => notify('git commands copied'))
    .catch(() => notify('Could not access the clipboard', { color: 'error' }))
}

async function applyViaApi () {
  applying.value = true
  try {
    const ontoRef = applyDialog.value.ontoRef
    const res = await api.cherryPick({
      repoId: repoId.value,
      commitIds: applyDialog.value.commits.map(c => c.commitId),
      ontoRef,
      topicBranch: topicBranch.value,
      mode: landMode.value
    })

    if (res.warning) {
      notify(res.warning.message, { color: 'warning', hint: res.warning.hint })
    } else if (res.pullRequest?.autoComplete) {
      notify(`PR !${res.pullRequest.pullRequestId} will merge into ${ontoRef}`, {
        hint: 'It completes as soon as branch policies pass. The picked commits arrive with new commit ids, so this branch pair will still look divergent afterwards.'
      })
    } else if (res.pullRequest) {
      notify(`PR !${res.pullRequest.pullRequestId} opened into ${ontoRef}`, {
        hint: 'Review and complete it in Azure DevOps.'
      })
    } else {
      notify(`Cherry-pick started on ${res.topicBranch}`, {
        hint: 'Azure applies the commits to that new branch. Raise a PR from it when the job finishes.'
      })
    }
    lastResult.value = res
    applyDialog.value = null
    await compare(true)
  } catch (err) {
    notifyError(err)
  } finally {
    applying.value = false
  }
}

const sides = [
  { key: 'left', label: 'Left', arrow: 'mdi-arrow-right-bold', arrowLabel: 'Apply to right' },
  { key: 'right', label: 'Right', arrow: 'mdi-arrow-left-bold', arrowLabel: 'Apply to left' }
]

onMounted(loadRepos)
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6">
    <v-card class="mb-4">
      <v-card-text>
        <div class="section-label mb-3">Compare two refs in one repository</div>
        <v-row dense align="center">
          <v-col cols="12" md="3">
            <v-select v-model="repoId" :items="repos.map(r => ({ title: r.name, value: r.id }))"
                      label="Repository" prepend-inner-icon="mdi-source-repository" />
          </v-col>
          <v-col cols="12" md="6">
            <div class="d-flex align-center ga-2">
              <v-autocomplete v-model="left" :items="branches" label="Left branch"
                              class="flex-1-1" style="min-width: 0"
                              :loading="loadingBranches" :disabled="!repoId"
                              prepend-inner-icon="mdi-source-branch" />
              <!-- Offset by the height of the fields' details slot so the icon sits on their centre line. -->
              <v-btn icon variant="text" density="comfortable" class="flex-0-0" style="margin-bottom: 22px"
                     :disabled="!left && !right"
                     aria-label="Swap left and right branches"
                     @click="swapSides">
                <v-icon icon="mdi-swap-horizontal" />
                <v-tooltip activator="parent" location="top">Swap sides</v-tooltip>
              </v-btn>
              <v-autocomplete v-model="right" :items="branches" label="Right branch"
                              class="flex-1-1" style="min-width: 0"
                              :loading="loadingBranches" :disabled="!repoId"
                              prepend-inner-icon="mdi-source-branch" />
            </div>
          </v-col>
          <v-col cols="12" md="3">
            <v-btn block color="primary" prepend-icon="mdi-compare-horizontal" :loading="comparing"
                   :disabled="!left || !right || left === right" @click="compare(false)">
              Compare
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-alert v-if="activeRepo && !providerCanCherryPick" type="info" density="compact" class="mb-4">
      {{ activeRepo.providerName }} has no cherry-pick API. Select commits and copy the exact
      <span class="mono">git cherry-pick</span> commands to run locally.
    </v-alert>
    <v-alert v-else-if="!settings.allowCherryPickWrites" type="info" density="compact" class="mb-4">
      Cherry-pick writes are disabled. You can still select commits and copy the exact
      <span class="mono">git cherry-pick</span> commands. Enable writes in Settings to let
      {{ activeRepo?.providerName || 'the provider' }} apply them to a new topic branch for you.
    </v-alert>

    <v-alert v-if="lastResult?.pullRequest" type="success" density="compact" class="mb-4"
             closable @click:close="lastResult = null">
      <div class="d-flex align-center ga-3 flex-wrap">
        <span>
          PR !{{ lastResult.pullRequest.pullRequestId }} into
          <span class="mono">{{ lastResult.pullRequest.targetBranch }}</span>
          — {{ lastResult.pullRequest.autoComplete ? 'set to complete automatically' : 'waiting for review' }}
        </span>
        <v-btn size="x-small" variant="tonal" append-icon="mdi-open-in-new"
               :href="lastResult.pullRequest.url" target="_blank" rel="noopener">
          Open in {{ activeRepo?.providerName }}
        </v-btn>
      </div>
    </v-alert>

    <EmptyHint
      v-if="!repos.length"
      icon="mdi-source-repository-multiple"
      title="No repositories configured"
      action-text="Add a repository"
      action-to="/repositories"
    />

    <v-skeleton-loader v-else-if="comparing" type="article, list-item-three-line@2" class="rounded-lg" />

    <v-row v-else-if="result" dense>
      <v-col v-for="side in sides" :key="side.key" cols="12" md="6">
        <v-card class="h-100 d-flex flex-column">
          <v-card-title class="text-subtitle-2 d-flex align-center ga-2 flex-wrap">
            <v-chip size="small" variant="tonal" class="branch-chip"
                    :color="side.key === 'left' ? undefined : 'primary'">
              {{ result[side.key].ref }}
            </v-chip>
            <span class="text-caption text-medium-emphasis">
              {{ result[side.key].commits.length }} commits not on the other side
            </span>
          </v-card-title>
          <v-divider />

          <div class="d-flex align-center ga-1 px-3 py-2">
            <v-btn size="x-small" variant="text" @click="stageAll(side.key)">Select all</v-btn>
            <v-btn size="x-small" variant="text" :disabled="!staged[side.key].size"
                   @click="clearStaged(side.key)">Clear</v-btn>
            <v-spacer />
            <v-btn
              size="small"
              variant="tonal"
              color="primary"
              :prepend-icon="side.arrow"
              :disabled="!staged[side.key].size"
              @click="openApply(side.key)"
            >
              {{ staged[side.key].size }} {{ side.arrowLabel }}
            </v-btn>
          </div>
          <v-divider />

          <div v-if="!result[side.key].commits.length" class="pa-6 text-center text-body-2 text-medium-emphasis">
            Nothing here that the other branch is missing.
          </div>
          <div v-else class="scroll-pane flex-1-1" style="max-height: 620px">
            <template v-for="(commit, index) in result[side.key].commits" :key="commit.commitId">
              <v-divider v-if="index" />
              <CommitRow
                :commit="commit"
                selectable
                :selected="isStaged(side.key, commit.commitId)"
                @update:selected="setStaged(side.key, commit.commitId, $event)"
              />
            </template>
          </div>
        </v-card>
      </v-col>
    </v-row>

    <!-- Apply dialog -->
    <v-dialog :model-value="Boolean(applyDialog)" max-width="720" @update:model-value="applyDialog = null">
      <v-card v-if="applyDialog">
        <v-card-title class="text-subtitle-1">
          Apply {{ applyDialog.commits.length }} commit(s) onto
          <span class="mono">{{ applyDialog.ontoRef }}</span>
        </v-card-title>
        <v-divider />
        <v-card-text class="d-flex flex-column ga-4">
          <v-alert v-if="providerCanCherryPick" type="info" density="compact">
            Azure can only cherry-pick onto a <strong>new topic branch</strong>, so the commits land
            there first and reach <span class="mono">{{ applyDialog.ontoRef }}</span> through a pull
            request. Nothing is force-pushed and the target branch is never rewritten.
          </v-alert>

          <div v-if="providerCanCherryPick">
            <div class="section-label mb-2">How far to take it</div>
            <v-radio-group v-model="landMode" hide-details density="compact" class="mt-0">
              <v-radio v-for="mode in landModes" :key="mode.value"
                       :value="mode.value" :disabled="mode.disabled">
                <template #label>
                  <div>
                    <div class="text-body-2">{{ mode.title }}</div>
                    <div class="text-caption text-medium-emphasis">
                      {{ mode.disabled ? mode.disabledHint : mode.subtitle }}
                    </div>
                  </div>
                </template>
              </v-radio>
            </v-radio-group>
          </div>

          <v-alert v-if="landMode === 'auto'" type="warning" density="compact">
            The pull request completes without review as soon as branch policies pass, merging into
            <span class="mono">{{ applyDialog.ontoRef }}</span>.
          </v-alert>

          <v-text-field v-model="topicBranch" label="New topic branch" prepend-inner-icon="mdi-source-branch-plus" />

          <div>
            <div class="section-label mb-2">Commits, oldest first</div>
            <v-card variant="tonal" class="scroll-pane" style="max-height: 200px">
              <div v-for="commit in applyDialog.commits" :key="commit.commitId"
                   class="px-3 py-1 text-body-2 d-flex ga-2">
                <span class="sha">{{ commit.shortId }}</span>
                <span class="text-truncate">{{ commit.message.split('\n')[0] }}</span>
              </div>
            </v-card>
          </div>

          <div>
            <div class="d-flex align-center mb-2">
              <span class="section-label">Equivalent git commands</span>
              <v-spacer />
              <v-btn size="x-small" variant="text" prepend-icon="mdi-content-copy" @click="copyCommands">Copy</v-btn>
            </div>
            <pre class="mono text-caption pa-3 rounded" style="background: rgba(127,145,190,0.12); white-space: pre-wrap">{{ gitCommands }}</pre>
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="applyDialog = null">Close</v-btn>
          <v-btn
            color="primary"
            :loading="applying"
            :disabled="!writesAllowed"
            @click="applyViaApi"
          >
            <template v-if="writesAllowed && landMode === 'auto'">Cherry-pick and merge into {{ applyDialog.ontoRef }}</template>
            <template v-else-if="writesAllowed && landMode === 'pr'">Cherry-pick and open a PR</template>
            <template v-else-if="writesAllowed">Cherry-pick to a topic branch</template>
            <template v-else-if="!providerCanCherryPick">Not supported by {{ activeRepo?.providerName }}</template>
            <template v-else>Writes disabled in Settings</template>
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
