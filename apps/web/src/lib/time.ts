// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Time utilities. The quiet-hours UI (WS-C.2.4c) bridges minutes-from-midnight
// (exact wraparound math) and "HH:MM" (matching <input type="time">); the
// comment meta line (WS-T.7.3) renders a compact relative timestamp.

/**
 * Compact relative timestamp for dense UIs — "now", "5m", "2h", "3d", "2w",
 * "4mo", "1y" — so a comment's meta line stays a single short row.  The full
 * LOCALIZED timestamp is surfaced separately (the `<time>` element's `title`),
 * so no information is lost; this is purely the at-a-glance form.  Pure in
 * `now` for deterministic tests.  Future instants (clock skew) clamp to "now".
 */
export function relativeTimeShort(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.round((now - then) / 1000); // > 0 ⇒ in the past
  if (sec < 45) return 'now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(day / 365)}y`;
}

/** Minutes-from-midnight → "HH:MM" (24-hour, zero-padded). Normalises range. */
export function minutesToHHMM(minutes: number): string {
  const normalized = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** "HH:MM" → minutes-from-midnight (0..1439). Malformed input ⇒ 0. */
export function hhmmToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  const hours = Math.min(23, Number(match[1]));
  const mins = Math.min(59, Number(match[2]));
  return hours * 60 + mins;
}
