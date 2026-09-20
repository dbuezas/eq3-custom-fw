import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  // OURS: `active:scale-[0.97]`, the PRESS. Upstream ships no `:active` state at all, and on a
  // touch screen there is no hover either -- so without this a tap had no feedback whatsoever
  // between the finger landing and whatever the handler eventually did, which on a slow BLE round
  // trip is a long time to wonder whether the press registered. Scale is the cue that works on
  // EVERY variant, including `ghost` and `link`, which have no background to deepen; the filled
  // variants deepen as well, below. `transition-all` above animates it.
  //
  // `motion-reduce:active:scale-100` honours the OS setting, and costs those users nothing: the
  // colour change on the filled variants is a motion-free cue that stays.
  //
  // **`active:duration-0` -- THE PRESS IS INSTANT AND ONLY THE RELEASE EASES.** `transition-all`
  // carries one duration for every state, so at the shared 150 ms a press spent 150 ms travelling
  // DOWN and 150 ms back: on a quick tap the two overlap and the button never reaches the pressed
  // size, which reads as a slow smear rather than a press. A duration that applies only while
  // `:active` makes the finger's own movement the animation and leaves the return eased, which is
  // what a native control does. Hover and focus keep the shared 150 ms -- this narrows one state,
  // not the transition.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none active:scale-[0.97] active:duration-0 motion-reduce:active:scale-100 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // OURS: every `active:` below. A filled variant deepens one more step than its hover, and the
      // two see-through ones take the accent their hover would have given -- which is the whole
      // point on a TOUCH screen, where the hover state never happens and the press is the first
      // feedback there is.
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 dark:active:bg-input/60",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70",
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground dark:hover:bg-accent/50 dark:active:bg-accent/60",
        link: "text-primary underline-offset-4 hover:underline active:underline",
      },
      // OURS: every size is one step taller than upstream's, because this app is operated standing
      // at a radiator, one-handed, and 44 px is the tap target that needs. It is here rather than
      // in a global `button { min-height }` rule, which reached every Radix control -- they are all
      // <button> underneath -- and stretched the switches and checkboxes with them.
      size: {
        default: "h-11 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-12 rounded-md px-6 has-[>svg]:px-4",
        // OURS: a full-width settings row -- an icon, two lines of text, and something on the
        // right. It is a size rather than six overrides at each of the three call sites that want
        // it, because a Button is a one-line control by default (centred, nowrap, fixed height)
        // and every one of those has to be undone for a row. Missing one truncates the second
        // line or centres the text, which is the shape of bug this variant exists to prevent.
        row: "h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left font-normal whitespace-normal",
        icon: "size-11",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
