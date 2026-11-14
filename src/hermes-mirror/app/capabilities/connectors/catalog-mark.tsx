import { Codicon } from '@/hermes-mirror/components/ui/codicon'
import { Tip } from '@/hermes-mirror/components/ui/tooltip'
import { useI18n } from '@/hermes-mirror/i18n'
import { cn } from '@/hermes-shim/lib/utils'

export function CatalogMark({ className }: { className?: string }) {
  const { t } = useI18n()
  const label = t.connectorsPage.card.inCatalog

  return (
    <Tip label={label}>
      <span
        aria-label={label}
        className={cn('relative z-10 flex shrink-0 items-center text-(--ui-text-quaternary)', className)}
        role="img"
      >
        <Codicon name="verified-filled" size="0.75rem" />
      </span>
    </Tip>
  )
}
