import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/releases' },
  {
    path: '/releases',
    name: 'releases',
    component: () => import('./pages/ReleasesPage.vue'),
    meta: { title: 'Release compare', icon: 'mdi-rocket-launch-outline', nav: true }
  },
  {
    path: '/cherry-pick',
    name: 'cherry-pick',
    component: () => import('./pages/CherryPickPage.vue'),
    meta: { title: 'Cherry-pick', icon: 'mdi-source-branch-sync', nav: true }
  },
  {
    path: '/jira-releases',
    name: 'jira-releases',
    component: () => import('./pages/JiraReleasesPage.vue'),
    meta: { title: 'Jira releases', icon: 'mdi-clipboard-list-outline', nav: true }
  },
  {
    path: '/time-logger',
    name: 'time-logger',
    component: () => import('./pages/TimeLoggerPage.vue'),
    meta: { title: 'Time logger', icon: 'mdi-clock-edit-outline', nav: true }
  },
  {
    path: '/repositories',
    name: 'repositories',
    component: () => import('./pages/RepositoriesPage.vue'),
    meta: { title: 'Repositories', icon: 'mdi-source-repository-multiple', nav: true }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./pages/SettingsPage.vue'),
    meta: { title: 'Settings', icon: 'mdi-cog-outline', nav: true }
  }
]

export const navRoutes = routes.filter(r => r.meta?.nav)

export default createRouter({
  history: createWebHistory(),
  routes
})
