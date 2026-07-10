import { useMemo, useState } from "react"
import { PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ColumnType, TaxonomyState } from "@/types/domain"
import type { SpecimenRow } from "./MorphospaceStage"

interface TaxonomyEditorProps {
  specimens: SpecimenRow[]
  taxonomy: TaxonomyState
  /** Called with the next full table on every edit; the stage debounces the save. */
  onChange: (next: TaxonomyState) => void
}

/**
 * The metadata spreadsheet (ROADMAP Phase 9 step 1). One row per canonical specimen,
 * one editable column per user-defined tag. Columns are categorical (text) or numeric
 * (number). Add/remove columns; every cell edit flows up via `onChange` and the stage
 * auto-saves it (debounced) to taxonomy.json. The first column (Specimen) is the join
 * key with the PCA scores and is read-only.
 */
export function TaxonomyEditor({ specimens, taxonomy, onChange }: TaxonomyEditorProps) {
  const { columns, assignments } = taxonomy

  const existingNames = useMemo(
    () => new Set(columns.map((c) => c.name.toLowerCase())),
    [columns],
  )

  const setCell = (idSafe: string, col: string, raw: string, type: ColumnType) => {
    let value: string | number | null
    if (raw.trim() === "") value = null
    else if (type === "numeric") {
      const n = Number(raw)
      value = Number.isFinite(n) ? n : null
    } else value = raw
    onChange({
      ...taxonomy,
      assignments: {
        ...assignments,
        [idSafe]: { ...(assignments[idSafe] ?? {}), [col]: value },
      },
    })
  }

  const addColumn = (name: string, type: ColumnType) => {
    onChange({ ...taxonomy, columns: [...columns, { name, type }] })
  }

  const removeColumn = (name: string) => {
    const nextAssignments: TaxonomyState["assignments"] = {}
    for (const [id, row] of Object.entries(assignments)) {
      const { [name]: _drop, ...rest } = row
      nextAssignments[id] = rest
    }
    onChange({
      ...taxonomy,
      columns: columns.filter((c) => c.name !== name),
      assignments: nextAssignments,
    })
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">Taxonomy</h3>
          <p className="text-xs text-muted-foreground">
            {specimens.length} specimen{specimens.length === 1 ? "" : "s"} ·{" "}
            {columns.length} column{columns.length === 1 ? "" : "s"} · edits auto-save
          </p>
        </div>
        <AddColumnForm existingNames={existingNames} onAdd={addColumn} />
      </div>

      {specimens.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          No canonical specimens yet — mark canonicals in Stage 1 to tag them here.
        </p>
      ) : (
        <div className="max-h-72 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="sticky left-0 z-20 bg-card">Specimen</TableHead>
                {columns.map((col) => (
                  <TableHead key={col.name} className="min-w-40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-foreground" title={col.name}>
                        {col.name}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {col.type === "numeric" ? "#" : "abc"}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeColumn(col.name)}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title={`Remove ${col.name}`}
                          aria-label={`Remove column ${col.name}`}
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      </span>
                    </div>
                  </TableHead>
                ))}
                {columns.length === 0 && (
                  <TableHead className="text-muted-foreground">
                    Add a column to start tagging →
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {specimens.map((s) => (
                <TableRow key={s.idSafe}>
                  <TableCell className="sticky left-0 z-10 bg-card font-medium tabular-nums">
                    <span title={s.idSafe}>{s.specimenId}</span>
                  </TableCell>
                  {columns.map((col) => {
                    const v = assignments[s.idSafe]?.[col.name]
                    return (
                      <TableCell key={col.name}>
                        <Input
                          type={col.type === "numeric" ? "number" : "text"}
                          value={v == null ? "" : String(v)}
                          onChange={(e) =>
                            setCell(s.idSafe, col.name, e.target.value, col.type)
                          }
                          className="h-8"
                        />
                      </TableCell>
                    )
                  })}
                  {columns.length === 0 && <TableCell />}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/** Inline "add column" control: a name field + a type picker. */
function AddColumnForm({
  existingNames,
  onAdd,
}: {
  existingNames: Set<string>
  onAdd: (name: string, type: ColumnType) => void
}) {
  const [name, setName] = useState("")
  const [type, setType] = useState<ColumnType>("categorical")

  const trimmed = name.trim()
  const invalid = trimmed === "" || existingNames.has(trimmed.toLowerCase())

  const submit = () => {
    if (invalid) return
    onAdd(trimmed, type)
    setName("")
    setType("categorical")
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
        }}
        placeholder="New column…"
        className="h-8 w-36"
        aria-label="New column name"
      />
      <Select value={type} onValueChange={(v) => setType(v as ColumnType)}>
        <SelectTrigger className="h-8 w-32" aria-label="Column type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="categorical">Categorical</SelectItem>
          <SelectItem value="numeric">Numeric</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1"
        onClick={submit}
        disabled={invalid}
        title={
          trimmed !== "" && existingNames.has(trimmed.toLowerCase())
            ? "A column with that name already exists"
            : "Add column"
        }
      >
        <PlusIcon className="size-4" />
        Add
      </Button>
    </div>
  )
}
