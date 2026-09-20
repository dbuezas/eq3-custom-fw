import { ChevronDown } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/**
 * A browser problem, said in ONE LINE, with the rest one tap away.
 *
 * **A WARNING THAT IS NOT FINISHED IS A WARNING THAT DID NOT WORK** `[owner]`. These cards sit above
 * the list of thermostats and grow a paragraph at a time — each sentence true and each one earned —
 * until the ONE actionable sentence is buried in the middle of them.
 *
 * So a hint is two parts and the card shows the first: `short` is what to DO, and it has to stand
 * alone, because most people will read nothing else. `more` is why it works, what it costs and the
 * cases the short line glosses over — kept in full, because the facts in there were measured and
 * some of them are surprising. Nothing is deleted; it is folded.
 *
 * The two parts live together at the hint's definition rather than at the two call sites: the same
 * hint is shown on the list and on a thermostat's Status tab, and a fact that has to be edited in
 * two places gets edited in one.
 */
export type Hint = { short: string; more: string }

export function HintCard({ hint, children }: { hint: Hint; children?: React.ReactNode }) {
  return (
    <Alert variant="warn">
      {/* THE BUTTON AND THE TOGGLE GO INSIDE THE DESCRIPTION `[owner]`. `Alert` is a grid whose first
          column is zero wide, and only `AlertTitle`/`AlertDescription` carry the `col-start-2` that
          escapes it — a bare child auto-places into that zero-width column and renders as a sliver
          with its label spilling out of the box. Seen on the phone. */}
      <AlertDescription className="space-y-2">
        <Collapsible>
          <p>{hint.short}</p>
          <CollapsibleTrigger className="mt-1 flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
            <ChevronDown className="size-3 transition-transform data-[state=open]:rotate-180" />
            Why
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 text-xs text-muted-foreground">
            {hint.more}
          </CollapsibleContent>
        </Collapsible>
        {children}
      </AlertDescription>
    </Alert>
  )
}
