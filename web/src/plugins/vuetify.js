import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi'

// A restrained, high-contrast palette: near-black surfaces, one indigo accent
// for actions and semantic colours reserved for state (ahead/behind, errors).
const dark = {
  dark: true,
  colors: {
    background: '#0B0E14',
    surface: '#11151E',
    'surface-bright': '#1A2030',
    'surface-light': '#161B27',
    'surface-variant': '#2A3244',
    'on-surface-variant': '#AEB8CC',
    primary: '#6E8BFF',
    secondary: '#8B93A7',
    success: '#3FD68C',
    warning: '#F5B544',
    error: '#FF6B7A',
    info: '#59B8FF'
  },
  variables: {
    'border-color': '#FFFFFF',
    'border-opacity': 0.10,
    'theme-on-code': '#D7E0F5'
  }
}

const light = {
  dark: false,
  colors: {
    background: '#F6F7FB',
    surface: '#FFFFFF',
    'surface-bright': '#FFFFFF',
    'surface-light': '#EEF1F8',
    'surface-variant': '#DDE3EF',
    'on-surface-variant': '#4A5468',
    primary: '#3B5BDB',
    secondary: '#5C6580',
    success: '#0F9D58',
    warning: '#B87503',
    error: '#D6323F',
    info: '#1273C4'
  }
}

const themes = { dark, light }

export const THEME_STORAGE_KEY = 'hermit:theme'

/**
 * The choice is read before createVuetify runs, so the stored theme is the one
 * used for the first render — switching it afterwards would flash the default.
 * Storage can throw outright (Safari private mode, site data blocked), so every
 * access is guarded and simply falls back to the default theme.
 */
function storedTheme () {
  try {
    const name = localStorage.getItem(THEME_STORAGE_KEY)
    return name && name in themes ? name : null
  } catch {
    return null
  }
}

export function rememberTheme (name) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, name)
  } catch {
    // Not being able to persist the choice is not worth interrupting the user.
  }
}

export default createVuetify({
  theme: {
    defaultTheme: storedTheme() ?? 'dark',
    themes
  },
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  defaults: {
    global: { density: 'comfortable' },
    VCard: { rounded: 'lg', border: true, flat: true },
    VBtn: { rounded: 'md', variant: 'flat' },
    VTextField: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
    VSelect: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
    VAutocomplete: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
    VTextarea: { variant: 'outlined', density: 'compact', hideDetails: 'auto' },
    VChip: { rounded: 'sm' },
    VAlert: { rounded: 'lg', variant: 'tonal' },
    VList: { density: 'compact' }
  }
})
