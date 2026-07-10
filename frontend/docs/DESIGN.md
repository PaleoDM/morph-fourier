# Morph-Fourier — Design System

The single source of truth for how the app looks. Every colour, radius, and
spacing decision routes through the tokens defined in
[`src/index.css`](../src/index.css). **Components never use raw hex values** —
they use Tailwind utilities that resolve to these tokens (`bg-primary`,
`text-muted-foreground`, `border-border`, `rounded-md`, …). This keeps light and
dark coherent and makes a future rebrand a one-file change.

Built on **shadcn/ui (new-york style) + Tailwind CSS v4**. Tailwind v4 has no
`tailwind.config.js`; the theme is declared in CSS via `@theme inline` and the
`@tailwindcss/vite` plugin.

---

## How theming works

- Colours are authored as CSS custom properties on `:root` (light) and `.dark`
  (dark) in `index.css`.
- `@theme inline { --color-*: var(--*) }` maps each property into Tailwind's
  colour namespace, so `bg-primary` etc. exist as utilities. Because the mapping
  is `inline` (references the variables rather than copying values), the `.dark`
  overrides flow through automatically — no duplicate utility definitions.
- The active theme is the presence/absence of the `.dark` class on `<html>`,
  toggled by [`useThemeStore`](../src/state/useThemeStore.ts). Default follows
  `prefers-color-scheme`; the user's choice is persisted to localStorage and
  applied before first paint (in `main.tsx`) to avoid a flash.

## Colour space

All colours are **oklch** (`oklch(L C H)` — lightness, chroma, hue). oklch is
perceptually uniform, so equal lightness steps look equal, and adjusting one
channel (e.g. brightening the accent for dark mode) doesn't skew the hue.

---

## Token reference

### Surfaces & text

| Token | Utility | Intent |
|---|---|---|
| `--background` / `--foreground` | `bg-background` / `text-foreground` | Page base surface and default text. |
| `--card` / `--card-foreground` | `bg-card` / `text-card-foreground` | Raised panels (rail, cards). Equals background in light, lifts in dark. |
| `--popover` / `--popover-foreground` | `bg-popover` … | Floating surfaces (Select menu, future dropdowns/tooltips). |
| `--muted` / `--muted-foreground` | `bg-muted` / `text-muted-foreground` | Low-emphasis surfaces and secondary text (labels, hints, inactive nav). |
| `--secondary` / `--secondary-foreground` | `bg-secondary` … | Neutral secondary buttons/fills. |
| `--border` | `border-border` | Hairlines, dividers, input outlines. Semi-transparent white in dark. |
| `--input` | `border-input` | Form control borders specifically. |
| `--ring` | `ring-ring` | Focus ring — the teal accent, for a visible, on-brand focus state. |

### Brand accent

| Token | Utility | Intent |
|---|---|---|
| `--primary` / `--primary-foreground` | `bg-primary` / `text-primary-foreground` | **The one accent: teal.** Primary buttons, active-stage marker, brand mark. Brighter in dark so it lifts off the near-black background. |
| `--accent` / `--accent-foreground` | `bg-accent` / `text-accent-foreground` | Subtle teal-**tinted** surface for hover / active-nav states. A restrained brand whisper, not a second accent colour. |

> **Accent choice.** A single restrained **teal** (`oklch(0.62 0.108 184)` light,
> `oklch(0.70 0.122 183)` dark). Professional, distinct from the semantic
> red/green/amber, and easy for Carlos to rebrand later by editing `--primary`,
> `--accent`, and `--ring`.

### Semantic status

These mirror the curation statuses in `domain.ts` (`CurationState`) so the same
meaning always reads as the same colour across the app.

| Token | Utility | Meaning | Maps to status |
|---|---|---|---|
| `--success` / `--success-foreground` | `bg-success` / `text-success-foreground` | Green — good/complete | `accepted` |
| `--warning` / `--warning-foreground` | `bg-warning` / `text-warning-foreground` | Amber — needs attention | `unreviewed` |
| `--destructive` / `--destructive-foreground` | `bg-destructive` … | Red — removed/failed | `rejected` |

Exposed as `Badge` variants (`success` / `warning` / `destructive`) and, for red,
the `Button` `destructive` variant.

### Radius

Driven by a single `--radius: 0.625rem`. Tailwind's `rounded-{sm,md,lg,xl}`
resolve to `--radius` ± a step, so the whole UI scales its corner rounding from
one number.

| Utility | Value |
|---|---|
| `rounded-sm` | `--radius - 4px` |
| `rounded-md` | `--radius - 2px` |
| `rounded-lg` | `--radius` |
| `rounded-xl` | `--radius + 4px` |

### Spacing rhythm

Tailwind's default **4px rhythm** (`p-2` = 8px, `p-4` = 16px, `gap-2` = 8px …).
The shell uses a consistent vocabulary: `p-3` for the rail, `p-8` for main
content, `gap-2` for header clusters, `h-14` (56px) header, `w-[220px]` rail —
matching the ROADMAP §5 layout spec.

---

## Rules for contributors

1. **No raw hex / rgb in components.** If you need a colour, it's a token. If the
   token doesn't exist, add it here and to `index.css` first.
2. **Both themes are first-class.** Any new token must be defined in *both*
   `:root` and `.dark`, and eyeballed in both.
3. **Status = semantic token.** Never hardcode green/amber/red; use
   `success` / `warning` / `destructive` so meaning stays consistent.
4. **shadcn/ui only** for component primitives (see `CLAUDE.md`). Compose from
   Tailwind + tokens when shadcn lacks a part.
