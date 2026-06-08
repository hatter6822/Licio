// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Focus-mode control (WS-B.2.8c). A presentation-only wrapper over the `Switch`
// primitive: it toggles a calmer feed that surfaces only high-confidence stories
// and active threads. Persistence of the preference is WS-C; this component owns
// no state and simply reflects/relays the controlled `enabled` value.
import { useT } from '../../../i18n/index.js';
import { Switch } from '../../ui/Switch/index.js';

export interface FocusModeToggleProps {
  /** Whether focus mode is currently on. */
  enabled: boolean;
  /** Called with the requested next state when the user toggles. */
  onEnabledChange: (enabled: boolean) => void;
  /** Explicit id for the underlying switch; auto-generated when omitted. */
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function FocusModeToggle({
  enabled,
  onEnabledChange,
  id,
  disabled = false,
  className,
}: FocusModeToggleProps): React.ReactElement {
  const t = useT();
  return (
    <Switch
      {...(id !== undefined ? { id } : {})}
      label={t('wellbeing.focusMode.label', 'Focus mode')}
      description={t(
        'wellbeing.focusMode.description',
        'Show only high-confidence stories and active threads',
      )}
      checked={enabled}
      onCheckedChange={onEnabledChange}
      disabled={disabled}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
