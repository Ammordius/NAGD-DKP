import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { usePersistedState } from './usePersistedState'
import {
  AMBIANCE_PAGE_STATE_KEY,
  AMBIANCE_PREFS_DEFAULTS,
  THEMES,
  THEME_IDS,
  applyThemeCssVars,
  clearThemeCssVars,
  normalizeAmbiancePrefs,
  resolveActiveTheme,
} from './themeRegistry'

const AmbianceContext = createContext(null)

function useAmbianceThemeState() {
  const [prefs, setPrefs] = usePersistedState(
    AMBIANCE_PAGE_STATE_KEY,
    AMBIANCE_PREFS_DEFAULTS,
    normalizeAmbiancePrefs,
  )

  const theme = resolveActiveTheme(prefs)

  useEffect(() => {
    applyThemeCssVars(theme)
    return () => {
      clearThemeCssVars()
    }
  }, [theme])

  const setAmbianceEnabled = useCallback((enabled) => {
    setPrefs((prev) => ({
      ...normalizeAmbiancePrefs(prev),
      ambianceEnabled: enabled === true,
    }))
  }, [setPrefs])

  const setSelectedTheme = useCallback((id) => {
    setPrefs((prev) => ({
      ...normalizeAmbiancePrefs(prev),
      selectedTheme: typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEMES, id)
        ? id
        : AMBIANCE_PREFS_DEFAULTS.selectedTheme,
    }))
  }, [setPrefs])

  return useMemo(() => ({
    ambianceEnabled: prefs.ambianceEnabled === true,
    selectedTheme: prefs.selectedTheme,
    theme,
    themes: THEMES,
    themeIds: THEME_IDS,
    setAmbianceEnabled,
    setSelectedTheme,
  }), [prefs.ambianceEnabled, prefs.selectedTheme, theme, setAmbianceEnabled, setSelectedTheme])
}

/** Applies persisted ambiance CSS variables and shares prefs with useAmbianceTheme. Must sit under PageStateUserProvider. */
export function AmbianceRoot({ children }) {
  const value = useAmbianceThemeState()
  return (
    <AmbianceContext.Provider value={value}>
      {children}
    </AmbianceContext.Provider>
  )
}

/**
 * Persisted ambiance prefs for the signed-in user (from AmbianceRoot).
 * @returns {{
 *   ambianceEnabled: boolean,
 *   selectedTheme: string,
 *   theme: object,
 *   themes: typeof THEMES,
 *   themeIds: string[],
 *   setAmbianceEnabled: (enabled: boolean) => void,
 *   setSelectedTheme: (id: string) => void,
 * }}
 */
export function useAmbianceTheme() {
  const ctx = useContext(AmbianceContext)
  if (!ctx) {
    throw new Error('useAmbianceTheme must be used within AmbianceRoot')
  }
  return ctx
}
