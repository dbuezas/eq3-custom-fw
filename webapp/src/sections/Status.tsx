import { useAtomValue } from 'jotai'

import { HintCard } from '@/components/HintCard'
import { LiveValues } from '@/components/LiveValues'
import { PanelMessage } from '@/components/PanelMessage'
import { SoundButton } from '@/components/SoundButton'
import { StatusControls } from '@/components/StatusControls'
import { ENABLE_HINT, SUPPORTED } from '@/device/advert'
import { advertAtom } from '@/state/atoms'

/**
 * THE TAB SOMEBODY OPENS TO USE THE THERMOSTAT, and the only one that works with no connection —
 * the broadcast arrives whether or not anybody is linked, which is the whole reason it leads.
 */
export function Status() {
  const adv = useAtomValue(advertAtom)

  return (
    <div className="space-y-4">
      {!SUPPORTED && <HintCard hint={ENABLE_HINT} />}

      {/* THE CONTROLS LEAD, and the broadcast follows them. They are why somebody opened this tab;
          the panel below is what the thermostat is saying, and it is a reading rather than a
          control. Keeping the two apart is also what lets the panel keep its shape when the link
          opens — see `LiveValues`. */}
      <StatusControls />

      {/* A TAG MISMATCH IS NOT SILENCE. The payload arrived — it just could not be read — so this
          says so and points at where the key is entered, instead of showing an empty panel that
          reads as a dead device. */}
      {adv.problem && (
        <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          {adv.count} broadcast{adv.count === 1 ? '' : 's'} arrived and could not be decoded:{' '}
          {adv.problem}. Check this thermostat&rsquo;s key on the list.
        </p>
      )}

      <LiveValues />

      {/* SoundButton stays here and the clock does not `[owner]`: making a noise identifies WHICH
          radiator this is, which is a thing you do while looking at the readings. Setting the
          thermostat's clock is a setting, and it is filed with them. PanelMessage is beside it
          because it answers the same question with the screen instead of the motor. */}
      <SoundButton />
      <PanelMessage />
    </div>
  )
}
