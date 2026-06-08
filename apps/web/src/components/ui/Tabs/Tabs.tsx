// SPDX-License-Identifier: AGPL-3.0-or-later
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../Icon/index.js';

export interface TabDescriptor {
  id: string;
  label: string;
  icon?: IconName;
}

export interface TabsProps {
  tabs: TabDescriptor[];
  /** Accessible name for the tablist. */
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /** 'automatic' selects on arrow focus; 'manual' requires Enter/Space. */
  activationMode?: 'automatic' | 'manual';
  /** Renders the active panel — only the active one is mounted (lazy-friendly). */
  children: (activeId: string) => ReactNode;
  className?: string;
}

export function Tabs({
  tabs,
  label,
  value,
  defaultValue,
  onValueChange,
  activationMode = 'automatic',
  children,
  className,
}: TabsProps): React.ReactElement {
  const baseId = useId();
  const firstId = tabs[0]?.id ?? '';
  const [internalValue, setInternalValue] = useState(defaultValue ?? firstId);
  const selectedId = value ?? internalValue;
  const [focusedId, setFocusedId] = useState(selectedId);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const tabId = (id: string): string => `${baseId}-tab-${id}`;
  const panelId = (id: string): string => `${baseId}-panel-${id}`;

  const select = (id: string): void => {
    if (value === undefined) setInternalValue(id);
    onValueChange?.(id);
  };

  const focusTab = (id: string): void => {
    setFocusedId(id);
    tabRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = tabs.findIndex((t) => t.id === focusedId);
    if (index === -1) return;
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      case 'Enter':
      case ' ':
        if (activationMode === 'manual') {
          event.preventDefault();
          select(focusedId);
        }
        return;
      default:
        return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const next = tabs[nextIndex];
      if (!next) return;
      focusTab(next.id);
      if (activationMode === 'automatic') select(next.id);
    }
  };

  return (
    <div className={cn('flex flex-col', className)}>
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {tabs.map((tab) => {
          const isSelected = tab.id === selectedId;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={isSelected}
              aria-controls={panelId(tab.id)}
              tabIndex={tab.id === focusedId ? 0 : -1}
              onClick={() => {
                setFocusedId(tab.id);
                select(tab.id);
              }}
              onKeyDown={onKeyDown}
              className={cn(
                'inline-flex min-h-touch items-center gap-2 whitespace-nowrap border-b-2 px-4 text-base font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                isSelected
                  ? 'border-primary text-primary-on-soft'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {tab.icon ? <Icon name={tab.icon} className="size-4" /> : null}
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={panelId(selectedId)}
        aria-labelledby={tabId(selectedId)}
        tabIndex={0}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {children(selectedId)}
      </div>
    </div>
  );
}
