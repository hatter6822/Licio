// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Participation Composer (WS-B.2.10). The composer first asks "What are you
// adding?" and offers eight STRUCTURED modes; choosing one reveals ONLY that
// mode's required and optional fields. This replaces a single "post" box (and,
// pointedly, a "post for likes" button) with mode-specific prompts that ask for
// the evidence, reasoning, or context the contribution actually needs.
//
// Field state lives in this component, keyed by mode, so a draft survives
// re-render AND survives switching modes and back. `onDraftChange` fires on
// every edit (hand the draft to autosave); `onSubmit` reports the final values.
//
// Doctrine (no applause): there is intentionally no submit-for-applause action
// and no reaction / like / vote control anywhere here. Asserted in the
// no-applause test.
import { type FormEvent, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { Input } from '../../ui/Input/index.js';
import { Select } from '../../ui/Select/index.js';
import { TextArea } from '../../ui/TextArea/index.js';
import { PrivacyWarning } from '../ComposerAffordances/index.js';
import {
  type ComposerMode,
  type ComposerValues,
  composerModes,
  getModeDefinition,
  type ModeField,
} from './modes.js';

/** Per-mode field errors: field name → message. */
export type ComposerErrors = Record<string, string>;

export interface ParticipationComposerProps {
  /** Controlled selected mode; uncontrolled when omitted. */
  mode?: ComposerMode;
  /** Initial mode for the uncontrolled case (default: none, show the chooser). */
  defaultMode?: ComposerMode;
  onModeChange?: (mode: ComposerMode) => void;
  /** Called on submit with the active mode and its field values. */
  onSubmit?: (mode: ComposerMode, values: ComposerValues) => void;
  /** Called on EVERY field change — pass the draft straight to autosave. */
  onDraftChange?: (mode: ComposerMode, values: ComposerValues) => void;
  /**
   * Externally-supplied validation errors for the active mode (field → message).
   * Merged with the composer's own "required field left empty" detection.
   */
  errors?: ComposerErrors;
  className?: string;
}

/** Empty values record for a freshly-selected mode. */
function emptyValues(): ComposerValues {
  return {};
}

export function ParticipationComposer({
  mode: controlledMode,
  defaultMode,
  onModeChange,
  onSubmit,
  onDraftChange,
  errors,
  className,
}: ParticipationComposerProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const chooserLabelId = useId();

  const isModeControlled = controlledMode !== undefined;
  const [internalMode, setInternalMode] = useState<ComposerMode | undefined>(defaultMode);
  const activeMode = isModeControlled ? controlledMode : internalMode;

  // One values record per mode so switching away and back preserves the draft.
  const [valuesByMode, setValuesByMode] = useState<Record<string, ComposerValues>>({});
  // Fields the user has blurred — required-empty errors surface only after the
  // user has left a field, never mid-typing (WCAG 3.3.1, gentle validation).
  const [blurred, setBlurred] = useState<Record<string, boolean>>({});

  const activeValues = activeMode ? (valuesByMode[activeMode] ?? emptyValues()) : emptyValues();

  const selectMode = (next: ComposerMode): void => {
    if (!isModeControlled) {
      setInternalMode(next);
    }
    onModeChange?.(next);
  };

  const blurKey = (mode: ComposerMode, field: string): string => `${mode}:${field}`;

  const setFieldValue = (field: string, value: string): void => {
    if (!activeMode) {
      return;
    }
    const nextForMode = { ...activeValues, [field]: value };
    const nextByMode = { ...valuesByMode, [activeMode]: nextForMode };
    setValuesByMode(nextByMode);
    // Hand the live draft to autosave on every change.
    onDraftChange?.(activeMode, nextForMode);
  };

  const markBlurred = (field: string): void => {
    if (!activeMode) {
      return;
    }
    setBlurred((prev) => ({ ...prev, [blurKey(activeMode, field)]: true }));
  };

  /**
   * The error to show for a field: an explicit `errors` entry wins; otherwise a
   * required field that has been blurred and left empty shows the standard
   * "required" message.
   */
  const errorFor = (field: ModeField): string | undefined => {
    if (!activeMode) {
      return undefined;
    }
    const supplied = errors?.[field.name];
    if (supplied) {
      return supplied;
    }
    if (!field.required) {
      return undefined;
    }
    const value = activeValues[field.name] ?? '';
    const touched = blurred[blurKey(activeMode, field.name)];
    if (touched && value.trim() === '') {
      return t('composer.error.required', 'This field is required.');
    }
    return undefined;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!activeMode) {
      return;
    }
    // Mark every required field blurred so any missing ones surface their error.
    const definition = getModeDefinition(activeMode);
    const nextBlurred = { ...blurred };
    let hasMissingRequired = false;
    for (const field of definition.fields) {
      if (field.required) {
        nextBlurred[blurKey(activeMode, field.name)] = true;
        if ((activeValues[field.name] ?? '').trim() === '') {
          hasMissingRequired = true;
        }
      }
    }
    setBlurred(nextBlurred);
    if (hasMissingRequired) {
      return;
    }
    onSubmit?.(activeMode, activeValues);
  };

  const renderField = (field: ModeField): React.ReactElement => {
    const value = activeValues[field.name] ?? '';
    const error = errorFor(field);
    const label = t(field.labelKey, field.labelText);

    const fieldNode = ((): React.ReactElement => {
      if (field.kind === 'textarea') {
        return (
          <TextArea
            label={label}
            required={field.required}
            value={value}
            {...(error ? { error } : {})}
            onChange={(event) => setFieldValue(field.name, event.target.value)}
            onBlur={() => markBlurred(field.name)}
          />
        );
      }
      if (field.kind === 'select') {
        return (
          <Select
            label={label}
            required={field.required}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: t(option.labelKey, option.labelText),
            }))}
            {...(value ? { value } : {})}
            {...(error ? { error } : {})}
            onValueChange={(next) => {
              setFieldValue(field.name, next);
              markBlurred(field.name);
            }}
          />
        );
      }
      return (
        <Input
          label={label}
          required={field.required}
          value={value}
          {...(error ? { error } : {})}
          onChange={(event) => setFieldValue(field.name, event.target.value)}
          onBlur={() => markBlurred(field.name)}
        />
      );
    })();

    return (
      <div key={field.name} className="flex flex-col gap-2">
        {/* Privacy warning renders BEFORE its sensitive field (DOM + reading
            order), so the user is warned ahead of entering location/time or a
            file reference (WS-B.2.10). */}
        {field.privacyWarningKey && field.privacyWarningText ? (
          <PrivacyWarning>{t(field.privacyWarningKey, field.privacyWarningText)}</PrivacyWarning>
        ) : null}
        {fieldNode}
      </div>
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex flex-col gap-4 rounded-lg border border-line bg-canvas p-4', className)}
    >
      <h2 id={headingId} className="text-lg font-semibold text-ink">
        {t('composer.heading', 'What are you adding?')}
      </h2>

      {/* Mode chooser: a single-select list of cards. Native <button> semantics
          with aria-pressed (a toggle group) — no hand-rolled radio roles. Each
          button's accessible name combines the mode name and its guiding
          question, and the question is also shown visually as a description. */}
      <ul aria-labelledby={chooserLabelId} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <li className="sr-only" id={chooserLabelId}>
          {t('composer.chooser.label', 'Choose what you are adding')}
        </li>
        {composerModes.map((definition) => {
          const name = t(definition.nameKey, definition.nameText);
          const prompt = t(definition.promptKey, definition.promptText);
          const selected = definition.mode === activeMode;
          return (
            <li key={definition.mode}>
              <Button
                variant={selected ? 'primary' : 'secondary'}
                aria-pressed={selected}
                aria-label={t('composer.chooser.option', '{name}: {prompt}', { name, prompt })}
                onClick={() => selectMode(definition.mode)}
                className="h-full w-full flex-col items-start gap-1 px-4 py-3 text-start"
              >
                <span className="flex items-center gap-2 font-semibold">
                  <Icon name={definition.icon} className="size-5 shrink-0" aria-hidden="true" />
                  {name}
                </span>
                <span
                  className={cn(
                    'text-start text-sm font-normal',
                    selected ? 'text-primary-fg' : 'text-ink-muted',
                  )}
                >
                  {prompt}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>

      {activeMode ? (
        <ComposerForm
          key={activeMode}
          mode={activeMode}
          onSubmit={handleSubmit}
          renderField={renderField}
        />
      ) : (
        <p className="text-sm text-ink-muted">
          {t('composer.empty', 'Choose a mode above to see what this contribution needs.')}
        </p>
      )}
    </section>
  );
}

interface ComposerFormProps {
  mode: ComposerMode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  renderField: (field: ModeField) => React.ReactElement;
}

/** The active mode's prompt heading + its fields + a submit (contribute) button. */
function ComposerForm({ mode, onSubmit, renderField }: ComposerFormProps): React.ReactElement {
  const t = useT();
  const promptId = useId();
  const definition = getModeDefinition(mode);
  const prompt = t(definition.promptKey, definition.promptText);

  return (
    // `noValidate`: the composer owns validation. Native bubbles would conflict
    // with our gentle, blur-based, aria-linked errors and would suppress the
    // submit event before our handler can mark fields and announce problems.
    <form aria-labelledby={promptId} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <h3 id={promptId} className="text-base font-medium text-ink">
        {prompt}
      </h3>

      <div className="flex flex-col gap-4">{definition.fields.map(renderField)}</div>

      {/* The submit verb is "Contribute" — never "Post" / "Like". This adds a
          structured contribution; it is not an applause action. */}
      <div className="flex">
        <Button type="submit" variant="primary">
          {t('composer.submit', 'Add contribution')}
        </Button>
      </div>
    </form>
  );
}
