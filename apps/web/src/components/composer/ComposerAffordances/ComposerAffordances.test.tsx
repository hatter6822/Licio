// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for the composer input affordances (WS-B.2.11): voice dictation,
// citation capture, and file attachment. Every affordance must degrade
// gracefully, stay keyboard-operable, and announce its result to assistive tech.
// Web Speech is not in jsdom, so we install a minimal fake constructor on
// `window` only for the "supported" path and delete it for the "unsupported"
// one.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Attachment } from './Attachment.js';
import { CitationCapture } from './CitationCapture.js';
import { VoiceDictation } from './VoiceDictation.js';
import type { SpeechRecognitionEventLike, SpeechRecognitionLike } from './speech.js';

/** A controllable fake SpeechRecognition for the supported path. */
class FakeSpeechRecognition implements SpeechRecognitionLike {
  static instances: FakeSpeechRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: (() => void) | null = null;
  started = false;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
    this.onend?.();
  }
  abort(): void {
    this.started = false;
  }

  /** Push a transcript result through the `onresult` handler. */
  emit(transcript: string, isFinal: boolean): void {
    const alternative = { transcript };
    const result = {
      isFinal,
      length: 1,
      item: () => alternative,
      0: alternative,
    };
    const event = {
      resultIndex: 0,
      results: { length: 1, item: () => result, 0: result },
    } as unknown as SpeechRecognitionEventLike;
    this.onresult?.(event);
  }
}

type SpeechWindow = typeof window & {
  SpeechRecognition?: typeof FakeSpeechRecognition;
  webkitSpeechRecognition?: typeof FakeSpeechRecognition;
};

function installSpeech(): void {
  (window as SpeechWindow).SpeechRecognition = FakeSpeechRecognition;
}
function uninstallSpeech(): void {
  // Clear the globals so feature detection (`window.SpeechRecognition`) is
  // falsy. Assigning through an index signature avoids both the strict-optional
  // assignment error and Biome's noDelete rule.
  const globals = window as unknown as Record<string, unknown>;
  globals['SpeechRecognition'] = undefined;
  globals['webkitSpeechRecognition'] = undefined;
}

afterEach(() => {
  uninstallSpeech();
  FakeSpeechRecognition.instances = [];
});

describe('VoiceDictation (WS-B.2.11) — graceful degradation', () => {
  it('hides nothing critical: when Web Speech is unavailable the toggle is disabled with a note', () => {
    uninstallSpeech();
    render(<VoiceDictation />);
    const button = screen.getByRole('button', { name: /dictate/i });
    // The Button primitive disables via aria-disabled (the control stays
    // focusable and announced) and links its explanatory note.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    // An explanatory note tells the user text entry still works.
    expect(screen.getByText(/not available in this browser/i)).toBeInTheDocument();
    expect(screen.getByText(/still type/i)).toBeInTheDocument();
  });

  it('text entry remains fully functional alongside an unavailable dictation control', async () => {
    uninstallSpeech();
    const user = userEvent.setup();
    render(
      <form>
        <label htmlFor="body">Contribution</label>
        <textarea id="body" />
        <VoiceDictation />
      </form>,
    );
    const field = screen.getByLabelText('Contribution');
    await user.type(field, 'typed by hand');
    expect(field).toHaveValue('typed by hand');
  });

  it('when supported, toggles aria-pressed and announces the interim transcript', async () => {
    installSpeech();
    const user = userEvent.setup();
    const onTranscript = vi.fn();
    render(<VoiceDictation onTranscript={onTranscript} />);

    const button = screen.getByRole('button', { name: /dictate/i });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await user.click(button);
    expect(screen.getByRole('button', { name: /stop dictation/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const recognition = FakeSpeechRecognition.instances.at(-1);
    expect(recognition?.started).toBe(true);

    // Interim result is announced politely; final result reaches the callback.
    recognition?.emit('hello world', false);
    await waitFor(() => expect(screen.getByText(/Transcribing: hello world/i)).toBeInTheDocument());
    recognition?.emit('hello world.', true);
    expect(onTranscript).toHaveBeenCalledWith('hello world.');
  });

  it('has no axe violations in the unsupported state', async () => {
    uninstallSpeech();
    const { container } = render(<VoiceDictation />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('CitationCapture (WS-B.2.11)', () => {
  it('prefills an editable field from a captured URL and lets the user edit before inserting', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<CitationCapture initialUrl="https://example.org/a" onInsert={onInsert} />);

    const field = screen.getByLabelText(/Citation/i);
    expect(field).toHaveValue('https://example.org/a');

    await user.clear(field);
    await user.type(field, 'https://example.org/edited');
    await user.click(screen.getByRole('button', { name: /insert citation/i }));
    expect(onInsert).toHaveBeenCalledWith('https://example.org/edited');
    // The inserted citation is announced.
    expect(screen.getByText(/Citation inserted:/i)).toBeInTheDocument();
  });

  it('works as a manual paste fallback with no Web Share (empty initial URL)', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<CitationCapture onInsert={onInsert} />);
    const field = screen.getByLabelText(/Citation/i);
    expect(field).toHaveValue('');
    await user.type(field, 'Pasted reference, 2026');
    await user.click(screen.getByRole('button', { name: /insert citation/i }));
    expect(onInsert).toHaveBeenCalledWith('Pasted reference, 2026');
  });

  it('does not insert an empty citation', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<CitationCapture onInsert={onInsert} />);
    await user.click(screen.getByRole('button', { name: /insert citation/i }));
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<CitationCapture initialUrl="https://example.org" />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('Attachment (WS-B.2.11)', () => {
  it('shows a privacy warning before the file input', () => {
    render(<Attachment />);
    const warning = screen.getByText(/can carry hidden metadata/i);
    expect(warning).toBeInTheDocument();
    const input = screen.getByLabelText(/Attach a file/i);
    expect(warning.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists attached files each with an accessible remove button naming the file', async () => {
    const user = userEvent.setup();
    const onFilesChange = vi.fn();
    render(<Attachment multiple onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/Attach a file/i) as HTMLInputElement;

    const file = new File(['data'], 'evidence.pdf', { type: 'application/pdf' });
    await user.upload(input, file);

    expect(screen.getByText('evidence.pdf')).toBeInTheDocument();
    expect(onFilesChange).toHaveBeenLastCalledWith([file]);

    const remove = screen.getByRole('button', { name: /remove evidence\.pdf/i });
    await user.click(remove);
    expect(screen.queryByText('evidence.pdf')).not.toBeInTheDocument();
    expect(onFilesChange).toHaveBeenLastCalledWith([]);
  });

  it('has no axe violations with an attached file', async () => {
    const user = userEvent.setup();
    const { container } = render(<Attachment />);
    const input = screen.getByLabelText(/Attach a file/i) as HTMLInputElement;
    await user.upload(input, new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
