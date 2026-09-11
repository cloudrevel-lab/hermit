<script setup>
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import EmptyHint from '../components/EmptyHint.vue'

const repos = ref([])
const providers = ref([])
const loading = ref(false)
const dialog = ref(false)
const confirmDelete = ref(null)
const probing = ref(false)
const saving = ref(false)

const form = reactive({ id: null, url: '', name: '', enabled: true })
const probe = ref(null)

async function load () {
  loading.value = true
  try {
    const [repoRes, providerRes] = await Promise.all([api.repos(), api.providers()])
    repos.value = repoRes.repos
    providers.value = providerRes.providers
  } catch (err) {
    notifyError(err)
  } finally {
    loading.value = false
  }
}

function openAdd () {
  Object.assign(form, { id: null, url: '', name: '', enabled: true })
  probe.value = null
  dialog.value = true
}

function openEdit (repo) {
  Object.assign(form, { id: repo.id, url: repo.url, name: repo.name, enabled: repo.enabled })
  probe.value = null
  dialog.value = true
}

/** Checks the URL parses and that the PAT can actually see the repo. */
async function runProbe () {
  if (!form.url.trim()) return
  probing.value = true
  probe.value = null
  try {
    probe.value = await api.probeRepo(form.url)
    if (!form.name) form.name = probe.value.info.name
  } catch (err) {
    probe.value = { ok: false, error: err.message, hint: err.hint }
  } finally {
    probing.value = false
  }
}

async function save () {
  saving.value = true
  try {
    const payload = { url: form.url, name: form.name, enabled: form.enabled }
    if (form.id) {
      await api.updateRepo(form.id, payload)
      notify('Repository updated')
    } else {
      await api.addRepo(payload)
      notify('Repository added')
    }
    dialog.value = false
    await load()
  } catch (err) {
    notifyError(err)
  } finally {
    saving.value = false
  }
}

async function toggleEnabled (repo) {
  try {
    await api.updateRepo(repo.id, { ...repo, enabled: !repo.enabled })
    await load()
  } catch (err) {
    notifyError(err)
  }
}

async function remove () {
  const repo = confirmDelete.value
  try {
    await api.deleteRepo(repo.id)
    notify(`Removed ${repo.name}`)
    confirmDelete.value = null
    await load()
  } catch (err) {
    notifyError(err)
  }
}

const branchInfo = reactive({})

async function checkBranches (repo) {
  branchInfo[repo.id] = { loading: true }
  try {
    const data = await api.branches(repo.id, true)
    const releases = data.branches.filter(b => b.name.startsWith('release/'))
    branchInfo[repo.id] = { loading: false, total: data.branches.length, releases: releases.length, at: data.fetchedAt }
  } catch (err) {
    branchInfo[repo.id] = { loading: false, error: err.message }
    notifyError(err)
  }
}

onMounted(load)
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6">
    <div class="d-flex align-center mb-4 ga-3">
      <div>
        <div class="text-body-2 text-medium-emphasis">
          Repositories tracked by this console. The provider is detected from each URL.</div>
      </div>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openAdd">Add repository</v-btn>
    </div>

    <v-card>
      <v-progress-linear v-if="loading" indeterminate />
      <EmptyHint
        v-if="!loading && !repos.length"
        icon="mdi-source-repository-multiple"
        title="No repositories configured"
        text="Paste a repository URL — the browse or branches page URL works fine."
      />
      <v-table v-else density="comfortable">
        <thead>
          <tr>
            <th class="text-left">Name</th>
            <th class="text-left">Provider</th>
            <th class="text-left">Namespace</th>
            <th class="text-left">Repository</th>
            <th class="text-left">Branches</th>
            <th class="text-left">Enabled</th>
            <th class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="repo in repos" :key="repo.id" class="hover-row">
            <td>
              <div class="font-weight-medium">{{ repo.name }}</div>
              <a :href="repo.url" target="_blank" rel="noopener"
                 class="text-caption text-decoration-none text-medium-emphasis">
                {{ repo.host }} <v-icon icon="mdi-open-in-new" size="11" />
              </a>
            </td>
            <td>
              <v-chip size="small" variant="tonal" :prepend-icon="repo.providerIcon">
                {{ repo.providerName }}
              </v-chip>
            </td>
            <td class="text-body-2">{{ repo.namespace }}</td>
            <td class="mono text-body-2">{{ repo.repo }}</td>
            <td>
              <v-btn v-if="!branchInfo[repo.id]" size="x-small" variant="text" prepend-icon="mdi-magnify"
                     @click="checkBranches(repo)">check</v-btn>
              <v-progress-circular v-else-if="branchInfo[repo.id].loading" size="16" width="2" indeterminate />
              <span v-else-if="branchInfo[repo.id].error" class="text-error text-caption">
                {{ branchInfo[repo.id].error }}
              </span>
              <span v-else class="text-body-2 numeric">
                {{ branchInfo[repo.id].releases }} release
                <span class="text-medium-emphasis">/ {{ branchInfo[repo.id].total }} total</span>
              </span>
            </td>
            <td>
              <v-switch :model-value="repo.enabled" color="primary" density="compact" hide-details inset
                        @update:model-value="toggleEnabled(repo)" />
            </td>
            <td class="text-right">
              <v-btn size="small" variant="text" icon="mdi-pencil-outline" @click="openEdit(repo)" />
              <v-btn size="small" variant="text" icon="mdi-delete-outline" color="error"
                     @click="confirmDelete = repo" />
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <!-- Add / edit -->
    <v-dialog v-model="dialog" max-width="640">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ form.id ? 'Edit repository' : 'Add repository' }}</v-card-title>
        <v-divider />
        <v-card-text class="d-flex flex-column ga-4">
          <v-textarea
            v-model="form.url"
            label="Repository URL"
            rows="2"
            auto-grow
            placeholder="https://github.com/owner/repo"
            hint="The browse, branches or clone URL all work. The provider is detected from the URL."
            persistent-hint
            @blur="runProbe"
          />

          <div v-if="providers.length" class="d-flex ga-2 flex-wrap align-center">
            <span class="text-caption text-medium-emphasis">Supported:</span>
            <v-chip v-for="provider in providers" :key="provider.id" size="x-small" variant="tonal"
                    :prepend-icon="provider.icon">
              {{ provider.urlExample }}
            </v-chip>
          </div>
          <v-btn variant="tonal" :loading="probing" prepend-icon="mdi-connection" @click="runProbe">
            Test connection
          </v-btn>

          <v-alert v-if="probe?.ok" type="success" density="compact">
            <div>
              <strong>{{ probe.provider.name }}</strong> — found
              <strong>{{ probe.info.name }}</strong> in {{ probe.described.namespace }},
              default branch <span class="mono">{{ probe.info.defaultBranch }}</span>.
            </div>
            <div v-if="!probe.provider.capabilities.cherryPick" class="text-caption mt-1">
              {{ probe.provider.name }} has no cherry-pick API, so that page will show git
              commands instead of applying them.
            </div>
          </v-alert>
          <v-alert v-else-if="probe" type="error" density="compact">
            {{ probe.error }}
            <div v-if="probe.hint" class="text-caption mt-1" style="white-space: pre-line">{{ probe.hint }}</div>
          </v-alert>

          <v-text-field v-model="form.name" label="Display name" placeholder="my-service" />
          <v-switch v-model="form.enabled" color="primary" label="Include in release comparisons" hide-details inset />
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Cancel</v-btn>
          <v-btn color="primary" :loading="saving" :disabled="!form.url.trim()" @click="save">
            {{ form.id ? 'Save' : 'Add' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirmation -->
    <v-dialog :model-value="Boolean(confirmDelete)" max-width="440" @update:model-value="confirmDelete = null">
      <v-card>
        <v-card-title class="text-subtitle-1">Remove repository?</v-card-title>
        <v-card-text class="text-body-2">
          <strong>{{ confirmDelete?.name }}</strong> will be dropped from this console.
          Nothing in Azure DevOps is changed.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmDelete = null">Cancel</v-btn>
          <v-btn color="error" @click="remove">Remove</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
