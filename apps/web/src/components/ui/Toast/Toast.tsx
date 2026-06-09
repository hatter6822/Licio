// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';
import { type Tone, toneIcons, toneSoftClasses } from '../status.js';

/**
 * Toast tones. The four semantic tones map to the canonical status vocabulary
 * (icon + colour); `neutral` is the tone-less default — it carries no semantic
 * colour and renders no status icon, so the message text is the sole signal.
 *
 * A toast announces transient task feedback (saved, failed, retrying). It is
 * NEVER used to surface a popularity/applause event — Licio replaces popularity
 * voting with mathematical invariants, so there is deliberately no such tone.
 */
export type ToastTone = Tone | 'neutral';

export interface ToastAction {
  /** Action button label (e.g. "Undo", "Retry"). */
  label: string;
  /** Invoked on activation. The toast dismisses afterwards. */
  onAction: () => void;
}

export interface ToastOptions {
  /** Body text announced to assistive tech and shown beside the tone icon. */
  message: ReactNode;
  /** Semantic tone, or `neutral` (default) for tone-less feedback. */
  tone?: ToastTone;
  /** Optional single action affordance. */
  action?: ToastAction;
  /**
   * Auto-dismiss delay in ms (default 5000). The timer pauses while the toast
   * is hovered or holds focus, and resumes on leave/blur.
   */
  duration?: number;
}

interface ToastEntry extends ToastOptions {
  id: string;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 5000;

/** Soft tinted surface per tone; `neutral` uses the plain raised surface. */
const toneSurface: Record<ToastTone, string> = {
  success: toneSoftClasses.success,
  warning: toneSoftClasses.warning,
  error: toneSoftClasses.error,
  info: toneSoftClasses.info,
  neutral: 'bg-surface text-ink',
};

interface ToastItemProps {
  entry: ToastEntry;
  onDismiss: (id: string) => void;
}

/**
 * A single toast. Owns its auto-dismiss timer and pauses it whenever the toast
 * is hovered (pointer) or contains keyboard focus, so a reader of the message —
 * by mouse or keyboard — is never raced by the clock.
 */
function ToastItem({ entry, onDismiss }: ToastItemProps): React.ReactElement {
  const { id, message, tone = 'neutral', action, duration = DEFAULT_DURATION } = entry;

  // Refs so the timer effect never re-subscribes as paused-state toggles.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);

  const dismiss = useCallback(() => {
    onDismiss(id);
  }, [id, onDismiss]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    if (duration === Number.POSITIVE_INFINITY) {
      return;
    }
    timerRef.current = setTimeout(dismiss, duration);
  }, [clearTimer, dismiss, duration]);

  // Start the countdown after mount, and tear any pending timer down on
  // unmount. `startTimer`/`clearTimer` are stable for a fixed `duration`, so
  // this runs once for the lifetime of a given toast.
  useEffect(() => {
    startTimer();
    return clearTimer;
  }, [startTimer, clearTimer]);

  const pause = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const resumeIfIdle = useCallback(() => {
    if (!hoveredRef.current && !focusedRef.current) {
      startTimer();
    }
  }, [startTimer]);

  const handleMouseEnter = useCallback(() => {
    hoveredRef.current = true;
    pause();
  }, [pause]);

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = false;
    resumeIfIdle();
  }, [resumeIfIdle]);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
    pause();
  }, [pause]);

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      // Only treat focus *leaving the whole toast* as a blur; focus moving
      // between the action and dismiss button must keep the timer paused.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      focusedRef.current = false;
      resumeIfIdle();
    },
    [resumeIfIdle],
  );

  const handleAction = useCallback(() => {
    action?.onAction();
    dismiss();
  }, [action, dismiss]);

  const icon = tone === 'neutral' ? null : toneIcons[tone];

  return (
    // No nested live role here: the surrounding viewport region (below) is the
    // single `aria-live` announcer, so each added toast is read exactly once.
    <div
      data-toast=""
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-line px-4 py-3 shadow-lg',
        toneSurface[tone],
      )}
    >
      {icon ? <Icon name={icon} className="mt-0.5 size-5" /> : null}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <p className="min-w-0 flex-1 break-words text-sm">{message}</p>
        {action ? (
          <button
            type="button"
            onClick={handleAction}
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="-me-1 -mt-1 inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Icon name="x" className="size-5" />
      </button>
    </div>
  );
}

/**
 * Provider for the toast system. Renders an `aria-live="polite"`,
 * `aria-atomic="false"` viewport pinned to the bottom-centre edge (never over
 * critical UI) at the `z-toast` layer, and exposes `useToast()` to descendants.
 */
export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idBase = useId();
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = `${idBase}-${counterRef.current++}`;
      setToasts((current) => [...current, { ...options, id }]);
    },
    [idBase],
  );

  const value = useMemo<ToastContextValue>(() => ({ toast }), [toast]);

  const region = (
    <div
      // The live region itself is the announcer: polite (won't interrupt the
      // current task) and non-atomic (only the newly added toast is read, not
      // the whole stack). Bottom-centre, edge-pinned so it never obscures
      // critical UI, and at the dedicated toast stacking layer.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-toast flex flex-col items-center gap-2 p-4"
    >
      {toasts.map((entry) => (
        <div key={entry.id} className="w-full max-w-sm">
          <ToastItem entry={entry} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' ? createPortal(region, document.body) : region}
    </ToastContext.Provider>
  );
}

/** Access the imperative toast API. Must be called under a {@link ToastProvider}. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
