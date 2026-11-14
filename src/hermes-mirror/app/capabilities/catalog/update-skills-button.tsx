import { Button } from '@/hermes-mirror/components/ui/button'
import type { ProfileScope } from '@/hermes-shim/hermes'
import { useI18n } from '@/hermes-mirror/i18n'
import { useStoreSelector } from '@/hermes-shim/lib/use-session-slice'
import { $hubActions, UPDATE_ALL_KEY, updateHubSkills } from '@/hermes-shim/store/hub-actions'
import { notify, notifyError } from '@/hermes-shim/store/notifications'

export function UpdateSkillsButton({ profile }: { profile?: ProfileScope }) {
  const { t } = useI18n()
  const h = t.skills.hub
  const updating = useStoreSelector($hubActions, actions => actions[UPDATE_ALL_KEY]?.running ?? false)

  return (
    <Button
      disabled={updating}
      onClick={() => {
        notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })
        void updateHubSkills(profile).catch(err => notifyError(err, h.actionFailed))
      }}
      size="xs"
      variant="text"
    >
      {updating ? h.updating : h.updateAll}
    </Button>
  )
}
