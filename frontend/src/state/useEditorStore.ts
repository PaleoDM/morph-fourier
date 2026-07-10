// useEditorStore — the anchor-editing working copy + undo/redo (ROADMAP §Phase 6
// step 3). One editor session at a time (the selected canonical). The store holds
// the live anchor array the pen-tool edits; the server is touched only on Save
// and on an explicit SAM run, never per drag. `samProposal` is the last SAM
// output, so "Reset to SAM" restores it instantly without a round-trip.
//
// History model: one snapshot per gesture. A gesture (a drag, an add, a remove, a
// SAM re-run, a reset) calls `beginEdit()` once to snapshot the pre-edit anchors,
// then mutates freely via `setAnchors`. Undo/redo walk the `past` / `future`
// stacks. Cmd-Z / Cmd-Shift-Z are wired in the AnchorEditor.

import { create } from "zustand"

import type { Pt } from "@/konva/catmullRom"

const HISTORY_LIMIT = 200

const clone = (a: Pt[]): Pt[] => a.map((p) => ({ x: p.x, y: p.y }))

interface EditorState {
  /** The record this session is editing, or null when no editor is open. */
  recordKey: string | null
  /** The live working anchors (served-image pixel coords). */
  anchors: Pt[]
  /** Last SAM proposal for this session — the target of "Reset to SAM". */
  samProposal: Pt[] | null
  past: Pt[][]
  future: Pt[][]

  /** Hard-reset the session for a new record. Clears history. */
  loadSession: (recordKey: string, anchors: Pt[], samProposal: Pt[] | null) => void
  /** Tear down when the editor closes. */
  clearSession: () => void

  /** Snapshot the current anchors — call ONCE at the start of a mutating gesture. */
  beginEdit: () => void
  /** Replace the anchors without touching history (the live drag step / add / remove). */
  setAnchors: (anchors: Pt[]) => void

  /** Apply a fresh SAM proposal (undoable) and remember it as the reset target. */
  applyProposal: (anchors: Pt[]) => void
  /** Restore the remembered SAM proposal (undoable). No-op if none. */
  resetToProposal: () => void

  undo: () => void
  redo: () => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  recordKey: null,
  anchors: [],
  samProposal: null,
  past: [],
  future: [],

  loadSession: (recordKey, anchors, samProposal) =>
    set({
      recordKey,
      anchors: clone(anchors),
      samProposal: samProposal ? clone(samProposal) : null,
      past: [],
      future: [],
    }),

  clearSession: () =>
    set({ recordKey: null, anchors: [], samProposal: null, past: [], future: [] }),

  beginEdit: () => {
    const { anchors, past } = get()
    const next = [...past, clone(anchors)]
    if (next.length > HISTORY_LIMIT) next.shift()
    set({ past: next, future: [] })
  },

  setAnchors: (anchors) => set({ anchors }),

  applyProposal: (anchors) => {
    get().beginEdit()
    set({ anchors: clone(anchors), samProposal: clone(anchors) })
  },

  resetToProposal: () => {
    const { samProposal } = get()
    if (!samProposal) return
    get().beginEdit()
    set({ anchors: clone(samProposal) })
  },

  undo: () => {
    const { past, future, anchors } = get()
    if (past.length === 0) return
    const prev = past[past.length - 1]
    set({
      anchors: prev,
      past: past.slice(0, -1),
      future: [clone(anchors), ...future],
    })
  },

  redo: () => {
    const { past, future, anchors } = get()
    if (future.length === 0) return
    const next = future[0]
    set({
      anchors: next,
      past: [...past, clone(anchors)],
      future: future.slice(1),
    })
  },
}))
