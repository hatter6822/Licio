// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, type RefObject, useId } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../hooks/useFocusTrap.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog; rendered as the heading and linked via aria-labelledby. */
  title: string;
  children: ReactNode;
  /** Optional id of a description element for aria-describedby. */
  describedById?: string;
  /** Dismiss when the backdrop is clicked (default true). */
  closeOnBackdrop?: boolean;
  /** Element to focus on open; defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  describedById,
  closeOnBackdrop = true,
  initialFocusRef,
  className,
}: DialogProps): React.ReactPortal | null {
  const titleId = useId();
  const trapRef = useFocusTrap<HTMLDivElement>(open, {
    onEscape: onClose,
    ...(initialFocusRef ? { initialFocusRef } : {}),
  });

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center p-4">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        className={cn(
          'relative z-modal flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-auto rounded-lg border border-line bg-canvas p-6 shadow-lg',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-xl font-semibold text-ink">
            {title}
          </h2>
          <Button iconOnly variant="ghost" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
