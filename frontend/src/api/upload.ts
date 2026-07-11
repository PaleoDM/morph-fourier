// Create-series + add-photos mutations (multipart uploads).
//
// Backs the in-app upload flow that replaces "go drop a folder into photos/".
// Both hooks POST multipart form data via `postForm`, invalidate the series
// list (and per-series queries, for add-to-existing), and surface a summary toast.

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { postForm, type Schemas } from "@/api/client"
import { queryKeys } from "@/api/hooks"

type UploadResult = Schemas["UploadResult"]

function toForm(files: File[], extra?: Record<string, string>): FormData {
  const form = new FormData()
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v)
  for (const f of files) form.append("files", f)
  return form
}

function createSeriesReq(name: string, files: File[]): Promise<UploadResult> {
  return postForm<UploadResult>("/series", toForm(files, { name }))
}

function uploadToSeriesReq(seriesKey: string, files: File[]): Promise<UploadResult> {
  return postForm<UploadResult>(`/${encodeURIComponent(seriesKey)}/upload`, toForm(files))
}

/** Toast a human summary of what actually landed. */
function summarize(res: UploadResult): void {
  const parts = [`${res.uploaded} photo${res.uploaded === 1 ? "" : "s"} added`]
  if (res.unrecognized > 0) {
    parts.push(`${res.unrecognized} didn't match the naming pattern`)
  }
  if (res.skipped.length > 0) {
    parts.push(`${res.skipped.length} skipped (not an image)`)
  }
  toast.success(parts.join(" · "))
}

function errorToast(e: unknown): void {
  toast.error(e instanceof Error ? e.message : "Upload failed")
}

/** Create a new series (folder + optional initial images). Invalidates the series list. */
export function useCreateSeries() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, files }: { name: string; files: File[] }) =>
      createSeriesReq(name, files),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: queryKeys.series })
      summarize(res)
    },
    onError: errorToast,
  })
}

/** Add images to an existing series. Invalidates the series list + that series' records/status. */
export function useUploadToSeries(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (files: File[]) => uploadToSeriesReq(seriesKey, files),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: queryKeys.series })
      void qc.invalidateQueries({ queryKey: queryKeys.records(seriesKey) })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
      summarize(res)
    },
    onError: errorToast,
  })
}
