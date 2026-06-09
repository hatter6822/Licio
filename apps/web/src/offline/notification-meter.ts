// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Notification budget meter (WS-C.2.4c, SPEC §6.7). A per-day count of
// notifications actually SHOWN, so the budget indicator reflects real volume
// rather than a placeholder. The service worker increments the count when it
// displays a push (the same logic, inlined in plain JS in sw-push.js); the
// settings UI reads today's count. Kept in a tiny dedicated IndexedDB
// (`licio-meter`) so it never touches the main schema/migrations. Days are
// bucketed in UTC so the worker and the client always agree. Counts only — never
// notification contents.
const METER_DB = 'licio-meter';
const METER_STORE = 'counts';

interface DayCount {
  day: string;
  count: number;
}

/** UTC day bucket (YYYY-MM-DD) shared by the worker and the client. */
function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function openMeterDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(METER_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(METER_STORE, { keyPath: 'day' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('meter open failed'));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('meter request failed'));
  });
}

/** Today's count of notifications shown; 0 when unavailable. */
export async function readNotificationsUsedToday(): Promise<number> {
  if (typeof indexedDB === 'undefined') return 0;
  try {
    const db = await openMeterDb();
    const record = await idbRequest<DayCount | undefined>(
      db.transaction(METER_STORE, 'readonly').objectStore(METER_STORE).get(utcDay()),
    );
    db.close();
    return record?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Record that one notification was shown (mirrors the SW's inline increment).
 * Best-effort: storage failure is non-fatal for the budget indicator.
 */
export async function recordNotificationShown(at: Date = new Date()): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openMeterDb();
    const day = utcDay(at);
    const existing = await idbRequest<DayCount | undefined>(
      db.transaction(METER_STORE, 'readonly').objectStore(METER_STORE).get(day),
    );
    const count = (existing?.count ?? 0) + 1;
    await idbRequest(
      db.transaction(METER_STORE, 'readwrite').objectStore(METER_STORE).put({ day, count }),
    );
    db.close();
  } catch {
    // Non-fatal.
  }
}
