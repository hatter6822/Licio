// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.1/5.2 — the story-submission composer (the content half of the submit
// flow; the WS-G contribution composer handles thread replies). It hosts:
//   • a REQUIRED home-room picker (Commons default; postable rooms; non-postable
//     rooms shown with the reason and submit disabled) — WS-Q.5.1a;
//   • a public/in-room visibility control whose shown value equals the SHARED
//     deriveStoryVisibility output, LOCKED to in-room for private rooms — WS-Q.5.1b;
//   • four modes — link, brief, image post, video post (WS-Q.5.2a/b): images
//     require alt text; videos take captions as text XOR an upload and are
//     size/duration pre-checked against the server caps before upload begins.
// Media is uploaded through the scan-gated path first; a still-pending scan is
// surfaced as "pending a safety check", never as a failure.
import {
  COMMONS_ROOM_ID,
  deriveStoryVisibility,
  type StoryCreateRequest,
  UPLOAD_IMAGE_TYPES,
  UPLOAD_VIDEO_TYPES,
} from '@licio/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError, createStory, uploadMedia } from '../../../lib/api.js';
import { useRoomsQuery } from '../../../lib/queries.js';
import {
  type DraftStoryRecord,
  deleteStoryDraft,
  listStoryDrafts,
  type StoryDraftMode,
  saveStoryDraft,
} from '../../../offline/index.js';
import { selectContentSurface, useFeatureFlagStore } from '../../../stores/index.js';
import { Button } from '../../ui/Button/index.js';
import { Input } from '../../ui/Input/index.js';
import { RadioGroup } from '../../ui/RadioGroup/index.js';
import { Select } from '../../ui/Select/index.js';
import { TextArea } from '../../ui/TextArea/index.js';

/** The composer modes are exactly the persisted story-draft modes (one SSOT). */
export type StoryComposerMode = StoryDraftMode;

export interface StoryComposerResult {
  storyId: string;
  pendingScan: boolean;
}

export interface StoryComposerProps {
  onSubmitted?: (result: StoryComposerResult) => void;
  /** Share-target intake (WS-Q.5.1c): seed a link post from a shared URL/title. */
  share?: { url: string; title?: string };
}

/** Trailing autosave debounce (WS-Q.5.1b): one encrypt+write per pause. */
const DRAFT_DEBOUNCE_MS = 800;

function newStoryDraftId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `story-${crypto.randomUUID()}`
    : `story-${Date.now()}`;
}

/**
 * A same-origin object URL for a local preview. Returns ONLY a browser-minted
 * blob-scheme URL and rejects anything else as null. Callers ALSO re-assert the
 * `blob:` scheme with an allowlist guard right at the DOM sink (so the sanitizer
 * dominates the sink intra-procedurally). Such a URL on an `<img>`/`<video>`
 * `src` loads a resource — it can carry no script scheme, inject no markup, and
 * run no code.
 */
function blobObjectUrl(file: File): string | null {
  if (typeof URL.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  if (url.startsWith('blob:')) return url;
  URL.revokeObjectURL(url);
  return null;
}

/** Best-effort client duration probe (0 when the browser can't read metadata). */
function readVideoDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
      resolve(0);
      return;
    }
    const url = URL.createObjectURL(file);
    // Sanitize the URL AT THE SINK: only a browser `blob:` URL is ever assigned
    // to video.src — an allowlist guard dominating the sink in this function.
    if (!url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
      resolve(0);
      return;
    }
    const video = document.createElement('video');
    video.preload = 'metadata';
    let settled = false;
    const done = (seconds: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) ? seconds : 0);
    };
    // Undecodable/slow files must not block submit forever — skip the gate.
    const timer = setTimeout(() => done(0), 5_000);
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done(0);
    video.src = url;
  });
}

export function StoryComposer({ onSubmitted, share }: StoryComposerProps): React.ReactElement {
  const t = useT();
  const rooms = useRoomsQuery();
  const formId = useId();
  // WS-Q.6.2 — the fail-closed content surface gates media modes + the in-room
  // visibility choice, and supplies the real video caps for the pre-checks.
  const content = useFeatureFlagStore(selectContentSurface);

  const [mode, setMode] = useState<StoryComposerMode>('link');
  const [roomId, setRoomId] = useState<string>(COMMONS_ROOM_ID);
  const [requestedVisibility, setRequestedVisibility] = useState<'public' | 'room_only'>('public');
  // Share-target intake (WS-Q.5.1c): a shared URL/title seeds a link post.
  const [title, setTitle] = useState(share?.title ?? '');
  const [url, setUrl] = useState(share?.url ?? '');
  const [reason, setReason] = useState('');
  const [body, setBody] = useState('');
  const [altText, setAltText] = useState('');
  const [captionsText, setCaptionsText] = useState('');
  const [captionsFile, setCaptionsFile] = useState<File | null>(null);
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'uploading' | 'submitting' | 'done' | 'pending'>(
    'idle',
  );

  // WS-Q.5.1b — encrypted draft autosave. The composer owns its state, so it
  // persists through a dedicated store: structural fields (mode/room/visibility)
  // round-trip as metadata; the text body is AES-GCM-encrypted at rest (§6.8).
  // Files are NOT persisted — a restored draft keeps the text and the user
  // re-picks any media.
  const draftId = useRef(newStoryDraftId());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraft = useRef<Parameters<typeof saveStoryDraft>[0] | null>(null);
  const [recoverable, setRecoverable] = useState<DraftStoryRecord | null>(null);

  // The selected room and whether it can be POSTED to from the client's view
  // (a public room auto-joins on post; a private room must be joined first).
  const selectedRoom = useMemo(
    () => rooms.data?.items.find((r) => r.room_id === roomId) ?? null,
    [rooms.data, roomId],
  );
  const roomIsPrivate = selectedRoom?.visibility === 'private';
  // Postability comes from the server's precise `can_post` (posting_policy +
  // membership/steward); Commons is always postable (auto-joined public room).
  const postable = roomId === COMMONS_ROOM_ID || selectedRoom === null || selectedRoom.can_post;

  // WS-Q.6.2 — when the in-room-visibility flag is OFF, the author choice is
  // suppressed (the server forces public in public rooms; private rooms still
  // force room_only). The submitted value is then always `public`.
  const submittedVisibility = content.in_room_visibility_enabled ? requestedVisibility : 'public';
  // The DISPLAYED visibility equals the server-derived value (shared helper):
  // a private room forces room_only regardless of the requested value.
  const effectiveVisibility = deriveStoryVisibility(
    roomIsPrivate ? 'private' : 'public',
    submittedVisibility,
  );

  // Media modes appear only when the rollout flag is on; if a media mode is
  // selected and the flag flips off (rare), fall back to a link.
  useEffect(() => {
    if (!content.media_posts_enabled && (mode === 'image_post' || mode === 'video_post')) {
      setMode('link');
    }
  }, [content.media_posts_enabled, mode]);

  // WS-Q.5.2a — pick a file and (for image posts) build a client-side preview.
  // The object URL is revoked when it changes or on unmount (no leak).
  function onPickFile(picked: File | null): void {
    setFile(picked);
    setUploadPct(0);
    // Only a verified `blob:` object URL ever reaches the <img> src (scheme
    // guard; see blobObjectUrl).
    setPreviewUrl(picked !== null && mode === 'image_post' ? blobObjectUrl(picked) : null);
  }
  useEffect(() => {
    if (previewUrl === null) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Offer the most recent OTHER story draft for resume-or-discard (the one being
  // edited now is excluded). Runs once on mount, before autosave writes. Draft
  // I/O is best-effort: a missing/quota-blocked IndexedDB never breaks posting.
  useEffect(() => {
    let cancelled = false;
    void listStoryDrafts()
      .then((drafts) => {
        if (cancelled) return;
        setRecoverable(drafts.find((draft) => draft.draftId !== draftId.current) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Trailing-debounced autosave: an empty composer never writes a draft; each
  // pause persists the latest mode/room/visibility + text body (files excluded).
  useEffect(() => {
    const values = { title, url, reason, body, altText, captionsText };
    const hasContent = Object.values(values).some((value) => value.trim().length > 0);
    if (!hasContent) {
      latestDraft.current = null;
      return;
    }
    latestDraft.current = {
      draftId: draftId.current,
      mode,
      roomId,
      visibility: requestedVisibility,
      values,
    };
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      if (latestDraft.current) void saveStoryDraft(latestDraft.current).catch(() => undefined);
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [mode, roomId, requestedVisibility, title, url, reason, body, altText, captionsText]);

  // Flush the latest draft immediately on app backgrounding and on unmount, so a
  // half-written post is never lost between debounce ticks (WS-Q.5.1b).
  useEffect(() => {
    const flush = (): void => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (latestDraft.current) void saveStoryDraft(latestDraft.current).catch(() => undefined);
    };
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, []);

  // Resume a saved draft: adopt its id (continue editing it) and rehydrate the
  // structural fields + text so room + visibility round-trip exactly.
  function resumeDraft(draft: DraftStoryRecord): void {
    draftId.current = draft.draftId;
    setMode(draft.mode);
    setRoomId(draft.roomId);
    setRequestedVisibility(draft.visibility);
    setTitle(draft.values['title'] ?? '');
    setUrl(draft.values['url'] ?? '');
    setReason(draft.values['reason'] ?? '');
    setBody(draft.values['body'] ?? '');
    setAltText(draft.values['altText'] ?? '');
    setCaptionsText(draft.values['captionsText'] ?? '');
    setErrors({});
    onPickFile(null);
    setCaptionsFile(null);
    setPosterFile(null);
    setRecoverable(null);
  }

  function discardDraft(draft: DraftStoryRecord): void {
    void deleteStoryDraft(draft.draftId).catch(() => undefined);
    setRecoverable(null);
  }

  const roomOptions = useMemo(() => {
    const items = rooms.data?.items ?? [];
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    const push = (value: string, name: string, canPost: boolean): void => {
      if (seen.has(value)) return;
      seen.add(value);
      options.push({
        value,
        label: canPost
          ? name
          : t('storyComposer.room.cantPost', '{name} (you can’t post here)', { name }),
      });
    };
    push(COMMONS_ROOM_ID, t('storyComposer.room.commons', 'Commons'), true);
    for (const room of items) {
      push(room.room_id, room.name, room.can_post);
    }
    return options;
  }, [rooms.data, t]);

  const isMedia = mode === 'image_post' || mode === 'video_post';

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (title.trim().length === 0)
      next['title'] = t('storyComposer.err.title', 'A title is required.');
    if (!postable) {
      next['room'] = t('storyComposer.err.room', 'Join this room before posting here.');
    }
    if (mode === 'link' && url.trim().length === 0) {
      next['url'] = t('storyComposer.err.url', 'A link URL is required.');
    }
    if (mode === 'link' && reason.trim().length === 0) {
      next['reason'] = t('storyComposer.err.reason', 'Add a short reason for this link.');
    }
    if (mode === 'original_brief' && body.trim().length === 0) {
      next['body'] = t('storyComposer.err.body', 'Write a brief before submitting.');
    }
    if (isMedia && file === null) {
      next['file'] = t('storyComposer.err.file', 'Choose a file to upload.');
    }
    if (mode === 'image_post' && altText.trim().length === 0) {
      next['altText'] = t('storyComposer.err.alt', 'Images require alternative text.');
    }
    if (mode === 'video_post' && file !== null && file.size > content.video_max_bytes) {
      next['file'] = t('storyComposer.err.videoSize', 'This video exceeds the size limit.');
    }
    // Captions are text XOR an uploaded track — never both (mirrors the schema).
    if (mode === 'video_post' && captionsText.trim().length > 0 && captionsFile !== null) {
      next['captions'] = t(
        'storyComposer.err.captionsXor',
        'Provide captions as text OR a file, not both.',
      );
    }
    return next;
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const found = validate();
    // Video duration is an async, best-effort pre-check against the SERVER cap
    // (skipped when the browser can't read metadata; the server is authoritative).
    // Only probe when nothing else is already wrong (avoids a needless wait).
    if (
      Object.keys(found).length === 0 &&
      mode === 'video_post' &&
      file !== null &&
      (await readVideoDurationSeconds(file)) > content.video_max_seconds
    ) {
      found['file'] = t('storyComposer.err.videoLength', 'This video exceeds the length limit.');
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // WS-Q.5.5 — persist the EXACT submitted state before networking. Stories are
    // draft-preserved, never queued to a default room: if the post fails (offline
    // or a server error) the precise draft (room + visibility + text) survives for
    // retry, surfaced by the resume prompt — never lost, never auto-posted.
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    await saveStoryDraft({
      draftId: draftId.current,
      mode,
      roomId,
      visibility: requestedVisibility,
      values: { title, url, reason, body, altText, captionsText },
    }).catch(() => undefined);

    try {
      const topicIds = [crypto.randomUUID()]; // WS-K taxonomy seam: a placeholder topic.
      let uploadId: string | null = null;
      if (isMedia && file !== null) {
        setStatus('uploading');
        setUploadPct(0);
        const upload = await uploadMedia(
          file,
          mode === 'image_post' ? altText.trim() : undefined,
          (f) => setUploadPct(f),
        );
        uploadId = upload.upload_id;
      }
      setStatus('submitting');
      const base = {
        title: title.trim(),
        room_id: roomId,
        visibility: submittedVisibility,
        topic_ids: topicIds,
      };
      let request: StoryCreateRequest;
      if (mode === 'link') {
        request = { submission_type: 'link', url: url.trim(), reason: reason.trim(), ...base };
      } else if (mode === 'original_brief') {
        request = { submission_type: 'original_brief', body: body.trim(), ...base };
      } else if (mode === 'image_post') {
        request = {
          submission_type: 'image_post',
          upload_id: uploadId ?? '',
          alt_text: altText.trim(),
          ...base,
        };
      } else {
        // Optional video sub-uploads: a WebVTT caption track and/or a poster.
        const captionsUploadId =
          captionsFile !== null ? (await uploadMedia(captionsFile)).upload_id : undefined;
        // The poster is an IMAGE upload, which the server requires alt text for
        // (WCAG); derive it from the title so the poster upload never 422s.
        const posterUploadId =
          posterFile !== null
            ? (
                await uploadMedia(
                  posterFile,
                  t('storyComposer.poster.alt', 'Poster image for {title}', {
                    title: title.trim(),
                  }),
                )
              ).upload_id
            : undefined;
        request = {
          submission_type: 'video_post',
          upload_id: uploadId ?? '',
          ...(captionsText.trim().length > 0 ? { captions_text: captionsText.trim() } : {}),
          ...(captionsUploadId !== undefined ? { captions_upload_id: captionsUploadId } : {}),
          ...(posterUploadId !== undefined ? { poster_upload_id: posterUploadId } : {}),
          ...base,
        };
      }
      const result = await createStory(request);
      // The post is accepted — clear its autosaved draft (cancel any pending
      // write first so a late debounce tick can't resurrect it).
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      latestDraft.current = null;
      void deleteStoryDraft(draftId.current).catch(() => undefined);
      const pendingScan = result.lifecycle_state === 'submitted' && isMedia;
      setStatus(pendingScan ? 'pending' : 'done');
      onSubmitted?.({ storyId: result.story_id, pendingScan });
    } catch (error) {
      const code = error instanceof ApiClientError ? error.code : 'unknown';
      const message =
        error instanceof ApiClientError
          ? error.message
          : t(
              'storyComposer.err.generic',
              'Could not submit — your draft is kept on this device. Try again when you are online.',
            );
      setStatus('idle');
      setErrors({ form: `${code}: ${message}` });
    }
  }

  const acceptTypes =
    mode === 'image_post' ? UPLOAD_IMAGE_TYPES.join(',') : UPLOAD_VIDEO_TYPES.join(',');

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-4"
      aria-describedby={`${formId}-status`}
    >
      {/* WS-Q.5.1b — a saved draft on this device offers resume-or-discard. */}
      {recoverable !== null ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken p-3"
        >
          <span className="text-ink text-sm">
            {t('storyComposer.recover.prompt', 'You have an unsent post draft. Resume or discard?')}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => resumeDraft(recoverable)}>
              {t('storyComposer.recover.resume', 'Resume')}
            </Button>
            <Button variant="ghost" onClick={() => discardDraft(recoverable)}>
              {t('storyComposer.recover.discard', 'Discard')}
            </Button>
          </div>
        </div>
      ) : null}

      <RadioGroup
        label={t('storyComposer.mode.label', 'What are you posting?')}
        value={mode}
        onValueChange={(value) => {
          setMode(value as StoryComposerMode);
          setErrors({});
          onPickFile(null); // clear any chosen media + preview when switching modes
          setCaptionsFile(null);
          setPosterFile(null);
        }}
        options={[
          { value: 'link', label: t('storyComposer.mode.link', 'A link') },
          { value: 'original_brief', label: t('storyComposer.mode.brief', 'A brief') },
          // Media modes appear only when the rollout flag is on (WS-Q.6.2).
          ...(content.media_posts_enabled
            ? [
                { value: 'image_post', label: t('storyComposer.mode.image', 'An image') },
                { value: 'video_post', label: t('storyComposer.mode.video', 'A video') },
              ]
            : []),
        ]}
      />

      <Select
        label={t('storyComposer.room.label', 'Home room')}
        value={roomId}
        onValueChange={(value) => setRoomId(value)}
        options={roomOptions}
        required
        {...(errors['room'] ? { error: errors['room'] } : {})}
        helperText={t('storyComposer.room.help', 'Every post belongs to one room.')}
      />

      {/* The visibility choice is shown only when the rollout flag is on; when
          off, the server forces public (public rooms) / room_only (private). */}
      {content.in_room_visibility_enabled ? (
        <fieldset className="flex flex-col gap-1">
          <RadioGroup
            label={t('storyComposer.vis.label', 'Who can see this?')}
            value={effectiveVisibility}
            onValueChange={(value) => setRequestedVisibility(value as 'public' | 'room_only')}
            options={[
              { value: 'public', label: t('storyComposer.vis.public', 'Anyone (public)') },
              { value: 'room_only', label: t('storyComposer.vis.room', 'This room only') },
            ]}
          />
          {roomIsPrivate ? (
            <p className="text-ink-muted text-sm">
              {t('storyComposer.vis.locked', 'This room is private — posts stay in the room.')}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <Input
        label={t('storyComposer.title.label', 'Title')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
        {...(errors['title'] ? { error: errors['title'] } : {})}
      />

      {mode === 'link' ? (
        <>
          <Input
            label={t('storyComposer.url.label', 'Link URL')}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            {...(errors['url'] ? { error: errors['url'] } : {})}
          />
          <TextArea
            label={t('storyComposer.reason.label', 'Why this matters')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            {...(errors['reason'] ? { error: errors['reason'] } : {})}
          />
        </>
      ) : null}

      {mode === 'original_brief' ? (
        <TextArea
          label={t('storyComposer.body.label', 'Your brief')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          {...(errors['body'] ? { error: errors['body'] } : {})}
        />
      ) : null}

      {isMedia ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${formId}-file`} className="font-medium text-ink text-sm">
            {mode === 'image_post'
              ? t('storyComposer.file.image', 'Image file')
              : t('storyComposer.file.video', 'Video file')}
          </label>
          <input
            id={`${formId}-file`}
            type="file"
            accept={acceptTypes}
            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            className="text-sm text-ink"
            {...(errors['file'] ? { 'aria-invalid': true } : {})}
          />
          {/* WS-Q.5.2a — client-side image preview before upload. The src is
              sanitized AT THE SINK: an allowlist guard (`blob:`) dominates the
              <img> so only a browser object URL is ever rendered. */}
          {previewUrl !== null && previewUrl.startsWith('blob:') ? (
            <img
              src={previewUrl}
              alt={t('storyComposer.preview.alt', 'Selected image preview')}
              className="max-h-48 w-auto rounded-md object-contain"
            />
          ) : null}
          {errors['file'] ? <p className="text-danger text-sm">{errors['file']}</p> : null}
        </div>
      ) : null}

      {mode === 'image_post' ? (
        <Input
          label={t('storyComposer.alt.label', 'Alternative text (required)')}
          value={altText}
          onChange={(e) => setAltText(e.target.value)}
          required
          {...(errors['altText'] ? { error: errors['altText'] } : {})}
          helperText={t(
            'storyComposer.alt.help',
            'Describe the image for people who cannot see it.',
          )}
        />
      ) : null}

      {mode === 'video_post' ? (
        <>
          <TextArea
            label={t('storyComposer.captions.label', 'Captions text (optional)')}
            value={captionsText}
            onChange={(e) => setCaptionsText(e.target.value)}
            disabled={captionsFile !== null}
            helperText={t('storyComposer.captions.help', 'Captions improve access for everyone.')}
            {...(errors['captions'] ? { error: errors['captions'] } : {})}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-captions`} className="font-medium text-ink text-sm">
              {t('storyComposer.captions.file', 'Or upload a caption track (.vtt)')}
            </label>
            <input
              id={`${formId}-captions`}
              type="file"
              accept="text/vtt,.vtt"
              onChange={(e) => setCaptionsFile(e.target.files?.[0] ?? null)}
              className="text-sm text-ink"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-poster`} className="font-medium text-ink text-sm">
              {t('storyComposer.poster.file', 'Poster image (optional)')}
            </label>
            <input
              id={`${formId}-poster`}
              type="file"
              accept={UPLOAD_IMAGE_TYPES.join(',')}
              onChange={(e) => setPosterFile(e.target.files?.[0] ?? null)}
              className="text-sm text-ink"
            />
          </div>
        </>
      ) : null}

      <p id={`${formId}-status`} role="status" className="text-ink-muted text-sm">
        {status === 'uploading'
          ? t('storyComposer.status.uploadingPct', 'Uploading… {pct}%', {
              pct: Math.round(uploadPct * 100),
            })
          : null}
        {status === 'submitting' ? t('storyComposer.status.submitting', 'Submitting…') : null}
        {status === 'pending'
          ? t('storyComposer.status.pending', 'Posted, pending a safety check.')
          : null}
        {status === 'done' ? t('storyComposer.status.done', 'Posted.') : null}
      </p>
      {errors['form'] ? <p className="text-danger text-sm">{errors['form']}</p> : null}

      <Button
        type="submit"
        variant="primary"
        disabled={status === 'uploading' || status === 'submitting' || !postable}
      >
        {t('storyComposer.submit', 'Post')}
      </Button>
    </form>
  );
}
