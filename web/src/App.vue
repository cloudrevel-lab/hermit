<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useTheme } from 'vuetify'
import { navRoutes } from './router'
import { api } from './api'
import { rememberTheme } from './plugins/vuetify'
import { toast } from './composables/useToast'
import { setDisplayTimezone } from './composables/useFormat'

const route = useRoute()
const theme = useTheme()
const rail = ref(false)
const auth = ref(null)
const repos = ref([])
const providers = ref([])

// Pages whose in-memory state is expensive to rebuild stay mounted while the
// user visits another page, so coming back is instant rather than a reload.
// Repositories and Settings are left out so they always show fresh data.
const cachedPages = ['ReleasesPage', 'CherryPickPage', 'JiraReleasesPage']

const isDark = computed(() => theme.global.current.value.dark)

function toggleTheme () {
  theme.change(isDark.value ? 'light' : 'dark')
}

// Watching the theme rather than the button means any other route to a theme
// change is persisted too. The initial value is already the stored one.
watch(() => theme.name.value, rememberTheme)

function hasCredential (host) {
  return Boolean(auth.value?.machines?.some(m => m.hasPassword &&
    (m.machine === host || host.endsWith('.' + m.machine) || m.machine === '*')))
}

/**
 * One chip per provider actually in use, rather than a hard-coded list — a new
 * plugin shows up here as soon as a repository uses it.
 */
const providerChips = computed(() => {
  const byId = new Map(providers.value.map(p => [p.id, p]))
  const seen = new Map()
  for (const repo of repos.value) {
    if (!seen.has(repo.provider)) {
      const provider = byId.get(repo.provider)
      seen.set(repo.provider, {
        id: repo.provider,
        name: provider?.name || repo.provider,
        icon: provider?.icon || 'mdi-source-repository',
        optional: provider?.credential?.optional ?? false,
        hosts: new Set()
      })
    }
    seen.get(repo.provider).hosts.add(repo.host)
  }
  return [...seen.values()].map(entry => {
    const hosts = [...entry.hosts]
    const ready = hosts.every(hasCredential)
    return {
      ...entry,
      ready,
      tooltip: ready
        ? `Token found for ${hosts.join(', ')}`
        : entry.optional
          ? `No token for ${hosts.join(', ')} — public repositories still work, with a low rate limit`
          : `No token for ${hosts.join(', ')} in ~/.authinfo`
    }
  })
})

const jiraHost = computed(() =>
  auth.value?.machines?.find(m => m.machine.includes('atlassian.net'))?.machine || null)
const jiraReady = computed(() => Boolean(jiraHost.value && hasCredential(jiraHost.value)))

onMounted(async () => {
  // Applied here rather than per page so every date on screen agrees, whichever
  // page the user lands on first.
  api.settings()
    .then(({ settings }) => setDisplayTimezone(settings.timezone))
    .catch(() => { /* dates fall back to the browser zone */ })

  const [authRes, reposRes, providersRes] = await Promise.allSettled([
    api.auth(), api.repos(), api.providers()
  ])
  if (authRes.status === 'fulfilled') auth.value = authRes.value
  if (reposRes.status === 'fulfilled') repos.value = reposRes.value.repos
  if (providersRes.status === 'fulfilled') providers.value = providersRes.value.providers
})
</script>

<template>
  <v-app>
    <v-navigation-drawer :rail="rail" permanent border width="232">
      <div class="d-flex align-center pa-3 ga-3">
        <v-avatar color="primary" size="34" rounded="md">
          <v-icon icon="mdi-hexagon-multiple-outline" size="20" />
        </v-avatar>
        <div v-if="!rail" class="text-truncate">
          <div class="text-body-medium font-weight-bold">Hermit Console</div>
        </div>
      </div>

      <v-divider />

      <v-list nav class="pa-2">
        <v-list-item
          v-for="item in navRoutes"
          :key="item.name"
          :to="item.path"
          :prepend-icon="item.meta.icon"
          :title="item.meta.title"
          rounded="md"
        />
      </v-list>

      <template #append>
        <v-divider />
        <v-list nav class="pa-2">
          <v-list-item
            :prepend-icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            :title="rail ? '' : 'Collapse'"
            rounded="md"
            @click="rail = !rail"
          />
        </v-list>
      </template>
    </v-navigation-drawer>

    <v-app-bar flat border height="56">
      <v-app-bar-title class="page-title">{{ route.meta.title }}</v-app-bar-title>
      <v-spacer />

      <v-tooltip v-for="chip in providerChips" :key="chip.id" location="bottom" :text="chip.tooltip">
        <template #activator="{ props }">
          <v-chip v-bind="props" size="small" class="mr-2" variant="tonal"
                  :color="chip.ready ? 'success' : (chip.optional ? 'info' : 'warning')"
                  :prepend-icon="chip.icon">
            {{ chip.name }}
          </v-chip>
        </template>
      </v-tooltip>

      <v-tooltip v-if="jiraHost" location="bottom" :text="jiraReady ? 'Jira token found in ~/.authinfo' : 'No Jira token in ~/.authinfo'">
        <template #activator="{ props }">
          <v-chip v-bind="props" size="small" class="mr-3" variant="tonal"
                  :color="jiraReady ? 'success' : 'warning'"
                  :prepend-icon="jiraReady ? 'mdi-shield-check-outline' : 'mdi-shield-alert-outline'">
            Jira
          </v-chip>
        </template>
      </v-tooltip>

      <v-btn :icon="isDark ? 'mdi-weather-night' : 'mdi-weather-sunny'" variant="text" @click="toggleTheme" />
    </v-app-bar>

    <v-main>
      <router-view v-slot="{ Component }">
        <keep-alive :include="cachedPages">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </v-main>

    <v-snackbar v-model="toast.show" :color="toast.color" location="bottom right" :timeout="toast.hint ? 9000 : 4500">
      <div class="font-weight-medium">{{ toast.text }}</div>
      <div v-if="toast.hint" class="text-body-small mt-1" style="white-space: pre-line">{{ toast.hint }}</div>
    </v-snackbar>
  </v-app>
</template>
