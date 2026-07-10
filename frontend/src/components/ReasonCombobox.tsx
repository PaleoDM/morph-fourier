import { useState } from "react"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** Suggested rejection reasons (ROADMAP Phase 3 step 3). Free text is also allowed. */
export const SUGGESTED_REASONS = [
  "occluded",
  "out of focus",
  "duplicate",
  "not fully in view",
  "wrong series",
  "other",
] as const

interface ReasonComboboxProps {
  value: string | null
  onChange: (reason: string) => void
  /** True when the photo is rejected but no reason is recorded yet. */
  required?: boolean
}

/**
 * Reject-reason picker: a shadcn combobox (Popover + Command). Shows the six
 * suggested reasons and accepts free text — typing a reason that matches nothing
 * offers a "Use …" affordance so any custom reason can be recorded. When
 * `required` and empty, the trigger takes a destructive outline to flag that a
 * rejection still needs a reason.
 */
export function ReasonCombobox({ value, onChange, required }: ReasonComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const commit = (reason: string) => {
    onChange(reason)
    setQuery("")
    setOpen(false)
  }

  const trimmed = query.trim()
  const isNew =
    trimmed.length > 0 &&
    !SUGGESTED_REASONS.some((r) => r.toLowerCase() === trimmed.toLowerCase())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between text-xs font-normal",
            !value && "text-muted-foreground",
            required && !value && "border-destructive text-destructive",
          )}
        >
          {value ?? (required ? "Reason required — pick one" : "Select a reason…")}
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search or type a reason…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {isNew ? (
                <button
                  type="button"
                  className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => commit(trimmed)}
                >
                  Use “{trimmed}”
                </button>
              ) : (
                "No reason found."
              )}
            </CommandEmpty>
            <CommandGroup>
              {SUGGESTED_REASONS.map((reason) => (
                <CommandItem key={reason} value={reason} onSelect={() => commit(reason)}>
                  <CheckIcon
                    className={cn(
                      "size-4",
                      value === reason ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {reason}
                </CommandItem>
              ))}
              {isNew && (
                <CommandItem value={`__use__${trimmed}`} onSelect={() => commit(trimmed)}>
                  <CheckIcon className="size-4 opacity-0" />
                  Use “{trimmed}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
