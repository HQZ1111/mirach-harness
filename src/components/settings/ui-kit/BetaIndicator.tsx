import { FlaskConical } from 'lucide-react';

import { useT } from '../i18n';
import Button from './Button';
import Tooltip from './Tooltip';

interface BetaIndicatorProps {
  /** Tooltip copy. Defaults to the shared beta disclaimer. */
  message?: string;
  /** Placement of the explanatory tooltip. */
  side?: 'right' | 'top' | 'bottom' | 'left';
  className?: string;
}

/** Compact beta disclosure for page headers and toolbars. */
export default function BetaIndicator({ message, side = 'bottom', className }: BetaIndicatorProps) {
  const { t } = useT();
  const label = message ?? t('common.betaDisclaimer');

  return (
    <Tooltip label={label} side={side} align="end" multiline>
      <Button
        type="button"
        iconOnly
        variant="tertiary"
        size="xs"
        aria-label={label}
        className={className}>
        <FlaskConical className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" />
      </Button>
    </Tooltip>
  );
}
