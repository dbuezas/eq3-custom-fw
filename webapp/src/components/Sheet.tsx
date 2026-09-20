import { useEffect, useRef, type ReactNode } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Every modal in this app: a centred card that cannot grow past the screen.
 *
 * IT IS NOT `<dialog>` AND NOT `confirm()`. A native modal blocks the page, and everything this app
 * does is asynchronous — the device pushes a status about once a second and the write queue keeps
 * draining behind whatever is open. A blocked page would stall both. Radix, which is what shadcn's
 * Dialog is, does not block: it is a portal with a focus trap, so the app keeps running underneath.
 *
 * **IT IS A THIN WRAPPER, NOT A SECOND DIALOG.** It adds a capped height and a scrolling body (see
 * `DialogContent` below), so no caller has to remember them and the sheets cannot drift apart.
 * Escape and the backdrop close it, and body scrolling is locked while it is open, all from the
 * primitive; a sheet dismissable only by a small × is a trap on a phone.
 *
 * **AND THE PHONE'S BACK BUTTON CLOSES IT, which is the one way out the primitive cannot give**
 * `[owner]`. Escape is a keyboard, and the backdrop is a tap somewhere specific; on a phone the
 * gesture for "undo that" is Back — and Back presses nothing, so it went straight past the open
 * dialog and took the person out of the thermostat entirely, losing whatever they were half way
 * through typing into it. Every modal in this app is a `Sheet`, so it is fixed here once.
 */

/**
 * How many sheets are holding a history entry right now.
 *
 * MODULE-LEVEL, because the stack it counts is the BROWSER'S and not React's — and it is what tells
 * a `popstate` that OUR entry is the one that went, rather than one belonging to a sheet stacked
 * over us or to the route underneath. Nested sheets therefore close one at a time, innermost first,
 * which is what Back means.
 */
let depth = 0

/** What a history entry pushed by a sheet carries, so `popstate` can tell whose it was. */
const sheetDepth = () => (window.history.state as { sheet?: number } | null)?.sheet ?? 0

export function Sheet({
  title,
  description,
  children,
  onClose,
  autoFocus,
}: {
  title: string
  /** Optional one-line subtitle. It is also what a screen reader announces after the title. */
  description?: string
  children: ReactNode
  /**
   * OMITTING IT MAKES THE DIALOG UNDISMISSABLE, which is deliberate and has exactly one caller: the
   * firmware install, while a transfer is in flight. Escape, the backdrop and the close control all
   * route through here, so leaving it out closes every way out at once rather than three separately
   * — and a half-written thermostat is the one thing on this page worth taking that away for.
   */
  onClose?: () => void
  /**
   * Whether opening moves the keyboard focus into the sheet. Default yes, which is the primitive's
   * own behaviour and right almost everywhere.
   *
   * **A REACT `autoFocus` ON THE FIELD CANNOT TURN THIS OFF, which is the trap** `[owner]`: Radix
   * focuses the first tabbable child when the dialog opens, whatever the field says, so a form that
   * had deliberately dropped its own autofocus still raised the phone's keyboard. The primitive's
   * `onOpenAutoFocus` is the only thing that stops it, and it lives here rather than at the caller
   * because the caller cannot reach it.
   */
  autoFocus?: boolean
}) {
  // THROUGH A REF, because `onClose` is an inline arrow at nearly every call site and so has a new
  // identity on every render. As a dependency it would push a history entry per render.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    /**
     * **THE ENTRY IS PUSHED ON THE NEXT TICK, AND THAT IS THE WHOLE OF STRICTMODE** `[manually
     * verified]`. React double-invokes this effect on mount — run, clean up, run again — so pushing
     * immediately meant the cleanup spent its entry with `history.back()` while the second run had
     * already pushed another, and the resulting `popstate` arrived at a listener that read it as its
     * own entry going. Every dialog in the app closed itself a moment after opening.
     *
     * A timer defers the push past that pair, and the cleanup CANCELS it, so the discarded first run
     * pushes nothing and spends nothing. What is left is exactly one entry per sheet, and the only
     * cost is that Back does nothing for one tick after a dialog opens.
     */
    let mine = 0
    // ONE ENTRY, PUSHED WITH NO URL, so the address does not change — the router reads the pathname
    // and would otherwise see a navigation where there is only a dialog.
    const t = setTimeout(() => {
      mine = ++depth
      window.history.pushState({ sheet: mine }, '')
    })
    const pop = () => {
      if (!mine) return // nothing pushed yet, so nothing of ours can have been popped
      // OURS IS THE ENTRY THAT WENT only when the stack no longer reaches our depth. A sheet opened
      // on top of this one pushes deeper, and Back there lands on an entry that is still ours to
      // hold — so the inner sheet closes and this one stays, which is what a person means.
      if (sheetDepth() >= mine) return
      // AN UNDISMISSABLE SHEET SWALLOWS BACK rather than letting it through. Its one caller is a
      // firmware transfer in flight, and leaving that screen drops the link to a half-written
      // thermostat — so the entry goes straight back and the press does nothing at all.
      if (!close.current) return void window.history.pushState({ sheet: mine }, '')
      close.current()
    }
    window.addEventListener('popstate', pop)
    return () => {
      clearTimeout(t)
      window.removeEventListener('popstate', pop)
      if (!mine) return
      depth--
      // CLOSED SOME OTHER WAY — a button, Escape, the backdrop. The entry we pushed is still on the
      // stack, so it is spent here; without this the next Back would land on an address that looks
      // exactly the same and appear to do nothing.
      if (sheetDepth() >= mine) window.history.back()
    }
  }, [])

  return (
    <Dialog open onOpenChange={(next) => !next && onClose?.()}>
      <DialogContent
        onOpenAutoFocus={autoFocus === false ? (e) => e.preventDefault() : undefined}
        // The ONLY two things this adds to the primitive: it may not grow past the screen, and its
        // own body scrolls rather than the page behind it. The primitive's centred position is left
        // alone — anchoring it to the bottom edge for thumb reach means overriding its position,
        // its translate and its width at two breakpoints, and any one of those landing wrong puts
        // the dialog half off screen.
        //
        // **`flex flex-col` IS LOAD-BEARING, not tidying.** The primitive is a GRID, so the body's
        // `flex-1 min-h-0` below did nothing at all: it took its natural height, overflowed the
        // capped container, and `overflow-hidden` CLIPPED it — a dialog with more content than the
        // screen simply lost the bottom of it, with no scrollbar to say so. Measured on the weekly
        // programme once a few programmes had been saved.
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0"
      >
        {/* `shrink-0` so a long body squeezes itself and not the title. */}
        <DialogHeader className="shrink-0 border-b px-4 py-3 text-left">
          <DialogTitle className="truncate text-base font-medium">{title}</DialogTitle>
          {/* Radix warns when a dialog has no description; an empty one is hidden rather than
              omitted, so the warning does not appear for the sheets that genuinely need no
              subtitle. */}
          <DialogDescription className={description ? 'text-sm' : 'sr-only'}>
            {description ?? title}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </DialogContent>
    </Dialog>
  )
}
