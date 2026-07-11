# AGENTS.md

Orientation for coding agents (and humans) modifying Morph-Fourier. Read this before making changes.

## What this is

A local-first web app for 2D outline shape analysis: **Curation → Prime → Automate → Review → Gallery → EFA → PCA → Morphospace**. A React frontend talks to a FastAPI backend; both run on the user's machine and are launched together. It is **series-agnostic** — nothing is hardcoded to a particular dataset or domain.

## Repository layout

```
backend/            FastAPI app + analysis
  src/app/
    main.py         app, static mount, photo serving
    api/            one router module per resource (registered in api/__init__.py)
    models.py       Pydantic models — mirror of frontend/src/types/domain.ts
    state.py        per-series JSON state I/O; photos_root(); discover_series()
    filenames.py    series safe_key() + the Genus_species_catalog_index parser
    analysis.py     EFA / PCA (pyefd + scikit-learn)
    processing.py   segmentation + contour extraction (SAM)
  tests/            pytest
frontend/           React 19 + Vite + Tailwind + shadcn/ui
  src/
    types/domain.ts     TypeScript SSOT for domain types
    types/api.gen.ts     generated from the backend's OpenAPI schema
    api/                 typed client (client.ts) + TanStack Query hooks
    stages/              one folder per pipeline stage
    components/          shared UI (shadcn-based)
    state/               Zustand stores (cross-stage UI state)
photos/             user photo series (git-ignored; ships only the tutorial set)
setup.command / run-prod.command / *.ps1 / *.bat   install + launch, per OS
```

## Running

```
./setup.command                     # one-time: venv, deps, SAM weights, build frontend (macOS; setup.bat on Windows)
./run-dev.command                   # dev: Vite :5173 + FastAPI :8000 with hot reload
./run-prod.command                  # serve the built bundle on :8000
cd backend && ./.venv/bin/python -m pytest -q     # backend tests
cd frontend && npm run build && npm run lint      # frontend build + oxlint
```

## Non-negotiable conventions

- **Types first, mirrored three ways.** New data means: a TypeScript interface in `frontend/src/types/domain.ts`, a parallel Pydantic model in `backend/src/app/models.py`, and then regenerate the client types. Keep them in sync.
- **Regenerate `api.gen.ts` after backend model/route changes:** start the backend, then `cd frontend && npm run gen:api` (openapi-typescript against `http://localhost:8000/openapi.json`).
- **JSON is camelCase everywhere**, wire and disk. Pydantic models use `alias_generator=to_camel` + `populate_by_name=True` and serialize `by_alias=True`, matching `domain.ts` verbatim.
- **All endpoints under `/api/*`**, one `APIRouter` per resource, registered in `backend/src/app/api/__init__.py`. Everything else is served by the static bundle.
- **State is JSON files, not a database** — per series under `backend/state/{seriesKey}/`, derived artifacts (outlines, EFA/PCA CSVs, exports) alongside. Do **not** change an on-disk JSON shape without a migration/back-compat path for existing state.
- **Frontend server calls go through TanStack Query hooks** in `frontend/src/api/` — never raw `fetch`/`axios` in components. Multipart uploads use `postForm` in `client.ts`.
- **UI is shadcn/ui + Tailwind only.** No other component library; compose from Tailwind primitives when shadcn lacks something. Colors come from design tokens, not inline hex.
- **Series-agnostic.** No dataset-, taxon-, or institution-specific strings outside test fixtures. A series is any immediate subfolder of the photos root; its key is `safe_key(folderName)` (lowercase, non-alphanumeric runs → `_`).
- **Direct-manipulation editors use react-konva** (crop bbox, rotation puck, anchor path). Undo/redo is a stack of prior states.

## How the data flows

- The photos root is `MORPH_FOURIER_PHOTOS_ROOT` or, by default, `./photos`. Each subfolder is a series (`state.discover_series()`).
- Filenames parse as `Genus[_species]_catalog_index.ext`; non-matching files are surfaced as *unparseable*, not dropped. Multiple photos can share a specimen (grouped by catalog) — this is why the canonical-selection step in Curation exists.
- Stages 1→4 gate on locks; Gallery (5) is optional export; analysis stages (6–8) are free exploration and recompute from `efa/coefficients.csv`.

## Gotchas

- `python -m uvicorn`, not the bare `uvicorn` console script — the launcher must survive the folder being moved after setup (venv console-script shebangs hardcode their path).
- EFA/PCA reference math is intentionally thin wrappers over `pyefd`/`scikit-learn`; the one deliberate departure is **orientation-preserving normalization** (`analysis.compute_efa_oriented`), which keeps the user's Orient step instead of using pyefd's full normalization.
- SAM inference is synchronous and slow without a GPU; it lazily loads weights and returns 503 if they're absent.
- The morphospace bundle is large (Plotly) and is code-split/lazy-loaded — keep it that way.

## Before you finish

Run the backend tests and the frontend build+lint. For a change with a runtime surface, actually drive the affected flow (or add/extend a test) rather than trusting a green typecheck.
