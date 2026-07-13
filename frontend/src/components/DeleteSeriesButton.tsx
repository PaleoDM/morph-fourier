import { useState } from "react"
import { Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useDeleteSeries } from "@/api/upload"

/** Trash button + confirmation that permanently deletes a series (photos + state). */
export function DeleteSeriesButton({
  seriesKey,
  displayName,
}: {
  seriesKey: string
  displayName: string
}) {
  const [open, setOpen] = useState(false)
  const del = useDeleteSeries()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Delete series" title="Delete series">
          <Trash2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{displayName}”?</DialogTitle>
          <DialogDescription>
            This permanently removes the series, its photos, and all of its saved
            analysis. This can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() => del.mutate(seriesKey, { onSuccess: () => setOpen(false) })}
          >
            {del.isPending ? "Deleting…" : "Delete series"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
