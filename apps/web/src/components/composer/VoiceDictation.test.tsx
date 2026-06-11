// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Voice dictation tests (WS-G.3.7d): availability detection (graceful
// absence), the recording indicator, interim streaming, final-transcript
// append, and a clean stop.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { speechRecognitionCtor, VoiceDictation } from './VoiceDictation.js';

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  interimResults = false;
  continuous = false;
  onresult: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
    this.onend?.();
  }
  emit(transcript: string, isFinal: boolean): void {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, 0: { transcript }, length: 1 }],
    });
  }
}

afterEach(() => {
  FakeRecognition.instances = [];
  vi.unstubAllGlobals();
});

describe('WS-G.3.7d voice dictation', () => {
  it('renders nothing when the Web Speech API is unavailable', () => {
    expect(speechRecognitionCtor()).toBeNull(); // jsdom has no SpeechRecognition
    const { container } = render(<VoiceDictation fieldLabel="Question" onAppend={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('streams interim results and appends the final transcript', async () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const user = userEvent.setup();
    const onAppend = vi.fn();
    render(<VoiceDictation fieldLabel="Question" onAppend={onAppend} />);

    await user.click(screen.getByRole('button', { name: /dictate into question/i }));
    expect(screen.getByText(/listening/i)).toBeInTheDocument();
    const recognition = FakeRecognition.instances[0];
    expect(recognition?.started).toBe(true);
    expect(recognition?.interimResults).toBe(true);

    recognition?.emit('the reservoir', false);
    expect(await screen.findByText('the reservoir')).toBeInTheDocument(); // interim preview
    expect(onAppend).not.toHaveBeenCalled();

    recognition?.emit('the reservoir level fell', true);
    expect(onAppend).toHaveBeenCalledWith('the reservoir level fell');
  });

  it('stop ends dictation cleanly and clears the indicator', async () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const user = userEvent.setup();
    render(<VoiceDictation fieldLabel="Question" onAppend={() => {}} />);
    await user.click(screen.getByRole('button', { name: /dictate into question/i }));
    await user.click(screen.getByRole('button', { name: /stop dictating/i }));
    expect(FakeRecognition.instances[0]?.stopped).toBe(true);
    expect(screen.queryByText(/listening/i)).not.toBeInTheDocument();
  });
});
