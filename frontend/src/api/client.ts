// Typed fetch wrapper over the OpenAPI-generated client (`types/api.gen.ts`).
//
// This is the real backend seam that replaced the Phase-2A mock. Every server
// call in the app goes through the TanStack Query hooks in `hooks.ts`, which in
// turn call the typed resource functions at the bottom of this file. Components
// never touch `fetch` directly (see CLAUDE.md).
//
// Base path is `/api`; in dev the Vite proxy forwards `/api` + `/photos` to the
// backend on :8000, and in prod the frontend is served same-origin, so a bare
// `/api/...` path is correct in both modes.

import type { components } from "@/types/api.gen"
import type { StageId, StageStatus } from "@/types/domain"

/** Convenience alias for the generated schema table — the single API contract. */
export type Schemas = components["schemas"]

const API_BASE = "/api"

/** A non-2xx (or transport-level) API failure. Carries the status for callers. */
export class ApiError extends Error {
  readonly status: number
  readonly path: string

  constructor(status: number, path: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.path = path
  }
}

/** Pull a human-readable message out of FastAPI's `{ detail }` error body. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === "string") return body.detail
    if (body.detail != null) return JSON.stringify(body.detail)
  } catch {
    // non-JSON body (e.g. a proxy 500 when the backend is down) — fall through
  }
  return res.statusText || "Request failed"
}

/** Fetch options, but with a JSON-serialisable `body` instead of a raw `BodyInit`. */
type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown }

async function request<T>(path: string, init?: JsonRequestInit): Promise<T> {
  const { body, headers, ...rest } = init ?? {}
  const hasBody = body !== undefined
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    throw new ApiError(res.status, path, await errorMessage(res))
  }
  // 204 / empty bodies aren't expected on the GETs wired in this phase, but be safe.
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * POST multipart/form-data (file uploads). The browser sets the multipart
 * boundary, so we must NOT set Content-Type ourselves — hence a dedicated path
 * rather than the JSON `request()` above.
 */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  })
  if (!res.ok) {
    throw new ApiError(res.status, path, await errorMessage(res))
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Low-level typed verbs. Prefer the resource functions below in the hooks. */
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
}

/* ─── Resource functions (return types come straight from api.gen.ts) ─────── */

/** GET /api/series — every series discovered under the photos root. */
export function getSeriesList(): Promise<Schemas["Series"][]> {
  return api.get<Schemas["Series"][]>("/series")
}

/**
 * GET /api/{series}/status — all eight stage statuses in one call.
 *
 * The backend returns `dict[str, StageStatus]`, generated as an index signature
 * (`{ [key: string]: StageStatus }`). The keys are exactly the eight StageIds
 * (see backend `deps.STAGE_IDS`), so we narrow to `Record<StageId, StageStatus>`
 * for the callers — this is the cast 1B flagged.
 */
export async function getSeriesStatus(
  seriesKey: string,
): Promise<Record<StageId, StageStatus>> {
  const all = await api.get<Record<string, StageStatus>>(
    `/${encodeURIComponent(seriesKey)}/status`,
  )
  return all as Record<StageId, StageStatus>
}
