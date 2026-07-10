import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * shadcn-style range slider over Radix. Used by the EFA harmonics slider and the
 * PCA retention slider. Controlled via `value` (an array) + `onValueChange`.
 */
function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 shrink-0 rounded-full border border-primary/60 bg-background shadow-sm outline-none transition-[color,box-shadow] focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none" />
    </SliderPrimitive.Root>
  )
}

export { Slider }
