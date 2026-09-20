import { AccessSettings } from '@/components/AccessSettings'
import { FirmwareInstall } from '@/components/FirmwareInstall'

/**
 * SETUP RATHER THAN SETTINGS `[owner]` — what is done when a thermostat is first taken over, and
 * rarely again: the firmware itself, the name it broadcasts, the pairing PIN, the encryption key and
 * the radio switches. They are settings in the strict sense; they belong here because they are part
 * of installing.
 */
export function Install() {
  return (
    <div className="space-y-4">
      <FirmwareInstall />

      {/* Telling this app a key the thermostat ALREADY uses is a different thing and lives on the
          thermostat's row in the saved list — one stored value, one place to edit it. */}
      <AccessSettings />
    </div>
  )
}
