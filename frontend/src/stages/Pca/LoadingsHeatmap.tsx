import { useMemo, useState } from "react"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

interface LoadingsHeatmapProps {
  /** pca.loadings — [component][feature]. */
  loadings: number[][]
  featureNames: string[]
  /** How many PCs to show (the retained count); the rest are hidden by default. */
  shown: number
}

/**
 * PCA loadings as a signed heatmap (features × PCs), tucked in a collapsible
 * expander since it's a detail view. A loading's sign picks the token — positive
 * uses the primary colour, negative the destructive one — and its magnitude
 * (relative to the largest absolute loading) sets the cell opacity. This keeps the
 * heatmap on design tokens rather than a hardcoded gradient, while still reading as
 * a diverging scale.
 */
export function LoadingsHeatmap({
  loadings,
  featureNames,
  shown,
}: LoadingsHeatmapProps) {
  const [open, setOpen] = useState(false)

  const nComp = loadings.length
  const cols = Math.min(Math.max(shown, 1), nComp)

  const maxAbs = useMemo(() => {
    let m = 0
    for (const row of loadings) for (const v of row) m = Math.max(m, Math.abs(v))
    return m || 1
  }, [loadings])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium">
        <ChevronRightIcon
          className={cn("size-4 transition-transform", open && "rotate-90")}
        />
        Loadings heatmap
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          {featureNames.length} coefficients × {cols} PC{cols === 1 ? "" : "s"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">
        <p className="mb-3 text-xs text-muted-foreground">
          How strongly each EFA coefficient drives each principal component.
          <span className="ml-1 text-primary">Positive</span> /{" "}
          <span className="text-destructive">negative</span>; deeper = stronger.
        </p>
        <div className="max-h-80 overflow-auto">
          <table className="border-separate border-spacing-0.5 text-[10px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card" />
                {Array.from({ length: cols }, (_, k) => (
                  <th
                    key={k}
                    className="px-1 py-0.5 text-center font-medium tabular-nums text-muted-foreground"
                  >
                    {k + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {featureNames.map((fname, f) => (
                <tr key={fname}>
                  <td className="sticky left-0 z-10 bg-card pr-2 text-right font-mono tabular-nums text-muted-foreground">
                    {fname}
                  </td>
                  {Array.from({ length: cols }, (_, k) => {
                    const v = loadings[k][f]
                    const mag = Math.abs(v) / maxAbs
                    return (
                      <td key={k} className="p-0">
                        <div
                          className="size-4 rounded-[2px]"
                          title={`${fname} · PC${k + 1} = ${v.toFixed(4)}`}
                          style={{
                            backgroundColor:
                              v >= 0 ? "var(--primary)" : "var(--destructive)",
                            opacity: 0.12 + 0.88 * mag,
                          }}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
