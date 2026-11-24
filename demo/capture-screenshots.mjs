/**
 * Regenerate docs/screenshots/ from the demo server.
 *
 * Playwright is deliberately not a package dependency. Install it when you
 * need to refresh the screenshots:
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   node demo/capture-screenshots.mjs
 *
 * BASE=http://127.0.0.1:1234 reuses an already-running demo instead of starting
 * one. THEME=dark and OUT_DIR=... are also supported.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.OUT_DIR || join(here, '..', 'docs', 'screenshots')
const THEME = process.env.THEME || 'light'
const WIDTH = 1440
const HEIGHT = 1000
mkdirSync(OUT, { recursive: true })

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  try {
    ({ chromium } = await import('playwright-core'))
  } catch {
    console.error('This script needs Playwright:\n' +
      '  npm install --no-save playwright && npx playwright install chromium')
    process.exit(1)
  }
}

let server
let BASE = process.env.BASE
if (!BASE) {
  const { start } = await import('../server/index.mjs')
  const started = await start({ demo: true, port: 0 })
  server = started.server
  BASE = started.url
}


async function settle (page, ms = 400) {
  await page.mouse.move(2, 2)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)
}
async function shot (page, name) {
  await settle(page, 450)
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' })
  console.log('shot', name)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1.5,
  colorScheme: THEME === 'dark' ? 'dark' : 'light',
  locale: 'en-AU',
  timezoneId: 'Australia/Sydney'
})
await context.addInitScript(({ theme }) => {
  localStorage.setItem('hermit:theme', theme)
  localStorage.setItem('hermit:releases.selection', JSON.stringify({ base: '2.3.0', target: '2.4.0' }))
  localStorage.setItem('hermit:releaseRepositories.selection', JSON.stringify({
    version: '2.4.0',
    repoIds: ['repo-api', 'repo-web', 'repo-workers', 'repo-mobile', 'repo-infra']
  }))
  localStorage.setItem('hermit:cherryPick.selection', JSON.stringify({
    repoId: 'repo-api', left: 'release/2.3.0', right: 'release/2.4.0'
  }))
  localStorage.setItem('hermit:jiraReleases.selected', JSON.stringify('jr-2.4.0'))
  localStorage.setItem('hermit:timeLoggerSort', JSON.stringify('desc'))
}, { theme: THEME })

const page = await context.newPage()
page.on('console', msg => { if (msg.type() === 'error') console.log('console:', msg.text()) })
page.on('pageerror', err => console.log('pageerror:', err.message))

// 1. coverage
await page.goto(`${BASE}/releases`, { waitUntil: 'networkidle' })
await page.getByText('Release branch coverage').waitFor()
await page.getByText('Demo data').first().waitFor()
await shot(page, 'release-compare-coverage')

// 2. comparison + cross-check
await page.getByRole('button', { name: 'Compare' }).click()
await page.getByText('Jira cross-check').waitFor()
await page.locator('.v-field').filter({ hasText: 'Pinned Jira release' }).first().click()
await page.locator('.v-overlay-container .v-list-item').filter({ hasText: 'Aurora 2.4.0 (Next Release)' }).first().click()
await page.getByText('In Jira release, no commit found (3)').waitFor()
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
await page.evaluate(() => window.scrollTo(0, 0))
await shot(page, 'release-compare-results')

const crossCard = page.locator('.v-card').filter({ hasText: 'Jira cross-check' }).first()
await crossCard.scrollIntoViewIfNeeded()
await settle(page)
await crossCard.screenshot({ path: `${OUT}/jira-cross-check.png`, animations: 'disabled' })
console.log('shot jira-cross-check')

// 3. release repositories
await page.goto(`${BASE}/release-repositories`, { waitUntil: 'networkidle' })
await page.getByText('Repositories with release/2.4.0').waitFor()
await shot(page, 'release-repositories')

// 4. pull requests
await page.goto(`${BASE}/pull-requests`, { waitUntil: 'networkidle' })
await page.getByText('Open pull requests').first().waitFor()
await page.getByText('awaiting your review').waitFor()
await shot(page, 'pull-requests')

// 5. jira releases
await page.goto(`${BASE}/jira-releases`, { waitUntil: 'networkidle' })
await page.getByText('Aurora 2.4.0 (Next Release)').first().waitFor()
await page.getByText('AUR-401').first().waitFor()
await shot(page, 'jira-releases')

// 6. repositories + add dialog
await page.goto(`${BASE}/repositories`, { waitUntil: 'networkidle' })
await page.getByText('aurora-api').first().waitFor()
await shot(page, 'repositories')

await page.getByRole('button', { name: 'Add repository' }).click()
const repoDialog = page.locator('.v-dialog').filter({ hasText: 'Add repository' })
await repoDialog.getByLabel('Repository URL').fill('https://dev.azure.com/Contoso/Aurora/_git/aurora-api/branches')
await repoDialog.getByRole('button', { name: 'Test connection' }).click()
await repoDialog.getByText('found').waitFor()
await shot(page, 'repositories-add')

// 7. cherry-pick
await page.goto(`${BASE}/cherry-pick`, { waitUntil: 'networkidle' })
const compareBtn = page.getByRole('button', { name: 'Compare' })
await compareBtn.waitFor()
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Compare')
  return b && !b.disabled
})
await compareBtn.click()
await page.getByText('4 commits not on the other side').waitFor()
const rightCard = page.locator('.v-card')
  .filter({ hasText: 'release/2.4.0' })
  .filter({ hasText: 'commits not on the other side' })
  .first()
const boxes = rightCard.locator('.v-checkbox-btn')
await boxes.nth(0).click()
await boxes.nth(1).click()
await rightCard.getByRole('button', { name: /Apply to left/ }).waitFor()
await page.evaluate(() => window.scrollTo(0, 0))
await shot(page, 'cherry-pick')

await rightCard.getByRole('button', { name: /Apply to left/ }).click()
const applyDialog = page.locator('.v-dialog').filter({ hasText: 'Apply 2 commit(s)' })
await applyDialog.getByText('How far to take it').waitFor()
await applyDialog.getByLabel('New topic branch').fill('cherry-pick/backport-AUR-412-418')
const dialogHeight = await applyDialog.evaluate(el => Math.ceil(el.getBoundingClientRect().height))
await page.setViewportSize({ width: WIDTH, height: Math.max(HEIGHT, dialogHeight + 120) })
await page.waitForTimeout(300)
await shot(page, 'cherry-pick-dialog')
await page.setViewportSize({ width: WIDTH, height: HEIGHT })

// 8. time logger with a Monday-Friday range (the weekend cards are real but
//    empty; the screenshot reads better without them)
await page.goto(`${BASE}/time-logger`, { waitUntil: 'networkidle' })
await page.getByText('Jira time log').waitFor()
const week = await page.evaluate(() => {
  const today = new Date()
  const dow = (today.getDay() + 6) % 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - dow - 7)
  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)
  const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
  return { from: fmt(monday), to: fmt(friday), label: `Fri ${String(friday.getDate()).padStart(2, '0')} ${friday.toLocaleString('en-GB', { month: 'short' })} ${friday.getFullYear()}` }
})
const rangeInput = page.getByLabel('Date range')
await rangeInput.fill(`${week.from} - ${week.to}`)
await rangeInput.press('Enter')
await page.keyboard.press('Escape')
await page.getByRole('button', { name: 'Retrieve' }).click()
await page.getByText(week.label, { exact: true }).waitFor()
await page.locator('.entry-row').filter({ hasText: 'AUR-412' }).first().click()
await page.getByText('Wrote the upgrade notes and captured the release screenshots.').waitFor()
await page.evaluate(() => window.scrollTo(0, 0))
await shot(page, 'time-logger')

// 9. typo guard
const addTicket = page.getByLabel('Add ticket').first()
await addTicket.fill('AUR-4213')
await addTicket.press('Tab')
await page.getByText('Double-check this ticket').waitFor()
await shot(page, 'time-logger-typo')

// 10. settings
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await page.getByText('Release conventions').waitFor()
await shot(page, 'settings')

const providersCard = page.locator('.v-card').filter({ hasText: 'Providers' }).first()
await providersCard.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80))
await page.mouse.move(2, 2)
await page.waitForTimeout(350)
await page.screenshot({ path: `${OUT}/settings-credentials.png`, animations: 'disabled' })
console.log('shot settings-credentials')

const certCard = page.locator('.v-card').filter({ hasText: 'Cert for corp network' }).first()
await certCard.scrollIntoViewIfNeeded()
await certCard.screenshot({ path: `${OUT}/settings-certificate.png`, animations: 'disabled' })
console.log('shot settings-certificate')

await browser.close()
if (server) await new Promise(resolve => server.close(resolve))
