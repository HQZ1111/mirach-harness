import { useStore } from 'zustand'

import { cn } from '@/lib/utils';
import { useT } from '@/components/settings/i18n';
import Button from '@/components/settings/ui-kit/Button';
import { useSettingsLayout } from '../layout/SettingsLayoutContext';
import { settingsNavStore } from '../hooks/useSettingsNavigation';

interface SettingsBackButtonProps {
  /** Invoked when the button is pressed (typically `navigateBack`). */
  onBack?: () => void;
}

/**
 * Route-aware back button shared by settings panels built on
 * {@link PanelScaffold}. Encapsulates the visibility rules so they render the
 * exact same affordance:
 *
 * - Hidden entirely when there's no `onBack`, or when a panel is embedded
 *   *outside* the settings route tree (e.g. Brain / Connections host their own
 *   navigation and the settings `onBack` would jump away from the host).
 * - Inside the two-pane settings shell, top-level destinations
 *   (`/settings/<slug>`) hide it on md+ — the sidebar owns navigation there —
 *   while nested pages keep it at every width.
 *
 * Returns `null` when it should not show, so callers can drop it into a slot
 * unconditionally.
 */
const SettingsBackButton = ({ onBack }: SettingsBackButtonProps) => {
  // 去 react-router（2026-10-17）：mirach 的 settings 是浮层，路径恒为
  // `/settings/<route>`。用当前导航状态拼出等价 pathname，可见性规则不变。
  const route = useStore(settingsNavStore, (s) => s.route);
  const pathname = route === 'home' ? '/settings' : `/settings/${route}`;
  return <SettingsBackButtonView onBack={onBack} pathname={pathname} />;
};

const SettingsBackButtonView = ({
  onBack,
  pathname,
}: SettingsBackButtonProps & { pathname: string }) => {
  const { t } = useT();
  const { inTwoPaneShell } = useSettingsLayout();

  const isSettingsPath = pathname.startsWith('/settings');
  const show = !!onBack && (isSettingsPath || !inTwoPaneShell);
  if (!show) return null;

  const isTopLevel = pathname.split('/').filter(Boolean).length <= 2;

  return (
    <Button
      type="button"
      variant="tertiary"
      size="xs"
      iconOnly
      onClick={onBack}
      className={cn(
        'w-6 h-6 rounded-full dark:bg-surface-muted mr-2',
        inTwoPaneShell && isTopLevel && 'md:hidden'
      )}
      aria-label={t('common.back')}>
      <svg
        className="w-4 h-4 text-content-muted"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </Button>
  );
};

export default SettingsBackButton;
