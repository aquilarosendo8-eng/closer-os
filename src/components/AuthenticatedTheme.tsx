import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'

type Theme = 'light' | 'dark'
const storageKey = 'closer-os-theme-v1'
const mediaQuery = '(prefers-color-scheme: dark)'
const ThemeContext = createContext<{ theme: Theme; chooseTheme: (theme: Theme) => void } | null>(null)

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(storageKey)
    return value === 'light' || value === 'dark' ? value : null
  } catch { return null }
}

function systemTheme(): Theme {
  return window.matchMedia(mediaQuery).matches ? 'dark' : 'light'
}

/** Visual preferences only: deliberately scoped to the authenticated shell. */
export function AuthenticatedTheme({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme | null>(storedTheme)
  const [system, setSystem] = useState<Theme>(systemTheme)
  const theme = preference || system

  useEffect(() => {
    const media = window.matchMedia(mediaQuery)
    const updateSystem = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', updateSystem)
    const syncPreference = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setPreference(storedTheme())
    }
    window.addEventListener('storage', syncPreference)
    return () => {
      media.removeEventListener('change', updateSystem)
      window.removeEventListener('storage', syncPreference)
    }
  }, [])

  const chooseTheme = (next: Theme) => {
    setPreference(next)
    try { window.localStorage.setItem(storageKey, next) } catch { /* Preference remains usable for this visit. */ }
  }

  return <ThemeContext.Provider value={{ theme, chooseTheme }}><div className="crm-visual" data-theme={theme}>{children}</div></ThemeContext.Provider>
}

export function ThemeSelector() {
  const context = useContext(ThemeContext)
  if (!context) return null
  const Icon = context.theme === 'dark' ? Moon : Sun
  return <label className="crm-theme-selector"><Icon size={15} aria-hidden="true"/><select aria-label="Tema da interface" value={context.theme} onChange={event => context.chooseTheme(event.target.value as Theme)}><option value="light">Tema Claro</option><option value="dark">Tema Escuro</option></select></label>
}
