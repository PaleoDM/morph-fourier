import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Cross-stage UI state: which series is currently active. Every stage operates
 * on this key. Persisted to localStorage so a reload keeps the user's place
 * (ROADMAP Phase 2 success criterion). This is the ONLY source of truth for the
 * active series — components read it, SeriesSelector writes it.
 */
interface ActiveSeriesState {
  activeSeriesKey: string | null
  setActiveSeriesKey: (key: string | null) => void
}

export const useActiveSeriesStore = create<ActiveSeriesState>()(
  persist(
    (set) => ({
      activeSeriesKey: null,
      setActiveSeriesKey: (key) => set({ activeSeriesKey: key }),
    }),
    {
      name: "morph-fourier.activeSeries",
    },
  ),
)
