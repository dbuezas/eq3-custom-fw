import { exitTestMode } from '@/device/testMode'

import { Button } from './ui/button'

/**
 * The strip that says no thermostat is on the other end of this.
 *
 * It does not decide whether to show itself — `App` does, on `TEST_MODE`. A component that reads a
 * module-level flag can only be tested by mocking that module, and a `mock.module` in bun is global
 * to the whole run: doing it here turned test mode ON for six other files.
 *
 * It takes the top of every screen rather than sitting inside one: in test mode every reading,
 * every switch and every version is made up, so there is no screen where that is safe to forget.
 */
export function TestBanner() {
  return (
    // The same warn treatment `Alert` uses, rather than a colour of its own — there is a `--warn`
    // token and no foreground to pair with a solid fill.
    <div className="sticky top-0 z-50 flex items-center justify-between gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs font-medium">
      <span>Test mode — nothing here is a real thermostat</span>
      <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2" onClick={exitTestMode}>
        Exit test mode
      </Button>
    </div>
  )
}
