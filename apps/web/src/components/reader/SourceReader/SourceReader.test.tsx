// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { SourceReader, type SourceReaderProps } from './SourceReader.js';

const DANGEROUS_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-top-navigation',
] as const;

function renderReader(props: Partial<SourceReaderProps> = {}) {
  return render(
    <SourceReader
      url="https://example.org/article"
      title="Upstream Coordination Report"
      onClose={() => undefined}
      {...props}
    />,
  );
}

/** The reader uses no real <iframe> rendering in jsdom; read it from the DOM. */
function getFrame(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector('iframe');
  if (!frame) throw new Error('expected an iframe');
  return frame;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SourceReader (WS-B.2.7)', () => {
  it('loads the source in an iframe sandboxed with NONE of the dangerous tokens', () => {
    const { container } = renderReader();
    const frame = getFrame(container);

    // The sandbox attribute is present and EMPTY (maximally restrictive).
    expect(frame).toHaveAttribute('sandbox');
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe('');

    // Defense-in-depth: explicitly assert no escape hatch leaked in. Even if a
    // script were injected into the source, the empty sandbox blocks execution.
    for (const token of DANGEROUS_SANDBOX_TOKENS) {
      expect(sandbox).not.toContain(token);
    }
  });

  it('gives the iframe an accessible title naming the source', () => {
    const { container } = renderReader();
    const frame = getFrame(container);
    expect(frame).toHaveAttribute('title');
    expect(frame.getAttribute('title')).toContain('Upstream Coordination Report');
    expect(frame).toHaveAttribute('src', 'https://example.org/article');
  });

  it('fires onClose from the Back button (returning focus to the thread)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderReader({ onClose });

    await user.click(screen.getByRole('button', { name: 'Back to thread' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when Escape is pressed (focus trap)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderReader({ onClose });

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles readability mode, swapping the iframe for safe text paragraphs', async () => {
    const user = userEvent.setup();
    const { container } = renderReader({
      readabilityHtml: 'First paragraph of the story.\n\nSecond paragraph with detail.',
    });

    // Starts on the iframe.
    expect(container.querySelector('iframe')).not.toBeNull();
    const toggle = screen.getByRole('button', { name: 'Reader view' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);

    // Iframe gone; content rendered as text, NOT as injected HTML.
    expect(container.querySelector('iframe')).toBeNull();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('First paragraph of the story.')).toBeInTheDocument();
    expect(screen.getByText('Second paragraph with detail.')).toBeInTheDocument();

    // Toggling back restores the iframe.
    await user.click(toggle);
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders readability text as plain text and never as live markup', async () => {
    const user = userEvent.setup();
    const { container } = renderReader({
      // Even if upstream sanitization regressed, this string is rendered as text.
      readabilityHtml: 'Safe lead.\n\n<img src=x onerror=alert(1)> still text.',
    });
    await user.click(screen.getByRole('button', { name: 'Reader view' }));

    // No <img> element was created from the string — it is literal text content.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> still text.')).toBeInTheDocument();
  });

  it('omits the readability toggle when no readabilityHtml is provided', () => {
    renderReader();
    expect(screen.queryByRole('button', { name: 'Reader view' })).toBeNull();
  });

  it('captures the current selection into an editable citation and emits it', async () => {
    const user = userEvent.setup();
    const onCaptureCitation = vi.fn();

    // jsdom has no real selection; stub getSelection to return excerpt text.
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'Two primary sources corroborated.',
    } as unknown as Selection);

    renderReader({ onCaptureCitation });

    await user.click(screen.getByRole('button', { name: 'Capture selection' }));

    const draft = screen.getByRole('textbox', { name: 'Citation excerpt' });
    expect(draft).toHaveValue('Two primary sources corroborated.');

    await user.click(screen.getByRole('button', { name: 'Save citation' }));
    expect(onCaptureCitation).toHaveBeenCalledWith({
      url: 'https://example.org/article',
      text: 'Two primary sources corroborated.',
    });
  });

  it('lets the user type a citation excerpt directly and emits it', async () => {
    const user = userEvent.setup();
    const onCaptureCitation = vi.fn();
    renderReader({ onCaptureCitation });

    const draft = screen.getByRole('textbox', { name: 'Citation excerpt' });
    await user.type(draft, 'Manually typed excerpt.');
    await user.click(screen.getByRole('button', { name: 'Save citation' }));

    expect(onCaptureCitation).toHaveBeenCalledWith({
      url: 'https://example.org/article',
      text: 'Manually typed excerpt.',
    });
  });

  it('omits citation capture when no onCaptureCitation handler is provided', () => {
    renderReader();
    expect(screen.queryByRole('button', { name: 'Capture selection' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Citation excerpt' })).toBeNull();
  });

  it('has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderReader({
      onCaptureCitation: () => undefined,
      readabilityHtml: 'Lead paragraph.\n\nSupporting paragraph.',
    });
    // Audit in readability mode: axe-core cannot descend into a jsdom <iframe>
    // (its content window is not a real frame), and the sandboxed frame has no
    // a11y surface of its own. Reader view exercises the full structural shell
    // — dialog, toolbar, labelled controls and the citation form.
    await user.click(screen.getByRole('button', { name: 'Reader view' }));
    expect(container.querySelector('iframe')).toBeNull();
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('sanitizes and extracts readable content from sourceHtml (no remote markup)', async () => {
    const user = userEvent.setup();
    renderReader({
      sourceHtml: `<html><head><title>Ignored</title></head><body>
        <script>window.__pwned = true;</script>
        <article>
          <h2>Upstream coordination</h2>
          <p>Operators released water in stages.</p>
          <ul><li>Gauge A held</li><li>Gauge B held</li></ul>
        </article>
      </body></html>`,
    });

    await user.click(screen.getByRole('button', { name: 'Reader view' }));

    // The extraction is async (worker where available, main thread here).
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Upstream coordination' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Operators released water in stages.')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    // The script never ran and its text is not surfaced.
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
    expect(screen.queryByText(/__pwned/)).toBeNull();
    expect(screen.queryByText(/window\./)).toBeNull();
  });
});
