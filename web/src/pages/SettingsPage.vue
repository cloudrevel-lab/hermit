<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'
import { notify, notifyError } from '../composables/useToast'
import { absoluteTimeIn, browserTimezone, setDisplayTimezone } from '../composables/useFormat'

const settings = ref({
  releaseBranchPrefix: 'release/',
  jiraBaseUrl: '',
  jiraProjectKey: '',
  issueKeyPattern: '',
  allowCherryPickWrites: false,
  allowCherryPickAutoComplete: false,
  timezone: '',
  timeLoggerSite: '',
  timeLoggerProject: '',
  timeLoggerHoursPerDay: 8,
  timeLoggerDefaultLogTime: '09:00'
})

// 400-odd IANA names; the autocomplete makes them searchable.
const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return [browserTimezone(), 'UTC'].filter(Boolean)
  }
})()

const zoneItems = [
  { title: `Automatic — use this browser (${browserTimezone()})`, value: '' },
  // supportedValuesOf lists canonical zones only, which leaves out UTC even
  // though Intl accepts it — and it is an obvious choice for reading commits.
  { title: 'UTC', value: 'UTC' },
  ...zones.filter(zone => zone !== 'UTC').map(zone => ({ title: zone, value: zone }))
]

// Previews the selected zone without applying it, so backing out of the page
// without saving leaves the rest of the app on the stored setting.
const nowPreview = computed(() =>
  absoluteTimeIn(new Date().toISOString(), settings.value.timezone) || 'unrecognised timezone')
const auth = ref(null)
const cache = ref(null)
const providers = ref([])
const saving = ref(false)
const cert = ref(null)
const certFile = ref(null)
const certBusy = ref(false)
const certTest = ref(null)

async function load () {
  try {
    const [cfg, authRes, cacheRes, providerRes, certRes] = await Promise.all([
      api.settings(), api.auth(), api.cacheStats(), api.providers(), api.cert()
    ])
    providers.value = providerRes.providers
    cert.value = certRes
    settings.value = cfg.settings
    setDisplayTimezone(settings.value.timezone)
    auth.value = authRes
    cache.value = cacheRes
  } catch (err) {
    notifyError(err)
  }
}

async function save () {
  saving.value = true
  try {
    settings.value = (await api.saveSettings(settings.value)).settings
    setDisplayTimezone(settings.value.timezone)
    notify('Settings saved')
  } catch (err) {
    notifyError(err)
  } finally {
    saving.value = false
  }
}

async function reloadAuth () {
  try {
    auth.value = await api.auth(true)
    notify('Re-read ~/.authinfo')
  } catch (err) {
    notifyError(err)
  }
}

// Vuetify hands back a File for a single-file input and an array when the
// component is configured for many; accept either so the card is not tied to it.
function pickFile (value) {
  return Array.isArray(value) ? value[0] : value
}

// v-file-input models File | File[] | null depending on how it is used, and an
// empty array is truthy — so the button state has to go through pickFile too.
const selectedCert = computed(() => pickFile(certFile.value))

async function uploadCert () {
  const file = selectedCert.value
  if (!file) return
  certBusy.value = true
  certTest.value = null
  try {
    cert.value = await api.uploadCert(await file.text())
    certFile.value = null
    notify('Certificate installed')
  } catch (err) {
    notifyError(err)
  } finally {
    certBusy.value = false
  }
}

async function removeCert () {
  certBusy.value = true
  certTest.value = null
  try {
    cert.value = await api.deleteCert()
    notify('Certificate removed')
  } catch (err) {
    notifyError(err)
  } finally {
    certBusy.value = false
  }
}

async function testCert () {
  certBusy.value = true
  certTest.value = null
  try {
    certTest.value = await api.testCert()
  } catch (err) {
    notifyError(err)
  } finally {
    certBusy.value = false
  }
}

/** Certificate subjects are long; the CN is the part worth reading at a glance. */
function commonName (subject) {
  return (subject.match(/CN=([^,]+)/) || [null, subject])[1]
}

async function clearCache () {
  try {
    const { removed } = await api.clearCache()
    cache.value = await api.cacheStats()
    notify(`Cleared ${removed} cache entries`)
  } catch (err) {
    notifyError(err)
  }
}

function formatBytes (bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

onMounted(load)
</script>

<template>
  <v-container fluid class="pa-4 pa-md-6" style="max-width: 1000px">
    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-tune" size="18" /> Release conventions
      </v-card-title>
      <v-divider />
      <v-card-text class="d-flex flex-column ga-4">
        <v-text-field
          v-model="settings.releaseBranchPrefix"
          label="Release branch prefix"
          hint="Branches starting with this are treated as releases. Default: release/"
          persistent-hint
          class="mono"
        />
        <v-text-field
          v-model="settings.issueKeyPattern"
          label="Issue key pattern"
          hint="Regular expression used to find ticket references in commit messages."
          persistent-hint
          class="mono"
        />
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-clock-outline" size="18" /> Dates and times
      </v-card-title>
      <v-divider />
      <v-card-text class="d-flex flex-column ga-4">
        <v-autocomplete
          :model-value="settings.timezone"
          :items="zoneItems"
          label="Display timezone"
          prepend-inner-icon="mdi-earth"
          hint="Commit dates, Jira release dates and tooltips are shown in this zone. Clear it to follow the browser."
          persistent-hint
          clearable
          @update:model-value="settings.timezone = $event || ''"
        />
        <div class="text-body-medium text-medium-emphasis">
          Right now that reads <strong class="mono">{{ nowPreview }}</strong>
        </div>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-jira" size="18" /> Jira
      </v-card-title>
      <v-divider />
      <v-card-text class="d-flex flex-column ga-4">
        <v-text-field
          v-model="settings.jiraBaseUrl"
          label="Jira base URL"
          placeholder="https://your-company.atlassian.net"
          hint="Used to resolve issue keys found in commit messages."
          persistent-hint
        />
        <v-text-field
          v-model="settings.jiraProjectKey"
          label="Default project key"
          placeholder="PROJ"
        />
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-clock-edit-outline" size="18" /> Time logger
      </v-card-title>
      <v-divider />
      <v-card-text class="d-flex flex-column ga-4">
        <v-text-field
          v-model="settings.timeLoggerSite"
          label="Jira site"
          placeholder="https://<yourcompanycustomized>.atlassian.net"
          hint="The Atlassian site whose worklogs the Time logger page reads and writes. Falls back to the Jira base URL above when blank."
          persistent-hint
        />
        <v-text-field
          v-model="settings.timeLoggerProject"
          label="Project key"
          placeholder="PROJ"
          hint="The project key scanned for your logged time. Falls back to the default project key above when blank."
          persistent-hint
        />
        <v-text-field
          v-model.number="settings.timeLoggerHoursPerDay"
          label="Hours per day"
          type="number"
          min="0"
          max="24"
          hint="Working day used for capacity and shortfall. 0 follows Jira's own time-tracking setting."
          persistent-hint
        />
        <v-text-field
          v-model="settings.timeLoggerDefaultLogTime"
          label="Default worklog time"
          placeholder="09:00"
          hint="Time of day stamped on a newly created worklog (24-hour HH:MM)."
          persistent-hint
        />
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-puzzle-outline" size="18" /> Providers
      </v-card-title>
      <v-divider />
      <v-card-text>
        <div class="text-body-medium text-medium-emphasis mb-3">
          Each provider is a plugin under <span class="mono">server/plugins/</span>. Adding one
          there makes it available here — nothing else needs changing.
        </div>
        <v-expansion-panels variant="accordion" class="border rounded-lg">
          <v-expansion-panel v-for="provider in providers" :key="provider.id">
            <v-expansion-panel-title>
              <div class="d-flex align-center ga-2 flex-wrap">
                <v-icon :icon="provider.icon" size="18" />
                <span class="font-weight-medium">{{ provider.name }}</span>
                <v-chip size="x-small" variant="tonal" class="mono">{{ provider.id }}</v-chip>
                <v-chip v-if="!provider.capabilities.cherryPick" size="x-small" variant="text"
                        class="text-medium-emphasis">no cherry-pick API</v-chip>
                <v-chip v-if="provider.credential.optional" size="x-small" variant="tonal" color="info">
                  token optional
                </v-chip>
              </div>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <div class="text-body-medium mb-2">
                URL format <span class="mono">{{ provider.urlExample }}</span>
              </div>
              <div class="text-body-medium mb-2">
                <span class="section-label">~/.authinfo line</span>
                <pre class="mono text-body-small mt-1 mb-0 pa-2 rounded" style="background: rgba(127,145,190,0.12); white-space: pre-wrap">machine &lt;host&gt; login &lt;{{ provider.credential.loginMeaning }}&gt; password &lt;{{ provider.credential.secretMeaning }}&gt;</pre>
              </div>
              <div class="text-body-medium">
                <span class="section-label">Scopes</span>
                <ul class="mt-1 ml-4">
                  <li v-for="scope in provider.credential.scopes" :key="scope">{{ scope }}</li>
                </ul>
              </div>
              <div class="d-flex ga-2 mt-3 flex-wrap">
                <v-chip v-for="(enabled, name) in provider.capabilities" :key="name" size="x-small"
                        variant="tonal" :color="enabled ? 'success' : undefined"
                        :prepend-icon="enabled ? 'mdi-check' : 'mdi-minus'">
                  {{ name }}
                </v-chip>
              </div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-shield-key-outline" size="18" /> Credentials
        <v-spacer />
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="reloadAuth">Re-read file</v-btn>
      </v-card-title>
      <v-divider />
      <v-card-text>
        <div class="text-body-medium text-medium-emphasis mb-3">
          Tokens are read from <span class="mono">{{ auth?.path }}</span> on the server and never sent to the browser.
        </div>

        <v-alert v-if="auth && !auth.found" type="warning" density="compact" class="mb-3">
          No <span class="mono">~/.authinfo</span> found. Create it with one line per host —
          see the Providers section above for what each expects.
        </v-alert>

        <v-table v-else-if="auth" density="compact">
          <thead>
            <tr><th class="text-left">Machine</th><th class="text-left">Login</th><th class="text-left">Secret</th></tr>
          </thead>
          <tbody>
            <tr v-for="(machine, index) in auth.machines" :key="index">
              <td class="mono text-body-medium">{{ machine.machine }}</td>
              <td class="text-body-medium">{{ machine.login || '—' }}</td>
              <td>
                <v-chip size="x-small" :color="machine.hasPassword ? 'success' : 'error'" variant="tonal">
                  {{ machine.hasPassword ? 'present' : 'missing' }}
                </v-chip>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-certificate-outline" size="18" /> Cert for corp network
        <v-spacer />
        <v-chip v-if="cert?.present" size="x-small" variant="tonal"
                :color="cert.installed ? 'success' : 'warning'">
          {{ cert.installed ? 'active' : 'stored, not loaded' }}
        </v-chip>
      </v-card-title>
      <v-divider />
      <v-card-text>
        <div class="text-body-medium text-medium-emphasis mb-3">
          Some office networks inspect HTTPS by re-signing it with their own root certificate.
          Browsers accept it because IT installed it on the machine, but this app carries its own
          list of trusted authorities and will refuse the connection with
          <span class="mono">SELF_SIGNED_CERT_IN_CHAIN</span>. Upload that root certificate here and
          it is trusted for outbound requests, alongside the usual public authorities.
        </div>

        <v-alert v-if="cert && !cert.canInstallAtRuntime" type="warning" density="compact" class="mb-3">
          {{ cert.manualHint }}
        </v-alert>

        <v-alert v-if="cert?.error" type="error" density="compact" class="mb-3">
          The stored file could not be read: {{ cert.error }}
        </v-alert>

        <div v-if="cert?.present">
          <v-table density="compact" class="mb-3">
            <thead>
              <tr>
                <th class="text-left">Certificate</th>
                <th class="text-left">Role</th>
                <th class="text-left">Expires</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in cert.certs" :key="entry.fingerprint">
                <td class="text-body-medium">
                  <div>{{ commonName(entry.subject) }}</div>
                  <div class="text-body-small text-medium-emphasis mono">{{ entry.subject }}</div>
                </td>
                <td>
                  <v-chip v-if="!entry.isCa" size="x-small" variant="tonal" color="warning"
                          title="Not a certificate authority, so it is stored but never trusted">
                    ignored
                  </v-chip>
                  <v-chip v-else size="x-small" variant="tonal">{{ entry.isRoot ? 'root' : 'intermediate' }}</v-chip>
                </td>
                <td>
                  <v-chip size="x-small" variant="tonal" :color="entry.expired ? 'error' : undefined">
                    {{ new Date(entry.validTo).toLocaleDateString() }}
                  </v-chip>
                </td>
              </tr>
            </tbody>
          </v-table>
          <div class="text-body-small text-medium-emphasis mb-3">
            Stored at <span class="mono">{{ cert.path }}</span>
          </div>
        </div>

        <v-file-input
          v-model="certFile"
          label="Root CA file"
          accept=".pem,.crt,.cer,.ca-bundle,.txt"
          prepend-icon=""
          prepend-inner-icon="mdi-paperclip"
          density="compact"
          hint="PEM / Base-64 text, starting with -----BEGIN CERTIFICATE-----. A bundle holding the whole chain is fine."
          persistent-hint
          :disabled="certBusy"
        />

        <div class="d-flex ga-2 mt-3 flex-wrap">
          <v-btn size="small" color="primary" prepend-icon="mdi-upload"
                 :disabled="!selectedCert || certBusy" :loading="certBusy" @click="uploadCert">
            Upload and trust
          </v-btn>
          <v-btn v-if="cert?.present" size="small" variant="text" prepend-icon="mdi-lan-connect"
                 :disabled="certBusy" @click="testCert">
            Test connection
          </v-btn>
          <v-spacer />
          <v-btn v-if="cert?.present" size="small" variant="text" color="error"
                 prepend-icon="mdi-delete-outline" :disabled="certBusy" @click="removeCert">
            Remove
          </v-btn>
        </div>

        <v-alert v-if="certTest" :type="certTest.ok ? 'success' : 'error'" density="compact" class="mt-3">
          <span v-if="certTest.ok">
            Reached {{ certTest.host }} — the certificate chain was accepted.
          </span>
          <span v-else>
            Could not reach {{ certTest.host }}:
            <span class="mono">{{ certTest.code || certTest.error }}</span>
          </span>
        </v-alert>

        <div class="text-body-small text-medium-emphasis mt-3">
          This trusts the certificate for this app only — nothing is added to the system store, and
          verification stays on, so an unexpected certificate is still rejected. Entries that are not
          themselves authorities are kept in the file but never trusted, so pasting a whole chain
          straight off the wire is safe.
        </div>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-database-outline" size="18" /> Cache
        <v-spacer />
        <v-btn size="small" variant="text" color="error" prepend-icon="mdi-delete-sweep-outline" @click="clearCache">
          Clear
        </v-btn>
      </v-card-title>
      <v-divider />
      <v-card-text class="text-body-medium">
        <div v-if="cache" class="d-flex ga-6 flex-wrap">
          <div><div class="section-label">Entries</div><div class="numeric">{{ cache.entries }}</div></div>
          <div><div class="section-label">Size</div><div class="numeric">{{ formatBytes(cache.bytes) }}</div></div>
          <div><div class="section-label">Oldest</div><div class="numeric">{{ cache.oldest ? new Date(cache.oldest).toLocaleString() : '—' }}</div></div>
        </div>
        <div class="text-medium-emphasis mt-3">
          Commit ranges are keyed by the two branch tip SHAs, so a cached range can never be stale —
          moving a branch produces a new key. Branch listings expire after two minutes.
        </div>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-title class="text-title-small d-flex align-center ga-2">
        <v-icon icon="mdi-alert-outline" size="18" /> Write access
      </v-card-title>
      <v-divider />
      <v-card-text>
        <v-switch
          v-model="settings.allowCherryPickWrites"
          color="warning"
          inset
          hide-details
          label="Allow cherry-pick writes to Azure DevOps"
        />
        <div class="text-body-medium text-medium-emphasis mt-2">
          When off, the cherry-pick page only shows you the commands to run yourself. When on, the
          console can ask Azure DevOps to apply selected commits — always onto a new topic branch
          first, and it can open the pull request from that branch into the target for you.
        </div>

        <v-divider class="my-4" />

        <v-switch
          v-model="settings.allowCherryPickAutoComplete"
          color="warning"
          inset
          hide-details
          :disabled="!settings.allowCherryPickWrites"
          label="Let the console complete the pull request"
        />
        <div class="text-body-medium text-medium-emphasis mt-2">
          Sets the cherry-pick pull request to auto-complete, so it merges into the target branch as
          soon as branch policies pass — <strong>immediately, if the branch has no policies</strong>.
          The commits still go through a pull request and a merge commit, so there is a record and it
          can be reverted, but nobody reviews it first. Leave this off if the target branch is one
          other people work on.
        </div>
      </v-card-text>
    </v-card>

    <div class="d-flex justify-end">
      <v-btn color="primary" size="large" :loading="saving" prepend-icon="mdi-content-save-outline" @click="save">
        Save settings
      </v-btn>
    </div>
  </v-container>
</template>
