// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MarkdownEditor (WS-Q.5.2a): a Markdown-lite authoring surface with a toolbar
// that inserts syntax and a Preview that renders through the SANCTIONED UgcBody
// sink — never a WYSIWYG/contentEditable (which would bypass the UGC pipeline).
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { MarkdownEditor } from './MarkdownEditor.js';

function Harness({ initial = '' }: { initial?: string }): React.ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor label="Your text" value={value} onChange={setValue} required maxLength={200} />
  );
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Your text' }) as HTMLTextAreaElement;
}

describe('MarkdownEditor', () => {
  it('inserts bold syntax with a placeholder when nothing is selected', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(editor()).toHaveValue('**bold text**');
  });

  it('wraps the current selection with the chosen inline mark', () => {
    render(<Harness initial="hello world" />);
    const ta = editor();
    ta.setSelectionRange(0, 5); // select "hello"
    fireEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(ta).toHaveValue('*hello* world');
  });

  it('prefixes every selected line for block formats (quote, list)', () => {
    render(<Harness initial={'line one\nline two'} />);
    const ta = editor();
    ta.setSelectionRange(0, ta.value.length);
    fireEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));
    expect(ta).toHaveValue('- line one\n- line two');
  });

  it('leaves the block marker outside the restored selection so type-over keeps it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));
    const ta = editor();
    expect(ta).toHaveValue('- list item');
    // Only the "list item" placeholder is selected — the "- " marker sits OUTSIDE
    // it (as with surround's ** markers), so typing over the placeholder keeps the
    // bullet instead of silently deleting the formatting.
    expect(ta.selectionStart).toBe('- '.length);
    expect(ta.selectionEnd).toBe('- list item'.length);
  });

  it('formats only on the platform-primary shortcut modifier', () => {
    // jsdom reports a non-Apple userAgent, so Ctrl is the primary modifier here
    // and ⌘ (metaKey) must NOT hijack macOS's Ctrl-based text bindings' inverse.
    render(<Harness initial="hello" />);
    const ta = editor();
    ta.setSelectionRange(0, 5);
    // A bare Meta+B is inert on a non-Apple platform…
    fireEvent.keyDown(ta, { key: 'b', metaKey: true });
    expect(ta).toHaveValue('hello');
    // …and an Alt-modified combo is always ignored…
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true, altKey: true });
    expect(ta).toHaveValue('hello');
    // …but Ctrl+B (the primary modifier here) applies bold.
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true });
    expect(ta).toHaveValue('**hello**');
  });

  it('renders a live preview through the UGC sink and hides the textarea', async () => {
    const { container } = render(<Harness initial="**important** context" />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    // The markdown rendered to real emphasis via renderUGC…
    const strong = screen.getByText('important');
    expect(strong.tagName).toBe('STRONG');
    // …and the write surface is hidden (not unmounted — the value persists), so
    // it is out of the a11y tree and queried directly from the DOM.
    const hiddenField = container.querySelector('textarea');
    expect(hiddenField).toBeInTheDocument();
    expect(hiddenField).not.toBeVisible();
    // The formatting toolbar is only shown while writing.
    expect(screen.queryByRole('button', { name: 'Bold' })).not.toBeInTheDocument();
  });

  it('shows a live character count against the limit', () => {
    render(<Harness initial="abc" />);
    expect(screen.getByText('3 / 200')).toBeInTheDocument();
  });

  it('answers to a single label lookup — the field, with no group duplicate', () => {
    // The composer wrapper must NOT reuse the field label (a role="group" with
    // the same aria-labelledby made getByLabel resolve to TWO elements, breaking
    // the BFF E2E). Exactly one element — the textarea — carries the name.
    render(<Harness initial="hi" />);
    const byLabel = screen.getAllByLabelText('Your text');
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0]?.tagName).toBe('TEXTAREA');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Harness initial="Some **text**." />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

function SourceHarness({ initial = '' }: { initial?: string }): React.ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      label="Your text"
      value={value}
      onChange={setValue}
      enableSourceLink
      maxLength={500}
    />
  );
}

describe('MarkdownEditor — inline sourcing (enableSourceLink)', () => {
  it('shows the generic Link button and no "Add source" affordance by default', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument();
  });

  it('replaces the generic Link button with "Add source" when inline sourcing is on', () => {
    render(<SourceHarness />);
    // Exactly one link mechanism — the source flow — never a second generic link.
    expect(screen.getByRole('button', { name: 'Add source' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
  });

  it('opens the "Add source" prompt on the ⌘/Ctrl+K link shortcut', () => {
    render(<SourceHarness initial="the earth is round" />);
    const ta = editor();
    ta.setSelectionRange(4, 9); // "earth"
    fireEvent.keyDown(ta, { key: 'k', ctrlKey: true });
    // The prompt opens (no generic `[](https://)` placeholder is inserted).
    expect(screen.getByRole('textbox', { name: /source url/i })).toBeInTheDocument();
    expect(ta).toHaveValue('the earth is round');
  });

  it('wraps the captured selection as a Markdown link to the entered source URL', async () => {
    render(<SourceHarness initial="the earth is round" />);
    const ta = editor();
    ta.setSelectionRange(4, 9); // select "earth"
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    const urlField = screen.getByRole('textbox', { name: /source url/i });
    await userEvent.type(urlField, 'https://example.org/x');
    await userEvent.click(screen.getByRole('button', { name: 'Link source' }));
    expect(ta).toHaveValue('the [earth](https://example.org/x) is round');
    // The sub-form closes after a successful link.
    expect(screen.queryByRole('textbox', { name: /source url/i })).not.toBeInTheDocument();
  });

  it('resolves a doi: reference to a doi.org link', async () => {
    render(<SourceHarness initial="see the study" />);
    editor().setSelectionRange(8, 13); // "study"
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: /source url/i }),
      'doi:10.1000/xyz123',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Link source' }));
    expect(editor()).toHaveValue('see the [study](https://doi.org/10.1000/xyz123)');
  });

  it('rejects an invalid URL without mutating the body', async () => {
    render(<SourceHarness initial="text" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await userEvent.type(screen.getByRole('textbox', { name: /source url/i }), 'not-a-url');
    await userEvent.click(screen.getByRole('button', { name: 'Link source' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid http/i);
    expect(editor()).toHaveValue('text');
  });

  it('cancels the sub-form without changing the body', async () => {
    render(<SourceHarness initial="text" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(screen.getByRole('textbox', { name: /source url/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: /source url/i })).not.toBeInTheDocument();
    expect(editor()).toHaveValue('text');
  });
});
