// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.1e published support contact.  Reachable WITHOUT authentication (so a
// locked-out user can still reach support), it shows the safety email, the help
// centre, and jurisdiction-appropriate emergency resources.  External links open
// with rel="noopener" and are part of the strict-CSP allowlist.
import { useQuery } from '@tanstack/react-query';
import { useT } from '../../i18n/I18nProvider.js';
import { queryKeys } from '../../lib/query-keys.js';
import { fetchSupportContact } from '../../lib/safety-api.js';

export function SupportContact(): React.ReactElement {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.supportContact(),
    queryFn: fetchSupportContact,
    staleTime: 60 * 60 * 1000,
  });

  return (
    // The page header (PageHeader in the route page) owns the visible <h1>;
    // this section carries an accessible name only.
    <section aria-label={t('support.title', 'Get help')} className="flex flex-col gap-4">
      {isLoading ? <p className="text-ink-muted">{t('common.loading', 'Loading…')}</p> : null}
      {isError ? (
        <p className="text-ink-muted">
          {t('support.fallback', 'Email')}{' '}
          <a className="text-primary underline" href="mailto:safety@licio.app">
            safety@licio.app
          </a>
        </p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-line bg-canvas p-4">
            <h2 className="mb-1 font-medium text-ink">{t('support.safetyTeam', 'Safety team')}</h2>
            <a className="text-primary underline" href={`mailto:${data.safety_email}`}>
              {data.safety_email}
            </a>
          </div>
          <div className="rounded-lg border border-line bg-canvas p-4">
            <h2 className="mb-1 font-medium text-ink">{t('support.helpCenter', 'Help centre')}</h2>
            <a
              className="text-primary underline"
              href={data.help_center_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {data.help_center_url}
            </a>
          </div>
          {data.emergency_resources.length > 0 ? (
            <div className="rounded-lg border border-line bg-canvas p-4">
              <h2 className="mb-2 font-medium text-ink">
                {t('support.emergency', 'Emergency resources')}
              </h2>
              <ul className="flex flex-col gap-3">
                {data.emergency_resources.map((resource) => (
                  <li key={resource.label}>
                    <p className="font-medium text-ink">{resource.label}</p>
                    <p className="text-sm text-ink-muted">{resource.description}</p>
                    <div className="mt-1 flex flex-wrap gap-3 text-sm">
                      {resource.phone ? (
                        <a className="text-primary underline" href={`tel:${resource.phone}`}>
                          {resource.phone}
                        </a>
                      ) : null}
                      {resource.url ? (
                        <a
                          className="text-primary underline"
                          href={resource.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('support.visit', 'Visit')}
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
