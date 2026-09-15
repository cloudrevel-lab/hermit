<script setup>
import { computed } from 'vue'
import { absoluteTime, commitBody, commitTitle, dateStamp, extractKeys, relativeTime } from '../composables/useFormat'

const props = defineProps({
  commit: { type: Object, required: true },
  issues: { type: Object, default: () => ({}) },   // key -> jira issue
  jiraHost: { type: String, default: '' },
  selectable: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  dense: { type: Boolean, default: false }
})
defineEmits(['update:selected'])

const title = computed(() => commitTitle(props.commit.message))
const body = computed(() => commitBody(props.commit.message))

// The server derives keys from the message, the source branch and the PR
// title, using the pattern from Settings. Falling back to the message alone
// keeps this component usable if it is ever handed a bare commit.
const keys = computed(() => props.commit.issueKeys ?? extractKeys(props.commit.message))

// Which branch this commit was merged from — the fastest way to see which
// ticket it belongs to, since branches are named after the ticket.
const pullRequest = computed(() => props.commit.pullRequests?.[0] || null)
const sourceBranch = computed(() => props.commit.sourceBranch || null)
const otherPullRequests = computed(() => (props.commit.pullRequests || []).slice(1))

// Azure sends a changeCounts object even when every count is zero, which would
// otherwise render as a bare separator with nothing after it.
const changes = computed(() => {
  const counts = props.commit.changeCounts
  if (!counts) return null
  const { Add = 0, Edit = 0, Delete = 0 } = counts
  return Add || Edit || Delete ? { Add, Edit, Delete } : null
})

// Azure prefixes squashed PR merges with "Merged PR 1234: "; surfacing the
// number separately keeps the actual subject readable.
const pr = computed(() => /^Merged PR (\d+):\s*/.exec(title.value)?.[1] || null)
const subject = computed(() => title.value.replace(/^Merged PR \d+:\s*/, ''))

function statusColor (issue) {
  return { done: 'success', indeterminate: 'info', new: 'secondary' }[issue?.statusCategory] || 'secondary'
}
</script>

<template>
  <div class="d-flex ga-3 px-3 py-2 hover-row" :class="{ 'py-1': dense }">
    <v-checkbox-btn
      v-if="selectable"
      :model-value="selected"
      density="compact"
      class="flex-0-0 mt-1"
      @update:model-value="$emit('update:selected', $event)"
    />

    <div class="flex-1-1 min-width-0">
      <div class="d-flex align-start ga-2 flex-wrap">
        <a :href="commit.url" target="_blank" rel="noopener" class="sha text-decoration-none text-medium-emphasis">
          {{ commit.shortId }}
        </a>
        <span class="commit-title wrap-anywhere">{{ subject }}</span>
      </div>

      <div class="d-flex align-center ga-2 mt-1 flex-wrap commit-meta">
        <span>{{ commit.author }}</span>
        <span>·</span>
        <span :title="absoluteTime(commit.date)" class="text-no-wrap">
          {{ relativeTime(commit.date) }}
          <span class="commit-date">({{ dateStamp(commit.date) }})</span>
        </span>
        <template v-if="changes">
          <span>·</span>
          <span class="numeric">
            <span v-if="changes.Add" class="text-success">+{{ changes.Add }}</span>
            <span v-if="changes.Edit" class="text-info ml-1">~{{ changes.Edit }}</span>
            <span v-if="changes.Delete" class="text-error ml-1">-{{ changes.Delete }}</span>
          </span>
        </template>
      </div>

      <div v-if="sourceBranch || pullRequest || pr || keys.length" class="d-flex align-center ga-1 mt-2 flex-wrap">
        <v-chip
          v-if="sourceBranch"
          size="x-small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-source-branch"
          class="branch-chip source-branch"
          :href="pullRequest?.url"
          target="_blank"
          rel="noopener"
        >
          {{ sourceBranch }}
          <v-tooltip activator="parent" location="top" max-width="420">
            <div class="font-weight-medium">merged from {{ sourceBranch }}</div>
            <div v-if="pullRequest" class="text-body-small mt-1">
              PR {{ pullRequest.pullRequestId }} into {{ pullRequest.targetBranch }}
              <template v-if="pullRequest.createdBy"> · {{ pullRequest.createdBy }}</template>
            </div>
            <div v-if="pullRequest?.title" class="text-body-small">{{ pullRequest.title }}</div>
            <div v-if="otherPullRequests.length" class="text-body-small mt-1">
              also in {{ otherPullRequests.map(p => `PR ${p.pullRequestId} → ${p.targetBranch}`).join(', ') }}
            </div>
          </v-tooltip>
        </v-chip>

        <v-chip
          v-if="pullRequest || pr"
          size="x-small"
          variant="tonal"
          color="info"
          class="mono"
          :href="pullRequest?.url"
          target="_blank"
          rel="noopener"
        >
          PR {{ pullRequest?.pullRequestId || pr }}
        </v-chip>

        <v-chip v-else-if="!sourceBranch" size="x-small" variant="text" class="text-disabled">
          no pull request
          <v-tooltip activator="parent" location="top" max-width="360">
            Pushed straight to the branch, or the pull request is no longer available.
          </v-tooltip>
        </v-chip>
        <v-divider v-if="(sourceBranch || pullRequest || pr) && keys.length" vertical class="mx-1 my-1" />

        <v-chip
          v-for="key in keys"
          :key="key"
          size="x-small"
          variant="tonal"
          :color="statusColor(issues[key])"
          :href="issues[key]?.url || (jiraHost ? `https://${jiraHost}/browse/${key}` : undefined)"
          target="_blank"
          rel="noopener"
          class="mono"
        >
          {{ key }}
          <v-tooltip v-if="issues[key]" activator="parent" location="top" max-width="380">
            <div class="font-weight-medium">{{ issues[key].summary }}</div>
            <div class="text-body-small">{{ issues[key].type }} · {{ issues[key].status }}<template v-if="issues[key].assignee"> · {{ issues[key].assignee }}</template></div>
          </v-tooltip>
        </v-chip>
      </div>

      <details v-if="body" class="mt-1">
        <summary class="text-body-small text-medium-emphasis" style="cursor: pointer">Message body</summary>
        <pre class="mono text-body-small mt-1 mb-0" style="white-space: pre-wrap">{{ body }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
.min-width-0 { min-width: 0; }

/* The calendar date supports the relative time rather than competing with it. */
.commit-date {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

/* Branch names get long; keep one from pushing the row wide. */
.source-branch :deep(.v-chip__content) {
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
