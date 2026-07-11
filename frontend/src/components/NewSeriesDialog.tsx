import { useRef, useState, type ReactNode } from "react"
import { ImagePlus, X } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { useCreateSeries } from "@/api/upload"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { cn } from "@/lib/utils"

const IMAGE_RE = /\.(jpe?g|png)$/i

/**
 * "New series" dialog: name it, drag-and-drop (or pick) specimen photos, upload.
 * On success the new series becomes active. This is the no-terminal replacement
 * for hand-dropping a folder into `photos/`.
 */
export function NewSeriesDialog({ trigger }: { trigger?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const create = useCreateSeries()
  const setActiveSeriesKey = useActiveSeriesStore((s) => s.setActiveSeriesKey)

  function reset() {
    setName("")
    setFiles([])
    setDragging(false)
  }

  function addFiles(list: FileList | null) {
    if (!list) return
    const imgs = Array.from(list).filter(
      (f) => f.type.startsWith("image/") || IMAGE_RE.test(f.name),
    )
    setFiles((prev) => [...prev, ...imgs])
  }

  function submit() {
    create.mutate(
      { name: name.trim(), files },
      {
        onSuccess: (res) => {
          setActiveSeriesKey(res.series.key)
          setOpen(false)
          reset()
        },
      },
    )
  }

  const canSubmit = name.trim().length > 0 && !create.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <ImagePlus className="size-4" />
            Upload photos
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New series</DialogTitle>
          <DialogDescription>
            Name it and add your specimen photos. Each series is analysed on its own.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Input
            placeholder="Series name (e.g. Leaves — top view)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") inputRef.current?.click()
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              addFiles(e.dataTransfer.files)
            }}
            className={cn(
              "flex h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border text-center text-sm text-muted-foreground transition-colors hover:bg-accent/50",
              dragging && "border-primary bg-accent",
            )}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ""
              }}
            />
            <ImagePlus className="size-6" />
            {files.length > 0 ? (
              <span className="font-medium text-foreground">
                {files.length} photo{files.length === 1 ? "" : "s"} selected
              </span>
            ) : (
              <span>Drag photos here, or click to choose</span>
            )}
          </div>

          {files.length > 0 && (
            <button
              type="button"
              onClick={() => setFiles([])}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
              Clear selection
            </button>
          )}

          <p className="text-xs text-muted-foreground">
            Filenames should look like{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
              Genus_species_catalog_index.jpg
            </code>{" "}
            so photos of the same specimen group together. Others still upload, but
            won't be recognised as specimens.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {create.isPending ? "Uploading…" : "Create series"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
