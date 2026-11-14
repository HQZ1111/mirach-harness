/**
 * @/lib/slash-completion-cache shim - the composer completion cache.
 *
 * Upstream caches skill/plugin slash completions per profile and invalidates
 * them (plus the React Query layer) whenever a skill or plugin changes, so the
 * composer slash menu reflects the change immediately.
 *
 * Host: the composer is assistant-ui with its own completion pipeline; there is
 * no shared slash-completion cache to invalidate. The mirrored capabilities code
 * calls invalidateSlashCompletions() after every write for exactly that reason,
 * so the call is kept - and it invalidates the one cache this host does keep,
 * the React Query layer, which is what the skills list actually reads.
 */

import { queryClient } from '@/hermes-shim/lib/query-client'

export function invalidateSlashCompletions(): void {
  void queryClient.invalidateQueries({ queryKey: ['skills-list'] })
  void queryClient.invalidateQueries({ queryKey: ['skill-content'] })
  void queryClient.invalidateQueries({ queryKey: ['official-skills'] })
}
