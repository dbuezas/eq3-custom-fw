import { useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

import { Button } from './ui/button'

/**
 * "A new version is ready" — asked, never done behind your back.
 *
 * THE APP IS INSTALLED AND WORKS OFFLINE, which means a service worker holds a copy of it. The
 * classic failure of that arrangement is serving a stale app forever, and the classic fix — update
 * automatically — is wrong HERE: this app holds a Bluetooth connection and can be mid-way through a
 * weekly programme somebody has not sent yet. Swapping the code underneath that loses their work.
 *
 * So it offers, and reloading is a tap. `ready to work offline` is worth saying once as well: it is
 * the moment the app becomes usable in a cellar, and there is no other way to know it happened.
 */
export function UpdatePrompt() {
  const [needsUpdate, setNeedsUpdate] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  // A ref, not state: this is a callback the button fires, it is never rendered, and putting it in
  // state would be a render triggered from inside an effect for nothing.
  const update = useRef<((reload: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    update.current = registerSW({
      onNeedRefresh: () => setNeedsUpdate(true),
      onOfflineReady: () => setOfflineReady(true),
    })
  }, [])

  if (!needsUpdate && !offlineReady) return null

  return (
    <div
      className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md items-center gap-3 rounded-xl border bg-background/95 px-4 py-3 shadow-lg backdrop-blur"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      role="status"
    >
      <p className="min-w-0 flex-1 text-sm">
        {needsUpdate ? 'A newer version of this app is ready.' : 'Ready to work with no network.'}
      </p>
      {needsUpdate && (
        <Button className="shrink-0" onClick={() => void update.current?.(true)}>
          Reload
        </Button>
      )}
      <Button
        variant="outline"
        className="shrink-0 text-muted-foreground"
        onClick={() => {
          setNeedsUpdate(false)
          setOfflineReady(false)
        }}
      >
        {needsUpdate ? 'Later' : 'OK'}
      </Button>
    </div>
  )
}
