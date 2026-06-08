import { useAppStore } from './state/app-store.js';

export function App() {
  const hasAcceptedSecurityNotice = useAppStore((state) => state.hasAcceptedSecurityNotice);
  const acceptSecurityNotice = useAppStore((state) => state.acceptSecurityNotice);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-12">
      <section className="rounded-2xl border border-[var(--licio-color-border)] bg-white/70 p-8 shadow-sm dark:bg-gray-900/70">
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--licio-color-accent)]">
          Repository foundation
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">Licio</h1>
        <p className="mt-4 text-lg leading-8">
          A mobile-first PWA social news and forum platform without likes, upvotes, or pay-to-rank
          mechanics. This baseline is intentionally minimal while the secure development
          environment, CSP, PWA shell, and typed package boundaries are established.
        </p>
        <button
          className="mt-6 rounded-xl bg-[var(--licio-color-accent)] px-5 py-3 font-semibold text-white"
          type="button"
          onClick={acceptSecurityNotice}
        >
          Acknowledge secure baseline
        </button>
        <p className="mt-4" aria-live="polite">
          Security notice: {hasAcceptedSecurityNotice ? 'acknowledged' : 'pending'}.
        </p>
      </section>
    </main>
  );
}
