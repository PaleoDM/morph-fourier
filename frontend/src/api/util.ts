// Shared API helpers used by more than one resource module.

/**
 * Encode a `${seriesKey}/${filename}` record key while preserving its `/`
 * separator. The backend routes are declared as `{record_key:path}`, so the
 * slash must survive URL-encoding but each segment still needs escaping.
 *
 * Lifted from `curation.ts` in Phase 4 now that Orient also addresses records
 * by key.
 */
export function encodeRecordKey(recordKey: string): string {
  return recordKey.split("/").map(encodeURIComponent).join("/")
}
