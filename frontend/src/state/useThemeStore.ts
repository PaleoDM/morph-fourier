import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Light/dark theme, persisted. Both themes are first-class (design tokens in
 * index.css define a full palette for each). The active theme is applied by
 * toggling the `.dark` class on <html> — see applyTheme() below, called once at
 * startup and on every change.
 */
export type Theme = "light" | "dark"

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )
}

/** Reflect the chosen theme onto the document root so the token overrides kick in. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle("dark", theme === "dark")
  root.style.colorScheme = theme
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: systemPrefersDark() ? "dark" : "light",
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
      toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
    }),
    {
      name: "morph-fourier.theme",
      onRehydrateStorage: () => (state) => {
        // Apply the persisted theme as soon as the store hydrates from storage.
        if (state) applyTheme(state.theme)
      },
    },
  ),
)
