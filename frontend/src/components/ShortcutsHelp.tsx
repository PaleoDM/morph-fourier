import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { STAGES } from "@/types/domain"

/**
 * Keyboard-shortcut reference (opened with `?`, or the header button). Lists the
 * global shortcuts the app registers in AppShell so they're discoverable rather
 * than hidden — the Phase 10 "small ? help surface" requirement.
 */
export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Move through the pipeline without leaving the keyboard.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Navigation
            </h3>
            <ul className="space-y-1.5">
              {STAGES.map((stage) => (
                <Row key={stage.id} keys={[String(stage.index)]} label={stage.label} />
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              General
            </h3>
            <ul className="space-y-1.5">
              <Row keys={["?"]} label="Show this help" />
              <Row keys={["Esc"]} label="Close this help / any open dialog or menu" />
            </ul>
          </section>
        </div>

        <p className="text-xs text-muted-foreground">
          Number keys are ignored while you’re typing in a text field.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 text-sm">
      <span>{label}</span>
      <span className="flex gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground"
          >
            {k}
          </kbd>
        ))}
      </span>
    </li>
  )
}
