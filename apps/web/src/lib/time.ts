// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Time conversions for the quiet-hours UI (WS-C.2.4c). The notification schema
// stores minutes-from-midnight (exact wraparound math); the WS-B.2.8c control
// uses "HH:MM" (matching <input type="time">). These two helpers bridge them.

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
