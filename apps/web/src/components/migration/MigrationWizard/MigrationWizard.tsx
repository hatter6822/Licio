// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the server-room → Private-P2P-room migration wizard (PRIVATE_SPEC
// §24).  A Members-only server room is NEVER upgraded in place; this 6-phase
// flow drives the migration step by step using the `@licio/shared` copy SSOT
// (`PRIVATE_ROOM_MIGRATION_PHASES`, `PRIVATE_ROOM_MIGRATION_WARNING`,
// `PRIVATE_ROOM_IMPORT_MODES`) — never re-worded here, pinned by the
// prohibited-language copy-lint so the UI can never imply migration retroactively
// erases past server access.
//
//   1. Rename & disclose   — render the §20.1 OLD-room label + the BLOCKING §24.3
//                            leakage warning; acknowledge before continuing.
//   2. Create P2P room     — `PrivateRoomSession.create` (lazy crypto core).
//   3. Choose import mode  — Fresh/Selected/Full/Redacted → `planMigration` →
//                            re-author into the P2P room (encrypts locally).
//   4. Re-invite members   — server membership grants no P2P access; the
//                            `InvitePanel` mints HPKE-sealed invites.
//   5. Freeze old room     — server-enforced READ-ONLY (fail-closed).
//   6. Purge / minimize    — server-enforced, gated on the freeze.
//
// The destructive server steps (freeze/purge) are server-enforced; creation +
// re-authoring are client-local.  The BLOCKING disclosure renders in phase 1
// before any destructive step.  Loaded by the `/private/migrate` route, which
// reaches the crypto core only through the session manager's dynamic import.

import type { MigrationExportResponse, MigrationImportMode } from '@licio/shared';
import {
  PRIVATE_ROOM_IMPORT_MODES,
  PRIVATE_ROOM_MIGRATION_PHASES,
  PRIVATE_ROOM_MIGRATION_WARNING,
  ROOM_CLASS_UI_LABELS,
} from '@licio/shared';
import { useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import {
  fetchMigrationExport,
  freezeMigratedRoom,
  purgeMigratedRoom,
  reauthorIntoPrivateRoom,
} from '../../../private-p2p/migrate.js';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { InvitePanel } from '../../private-rooms/InvitePanel/index.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { Checkbox } from '../../ui/Checkbox/index.js';
import { Input } from '../../ui/Input/index.js';
import { RadioGroup } from '../../ui/RadioGroup/index.js';
import {
  clearMigrationProgress,
  loadMigrationProgress,
  saveMigrationProgress,
} from './migration-progress.js';

const PHASE_COUNT = PRIVATE_ROOM_MIGRATION_PHASES.length;

export interface MigrationWizardProps {
  /** The OLD Members-only server room id being migrated. */
  sourceRoomId: string;
  onComplete?: (newRoomId: string) => void;
}

type Phase = 0 | 1 | 2 | 3 | 4 | 5;

export function MigrationWizard({
  sourceRoomId,
  onComplete,
}: MigrationWizardProps): React.ReactElement {
  const t = useT();
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Phase 1 — disclosure acknowledgment + the loaded export.
  const [acked, setAcked] = useState(false);
  const [exportData, setExportData] = useState<MigrationExportResponse | null>(null);

  // Phase 2 — the new P2P room.
  const [roomName, setRoomName] = useState('');
  const [session, setSession] = useState<PrivateRoomSession | null>(null);

  // Phase 3 — import scope.
  const [mode, setMode] = useState<MigrationImportMode>('fresh');
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [importDisclosure, setImportDisclosure] = useState<string | null>(null);

  // Phase 6 — purge mode.
  const [purgeMode, setPurgeMode] = useState<'purge' | 'anonymize'>('anonymize');
  const [done, setDone] = useState(false);

  // Resumability — a migration left mid-flow whose destination lives on ANOTHER
  // device (this device's IndexedDB has no copy): the source may already be
  // frozen, so we surface an honest "resume on the original device" notice
  // instead of silently re-creating a SECOND P2P room.
  const [strandedDestination, setStrandedDestination] = useState<string | null>(null);

  // Persist the flow progress on every change so a reload resumes (the destructive
  // server steps + the client-local destination make this mandatory, finding #54).
  function persist(over: Partial<Parameters<typeof saveMigrationProgress>[0]>): void {
    saveMigrationProgress({
      sourceRoomId,
      phase,
      destinationRoomId: session?.roomId ?? null,
      mode,
      purgeMode,
      acked,
      ...over,
    });
  }

  // Load the OLD room's export on mount, then RESUME any interrupted migration:
  // the server records `frozen` + `migrated_to_room_id`, and local progress
  // records the phase; if a destination exists on THIS device, re-open it and
  // jump to the recorded phase rather than stranding the source frozen.
  //
  // Resume is a one-shot bootstrap keyed by the source room: the setters + `t`
  // are intentionally excluded so a render does not re-run the resume probe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let data: MigrationExportResponse;
      try {
        data = await fetchMigrationExport(sourceRoomId);
      } catch {
        if (!cancelled) {
          setError(t('migration.load.error', 'Could not load this room for migration.'));
        }
        return;
      }
      if (cancelled) return;
      setExportData(data);
      setRoomName(data.room_name);

      const saved = loadMigrationProgress(sourceRoomId);
      // The destination id the server recorded at freeze takes precedence (it
      // survives a cleared localStorage); the local progress fills pre-freeze gaps.
      const destinationRoomId = data.migrated_to_room_id ?? saved?.destinationRoomId ?? null;
      if (destinationRoomId === null) {
        // Nothing created yet; restore any pre-create choices and start fresh.
        if (saved !== undefined) {
          setMode(saved.mode);
          setPurgeMode(saved.purgeMode);
          setAcked(saved.acked);
          setPhase(saved.phase < 1 ? saved.phase : 1);
        }
        return;
      }

      // A destination was created — try to re-open it on THIS device.
      const reopened = await PrivateRoomSession.load(destinationRoomId);
      if (cancelled) return;
      if (reopened === null) {
        // The destination is not on this device (created elsewhere). The source
        // may already be frozen, so do NOT create a second room — surface the
        // honest resume-elsewhere notice.
        setStrandedDestination(destinationRoomId);
        if (saved !== undefined) {
          setMode(saved.mode);
          setPurgeMode(saved.purgeMode);
        }
        return;
      }
      setSession(reopened);
      if (saved !== undefined) {
        setMode(saved.mode);
        setPurgeMode(saved.purgeMode);
        setAcked(true);
      }
      // Resume at the recorded phase (at least past create), or post-freeze if the
      // server says the room is already frozen.
      const resumePhase: Phase = data.frozen ? 5 : ((saved?.phase ?? 2) as Phase);
      setPhase(Math.min(PHASE_COUNT - 1, Math.max(2, resumePhase)) as Phase);
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceRoomId]);

  function advance(): void {
    setError(null);
    setPhase((p) => {
      const next = Math.min(PHASE_COUNT - 1, p + 1) as Phase;
      persist({ phase: next });
      return next;
    });
  }

  async function createDestination(): Promise<void> {
    if (roomName.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await PrivateRoomSession.create({
        roomName: roomName.trim(),
        roomType: 'global_topic',
        founderMemberId: globalThis.crypto.randomUUID(),
        founderDeviceId: globalThis.crypto.randomUUID(),
      });
      setSession(created);
      // Persist the created destination BEFORE advancing so a reload right after
      // creation can re-open it (the room is already durable in IndexedDB).
      persist({ destinationRoomId: created.roomId, phase: 2, acked: true });
      advance();
    } catch {
      setError(t('migration.create.error', 'Could not create the new Private P2P room.'));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(): Promise<void> {
    if (session === null || exportData === null) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = Object.entries(selectedIds)
        .filter(([, v]) => v)
        .map(([id]) => id);
      const result = await reauthorIntoPrivateRoom({
        session,
        export: exportData,
        mode,
        ...(mode === 'selected' ? { selectedIds: chosen } : {}),
      });
      setImportDisclosure(result.disclosure);
      advance();
    } catch {
      setError(t('migration.import.error', 'Could not import the selected content.'));
    } finally {
      setBusy(false);
    }
  }

  async function freeze(): Promise<void> {
    if (session === null) return;
    setBusy(true);
    setError(null);
    try {
      await freezeMigratedRoom(sourceRoomId, session.roomId);
      advance();
    } catch {
      setError(t('migration.freeze.error', 'Could not freeze the old room.'));
    } finally {
      setBusy(false);
    }
  }

  async function purge(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await purgeMigratedRoom(sourceRoomId, purgeMode);
      setDone(true);
      // Migration complete — clear the resume state + authored manifest so a
      // future migration of the same room starts clean.
      clearMigrationProgress(sourceRoomId, session?.roomId);
      if (session !== null) onComplete?.(session.roomId);
    } catch {
      setError(t('migration.purge.error', 'Could not minimize the old room content.'));
    } finally {
      setBusy(false);
    }
  }

  const oldLabel = exportData?.room_label ?? ROOM_CLASS_UI_LABELS.restricted_server;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="font-semibold text-lg">
        {t('migration.title', 'Migrate to a Private P2P room')}
      </h2>

      {/* The step indicator (SSOT phase labels). */}
      <ol className="flex flex-col gap-1 text-sm" aria-label={t('migration.steps', 'Steps')}>
        {PRIVATE_ROOM_MIGRATION_PHASES.map((p, index) => (
          <li
            key={p.id}
            aria-current={index === phase ? 'step' : undefined}
            className={index === phase ? 'font-semibold text-ink' : 'text-ink-muted'}
          >
            {index + 1}. {p.label} — {p.detail}
          </li>
        ))}
      </ol>

      {error !== null ? (
        <p className="text-error-on-soft text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {/* Resumability — the destination P2P room lives on another device (this
          device's local store has no copy). The source may already be frozen, so
          we must NOT create a SECOND room; resume on the original device. */}
      {strandedDestination !== null ? (
        <Card>
          <div className="flex flex-col gap-3">
            <p className="text-sm" role="status">
              {t(
                'migration.resume.elsewhere',
                'This migration was started on another device, where the new Private P2P room and its keys live. Continue the migration there. A Private P2P room cannot be re-opened on a device that does not hold its keys.',
              )}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                clearMigrationProgress(sourceRoomId, strandedDestination);
                setStrandedDestination(null);
                setPhase(0);
              }}
            >
              {t('migration.resume.startOver', 'Start a fresh migration on this device')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Phase 1 — rename & disclose (the BLOCKING §24.3 warning). */}
      {strandedDestination === null && phase === 0 ? (
        <Card>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t('migration.phase1.intro', 'The old room is a {label}.', { label: oldLabel })}
            </p>
            {/* Verbatim, blocking — the prohibited-language-linted SSOT. */}
            <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
              {PRIVATE_ROOM_MIGRATION_WARNING}
            </p>
            <Checkbox
              label={t(
                'migration.phase1.ack',
                'I understand migration improves privacy going forward but cannot undo past server access.',
              )}
              checked={acked}
              onCheckedChange={(checked) => {
                setAcked(checked);
                persist({ acked: checked });
              }}
            />
            <Button
              type="button"
              variant="primary"
              disabled={!acked || exportData === null}
              onClick={advance}
            >
              {t('migration.phase1.next', 'Continue')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Phase 2 — create the P2P destination. */}
      {strandedDestination === null && phase === 1 ? (
        <Card>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t(
                'migration.phase2.intro',
                'A new Private P2P room is created on your device — keys and manifest are generated locally.',
              )}
            </p>
            <Input
              label={t('migration.phase2.name', 'New room name')}
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              required
            />
            <Button
              type="button"
              variant="primary"
              disabled={busy || roomName.trim().length === 0}
              onClick={() => void createDestination()}
            >
              {busy
                ? t('migration.phase2.creating', 'Creating…')
                : t('migration.phase2.create', 'Create Private P2P room')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Phase 3 — choose import mode + re-author. */}
      {strandedDestination === null && phase === 2 ? (
        <Card>
          <div className="flex flex-col gap-3">
            <RadioGroup
              label={t('migration.phase3.mode', 'What should be imported?')}
              value={mode}
              onValueChange={(v) => {
                const next = v as MigrationImportMode;
                setMode(next);
                persist({ mode: next });
              }}
              options={PRIVATE_ROOM_IMPORT_MODES.map((m) => ({
                value: m.id,
                label: `${m.label} — ${m.description}`,
              }))}
            />
            {/* Each mode's honest leakage disclosure (SSOT). */}
            <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
              {PRIVATE_ROOM_IMPORT_MODES.find((m) => m.id === mode)?.disclosure ?? ''}
            </p>

            {mode === 'selected' && exportData !== null ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="font-medium text-sm">
                  {t('migration.phase3.select', 'Select stories to import')}
                </legend>
                {exportData.items
                  .filter((item) => item.kind === 'story')
                  .map((item) => (
                    <Checkbox
                      key={item.id}
                      label={item.title ?? item.id}
                      checked={selectedIds[item.id] === true}
                      onCheckedChange={(checked) =>
                        setSelectedIds((prev) => ({ ...prev, [item.id]: checked }))
                      }
                    />
                  ))}
              </fieldset>
            ) : null}

            <Button
              type="button"
              variant="primary"
              disabled={busy || session === null}
              onClick={() => void runImport()}
            >
              {busy
                ? t('migration.phase3.importing', 'Importing…')
                : t('migration.phase3.import', 'Import and continue')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Phase 4 — re-invite members. */}
      {strandedDestination === null && phase === 3 ? (
        <Card>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t(
                'migration.phase4.intro',
                'Server membership does not grant Private P2P access — invite each member again. They join with a fresh invite.',
              )}
            </p>
            {importDisclosure !== null ? (
              <p className="neu-inset rounded-lg p-3 text-ink-muted text-sm" role="note">
                {importDisclosure}
              </p>
            ) : null}
            {session !== null ? <InvitePanel session={session} /> : null}
            <Button type="button" variant="primary" onClick={advance}>
              {t('migration.phase4.next', 'Continue to freeze the old room')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Phase 5 — freeze the old room (server-enforced read-only). */}
      {strandedDestination === null && phase === 4 ? (
        <Card>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t(
                'migration.phase5.intro',
                'Freezing makes the old server room read-only: it stops accepting new posts and comments and points to the Private P2P replacement.',
              )}
            </p>
            <Button
              type="button"
              variant="primary"
              disabled={busy || session === null}
              onClick={() => void freeze()}
            >
              {busy
                ? t('migration.phase5.freezing', 'Freezing…')
                : t('migration.phase5.freeze', 'Freeze the old room')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Phase 6 — purge / minimize. */}
      {strandedDestination === null && phase === 5 ? (
        <Card>
          <div className="flex flex-col gap-3">
            {done ? (
              <p className="text-sm" role="status">
                {t(
                  'migration.phase6.done',
                  'Migration complete. The old server content has been minimized; the conversation continues in the Private P2P room.',
                )}
              </p>
            ) : (
              <>
                <p className="text-sm">
                  {t(
                    'migration.phase6.intro',
                    'Where policy and law permit, the old server data can be purged or minimized. This cannot affect copies members already downloaded.',
                  )}
                </p>
                <RadioGroup
                  label={t('migration.phase6.mode', 'How should the old content be minimized?')}
                  value={purgeMode}
                  onValueChange={(v) => {
                    const next = v as 'purge' | 'anonymize';
                    setPurgeMode(next);
                    persist({ purgeMode: next });
                  }}
                  options={[
                    {
                      value: 'anonymize',
                      label: t(
                        'migration.phase6.anonymize',
                        'Anonymize — detach your authorship, keep content readable.',
                      ),
                    },
                    {
                      value: 'purge',
                      label: t(
                        'migration.phase6.purge',
                        'Purge — take the old stories down and remove your authored content.',
                      ),
                    },
                  ]}
                />
                <Button
                  type="button"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void purge()}
                >
                  {busy
                    ? t('migration.phase6.working', 'Minimizing…')
                    : t('migration.phase6.finish', 'Finish migration')}
                </Button>
              </>
            )}
          </div>
        </Card>
      ) : null}
    </section>
  );
}
