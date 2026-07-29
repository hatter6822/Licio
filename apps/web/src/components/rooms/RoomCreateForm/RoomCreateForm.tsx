// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3c — create a room with the binary visibility + orthogonal join/posting
// axes. The coherence rules mirror the SHARED roomCreateRequestSchema refinement
// so the UI can never SUBMIT an incoherent combination: a PUBLIC room admits
// only the `open` join model (the join control locks to open and is disabled
// when public). Steward rooms are not creatable here (staff-only). Rooms are
// `global_topic` with submitter-supplied initial topics (the WS-K taxonomy seam).
import type { RoomCreateRequest } from '@licio/shared';
import { useId, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { fieldErrorsFrom } from '../../../lib/form-errors.js';
import { useCreateRoomMutation } from '../../../lib/queries.js';
import { Button } from '../../ui/Button/index.js';
import { Input } from '../../ui/Input/index.js';
import { RadioGroup } from '../../ui/RadioGroup/index.js';
import { Select } from '../../ui/Select/index.js';
import { TextArea } from '../../ui/TextArea/index.js';

export interface RoomCreateFormProps {
  onCreated?: (roomId: string) => void;
}

export function RoomCreateForm({ onCreated }: RoomCreateFormProps): React.ReactElement {
  const t = useT();
  const formId = useId();
  const mutation = useCreateRoomMutation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [joinModel, setJoinModel] = useState<'open' | 'request_approval' | 'invite'>('open');
  const [postingPolicy, setPostingPolicy] = useState<'all_members' | 'experts_and_stewards'>(
    'all_members',
  );
  const [topics, setTopics] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Coherence (mirrors the shared refinement): a PUBLIC room is open-join only.
  const effectiveJoinModel = visibility === 'public' ? 'open' : joinModel;

  function onSubmit(event: React.FormEvent): void {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (name.trim().length === 0)
      next['name'] = t('roomCreate.err.name', 'A room name is required.');
    if (description.trim().length === 0) {
      next['description'] = t('roomCreate.err.description', 'A description is required.');
    }
    const initialTopics = topics
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (initialTopics.length === 0) {
      next['topics'] = t('roomCreate.err.topics', 'Add at least one topic.');
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const request: RoomCreateRequest = {
      room_type: 'global_topic',
      name: name.trim(),
      description: description.trim(),
      visibility,
      join_model: effectiveJoinModel,
      posting_policy: postingPolicy,
      initial_topics: initialTopics,
    };
    mutation.mutate(request, {
      onSuccess: (room) => onCreated?.(room.room_id),
      onError: (error) => {
        // ATTACH the server's per-field refusals to the inputs that failed.
        // The BFF answers a rejected body with a field path → message map and
        // this form rendered one banner over it, so a user was told the request
        // was invalid and left to guess which control the server meant.
        setErrors(
          fieldErrorsFrom(error, t('roomCreate.err.generic', 'Could not create the room.'), {
            initial_topics: 'topics',
          }),
        );
      },
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Input
        label={t('roomCreate.name', 'Room name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        {...(errors['name'] ? { error: errors['name'] } : {})}
      />
      <TextArea
        label={t('roomCreate.description', 'Description')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
        {...(errors['description'] ? { error: errors['description'] } : {})}
      />
      <Input
        label={t('roomCreate.topics', 'Topics (comma-separated)')}
        value={topics}
        onChange={(e) => setTopics(e.target.value)}
        required
        {...(errors['topics'] ? { error: errors['topics'] } : {})}
      />
      <RadioGroup
        label={t('roomCreate.visibility', 'Visibility')}
        value={visibility}
        onValueChange={(v) => setVisibility(v as 'public' | 'private')}
        options={[
          { value: 'public', label: t('roomCreate.vis.public', 'Public') },
          { value: 'private', label: t('roomCreate.vis.private', 'Private') },
        ]}
      />
      <Select
        label={t('roomCreate.join', 'How members join')}
        value={effectiveJoinModel}
        onValueChange={(v) => setJoinModel(v as 'open' | 'request_approval' | 'invite')}
        disabled={visibility === 'public'}
        helperText={
          visibility === 'public'
            ? t('roomCreate.join.publicLock', 'Public rooms are always open to join.')
            : undefined
        }
        options={[
          { value: 'open', label: t('roomCreate.join.open', 'Open') },
          { value: 'request_approval', label: t('roomCreate.join.request', 'Request approval') },
          { value: 'invite', label: t('roomCreate.join.invite', 'Invite only') },
        ]}
      />
      <Select
        label={t('roomCreate.posting', 'Who can post')}
        value={postingPolicy}
        onValueChange={(v) => setPostingPolicy(v as 'all_members' | 'experts_and_stewards')}
        options={[
          { value: 'all_members', label: t('roomCreate.posting.all', 'All members') },
          {
            value: 'experts_and_stewards',
            label: t('roomCreate.posting.experts', 'Experts and stewards'),
          },
        ]}
      />
      {errors['form'] ? <p className="text-error-on-soft text-sm">{errors['form']}</p> : null}
      <Button id={`${formId}-submit`} type="submit" variant="primary" disabled={mutation.isPending}>
        {t('roomCreate.submit', 'Create room')}
      </Button>
    </form>
  );
}
