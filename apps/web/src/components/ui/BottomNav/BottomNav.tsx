// SPDX-License-Identifier: AGPL-3.0-or-later
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../Icon/index.js';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  /** Centered, visually prominent contribution entry point (the Submit tab). */
  prominent?: boolean;
}

export interface BottomNavProps {
  items: NavItem[];
  /** id of the active route; gets aria-current="page". */
  activeId?: string;
  className?: string;
}

/**
 * Primary navigation (WS-B.1.5). Thumb-zone bottom bar on mobile, side rail on
 * lg+. Icons are ALWAYS paired with text labels (never icon-only). The Submit
 * tab is a contribution entry point — never a "post for applause" prompt.
 */
export function BottomNav({ items, activeId, className }: BottomNavProps): React.ReactElement {
  const t = useT();
  return (
    <nav
      aria-label={t('nav.primary', 'Primary navigation')}
      className={cn(
        'fixed inset-x-0 bottom-0 z-sticky border-t border-line bg-canvas pb-[env(safe-area-inset-bottom)] lg:static lg:h-full lg:w-56 lg:border-t-0 lg:border-e lg:pb-0',
        className,
      )}
    >
      <ul className="flex items-stretch justify-around lg:flex-col lg:gap-1 lg:p-2">
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <li key={item.id} className="flex-1 lg:flex-none">
              <a
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex min-h-touch flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:flex-row lg:justify-start lg:gap-3 lg:py-2 lg:text-base',
                  isActive ? 'text-primary-on-soft' : 'text-ink-muted hover:text-ink',
                  item.prominent && 'text-primary',
                )}
              >
                <Icon name={item.icon} className={cn('size-6', item.prominent && 'size-7')} />
                <span>{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The five standard primary-nav tabs (WS-C supplies real hrefs/active state). */
export function defaultNavItems(t: ReturnType<typeof useT>): NavItem[] {
  return [
    { id: 'front-page', label: t('nav.frontPage', 'Front Page'), icon: 'home', href: '/' },
    { id: 'rooms', label: t('nav.rooms', 'Rooms'), icon: 'grid', href: '/rooms' },
    {
      id: 'submit',
      label: t('nav.submit', 'Submit'),
      icon: 'pencil',
      href: '/submit',
      prominent: true,
    },
    { id: 'threads', label: t('nav.threads', 'Threads'), icon: 'threads', href: '/threads' },
    { id: 'profile', label: t('nav.profile', 'Profile'), icon: 'user', href: '/profile' },
  ];
}
