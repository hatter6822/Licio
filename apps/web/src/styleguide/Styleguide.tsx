// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Component workbench (WS-B.1.1c). A single route that mounts the design system
// so it can be reviewed visually in every colour mode and exercised end-to-end
// by Playwright (real-browser axe, target-size, zoom/reflow, scroll-preservation,
// dark / high-contrast). It is code-split so it never weighs down the app bundle.
import { type ReactNode, useId, useState } from 'react';
import { RouteAnnouncer } from '../components/a11y/index.js';
import { DefinedTerm } from '../components/cognitive/DefinedTerm/index.js';
import { ExplainLikeNewLens } from '../components/cognitive/ExplainLikeNewLens/index.js';
import { ProgressiveDisclosure } from '../components/cognitive/ProgressiveDisclosure/index.js';
import { TranslationDisclosure } from '../components/i18n/TranslationDisclosure/index.js';
import { RatingLabel, ratingLabelKinds } from '../components/story/RatingLabel/index.js';
import { StoryCard } from '../components/story/StoryCard/index.js';
import { UgcBody } from '../components/ugc/UgcBody.js';
import { AppShell } from '../components/ui/AppShell/index.js';
import { Avatar } from '../components/ui/Avatar/index.js';
import { Badge } from '../components/ui/Badge/index.js';
import { BottomNav, defaultNavItems } from '../components/ui/BottomNav/index.js';
import { Button, type ButtonVariant } from '../components/ui/Button/index.js';
import { Card } from '../components/ui/Card/index.js';
import { Checkbox } from '../components/ui/Checkbox/index.js';
import { Dialog } from '../components/ui/Dialog/index.js';
import { EmptyState } from '../components/ui/EmptyState/index.js';
import { ErrorState } from '../components/ui/ErrorState/index.js';
import { Input } from '../components/ui/Input/index.js';
import { RadioGroup } from '../components/ui/RadioGroup/index.js';
import { ReadingEstimate } from '../components/ui/ReadingEstimate/index.js';
import { Select } from '../components/ui/Select/index.js';
import { Separator } from '../components/ui/Separator/index.js';
import { Sheet } from '../components/ui/Sheet/index.js';
import { Skeleton } from '../components/ui/Skeleton/index.js';
import { Switch } from '../components/ui/Switch/index.js';
import { Tabs } from '../components/ui/Tabs/index.js';
import { TextArea } from '../components/ui/TextArea/index.js';
import { type ColorScheme, ThemeToggle } from '../components/ui/ThemeToggle/index.js';
import { ToastProvider, useToast } from '../components/ui/Toast/index.js';
import { Tooltip } from '../components/ui/Tooltip/index.js';
import { VirtualList } from '../components/ui/VirtualList/index.js';
import { I18nProvider, useT } from '../i18n/index.js';

function Section({ title, children }: { title: string; children: ReactNode }): React.ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t border-line py-6">
      <h2 id={id} className="text-2xl font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];

function ToastDemo(): React.ReactElement {
  const { toast } = useToast();
  return <Button onClick={() => toast({ tone: 'success', message: 'Saved' })}>Show toast</Button>;
}

/**
 * UGC fixtures the Playwright suite exercises under the preview's REAL
 * Content-Security-Policy (`require-trusted-types-for 'script'`): the
 * formatting sample proves the licio-ugc Trusted Types policy renders in a
 * real engine; the attack sample's payloads must come out inert; the link
 * sample drives the WS-G.4.2c interstitial with a heuristic-suspicious URL
 * (no blocklist needed — the heuristics are local).
 */
const UGC_FORMATTING_SAMPLE = [
  '## Reservoir levels',
  '',
  'The **May reading** fell *12%* against the `2019` baseline.',
  '',
  '> Quoted from the gauge log.',
  '',
  '- [agency report](https://example.org/report)',
  '- second item',
].join('\n');

const UGC_ATTACK_SAMPLE = [
  '<script>window.__ugc_xss = true;</script>',
  '',
  '<img src=x onerror="window.__ugc_xss = true">',
  '',
  '[harmless?](javascript:alert(1))',
  '',
  '[claim airdrop](https://site.example/approve?spender=0xabc123)',
].join('\n');

function ComposerDemo(): React.ReactElement {
  return (
    <p className="rounded-lg border border-line bg-surface p-4 text-ink">
      The legacy participation composer has been retired. Comments now live inline on story pages;
      this styleguide keeps the story composer and shared affordances covered separately.
    </p>
  );
}

function Gallery(): React.ReactElement {
  const t = useT();
  const [scheme, setScheme] = useState<ColorScheme>('system');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState('a');
  const [select, setSelect] = useState('balanced');
  const [focusOn, setFocusOn] = useState(false);

  return (
    <AppShell
      nav={<BottomNav items={defaultNavItems(t)} activeId="front-page" />}
      banner={
        <div className="flex items-center justify-between gap-4 px-4 py-2">
          <span className="text-lg font-bold text-ink">Licio design system</span>
          <ThemeToggle value={scheme} onValueChange={setScheme} className="hidden sm:block" />
        </div>
      }
    >
      <div className="mx-auto flex max-w-3xl flex-col px-4">
        <h1 className="py-6 text-3xl font-bold text-ink">Component workbench</h1>

        <Section title="Buttons">
          <div className="flex flex-wrap gap-3">
            {VARIANTS.map((variant) => (
              <Button key={variant} variant={variant}>
                {variant}
              </Button>
            ))}
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
            <Button iconOnly aria-label="Close">
              ✕
            </Button>
            <Button href="#main">Link</Button>
          </div>
        </Section>

        <Section title="Form controls">
          <div className="flex flex-col gap-4">
            <Input label="Display name" helperText="Your public handle" required />
            <Input label="Email" error="Enter a valid email" />
            <TextArea label="What are you adding?" maxLength={280} />
            <Select
              label="Feed order"
              value={select}
              onValueChange={setSelect}
              options={[
                { value: 'balanced', label: 'Balanced' },
                { value: 'chronological', label: 'Chronological' },
              ]}
            />
            <Checkbox label="Email me updates" checked={checked} onCheckedChange={setChecked} />
            <RadioGroup
              label="Notification frequency"
              value={radio}
              onValueChange={setRadio}
              options={[
                { value: 'a', label: 'Daily' },
                { value: 'b', label: 'Weekly' },
              ]}
            />
            <Switch label="Focus mode" checked={focusOn} onCheckedChange={setFocusOn} />
          </div>
        </Section>

        <Section title="Rating labels">
          <div className="flex flex-wrap gap-2">
            {ratingLabelKinds.map((kind) => (
              <RatingLabel key={kind} kind={kind} />
            ))}
          </div>
        </Section>

        <Section title="Badges & display">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="success">Saved</Badge>
            <Badge tone="warning">Approaching limit</Badge>
            <Badge tone="error">Couldn't post</Badge>
            <Badge tone="info">Why you're seeing this</Badge>
            <Avatar name="Ada Lovelace" />
            <Separator orientation="vertical" className="h-8" decorative={false} />
            <Skeleton className="h-6 w-32" />
            <ReadingEstimate minutes={6} />
          </div>
          <Card>
            <h3 className="text-lg font-semibold text-ink">A card</h3>
            <p className="text-ink-muted">Semantic container with heading hierarchy.</p>
          </Card>
          <Tabs
            tabs={[
              { id: 'one', label: 'Overview' },
              { id: 'two', label: 'Evidence' },
            ]}
            label="Demo tabs"
          >
            {(active) => <p className="py-3 text-ink">Panel: {active}</p>}
          </Tabs>
        </Section>

        <Section title="Story card">
          <StoryCard
            story={{
              id: 's1',
              title: 'River levels stabilize after upstream coordination',
              source: 'Delta Observer',
              origin: 'independent',
              url: '#main',
              readingMinutes: 4,
            }}
            ratingLabel="well-sourced"
            distributionReason="Rising from independent source opens and evidence additions"
            contextChips={[
              { id: 'c1', label: '3 evidence cards' },
              { id: 'c2', label: '2 primary sources' },
            ]}
            onSave={() => undefined}
            onOpenContext={() => undefined}
          />
        </Section>

        <Section title="States">
          <EmptyState title="No stories yet" description="Submit one to get started." />
          <ErrorState onRetry={() => undefined} />
        </Section>

        <Section title="Overlays">
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
            <Button onClick={() => setSheetOpen(true)}>Open sheet</Button>
            <Tooltip content="Participation-weighted attention">
              <Button>Hover me</Button>
            </Tooltip>
            <ToastDemo />
          </div>
          <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Confirm action">
            <p className="text-ink">Dialog body content.</p>
            <Button onClick={() => setDialogOpen(false)}>OK</Button>
          </Dialog>
          <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Bottom sheet">
            <p className="text-ink">Sheet body content.</p>
          </Sheet>
        </Section>

        <Section title="Cognitive accessibility">
          <ProgressiveDisclosure summary="How is this ranked?">
            <p>Ranking uses participation-weighted attention, not popularity.</p>
          </ProgressiveDisclosure>
          <p className="text-ink">
            The <DefinedTerm term="PWAtt" definition="Participation-weighted attention" /> ranking.
          </p>
          <ExplainLikeNewLens
            original={<span>A technical summary with jargon.</span>}
            plainLanguageSummary={<span>A simple summary anyone can read.</span>}
          />
        </Section>

        <Section title="Internationalization">
          <TranslationDisclosure original={<p>Texto original</p>} originalLang="es">
            <p>Translated content</p>
          </TranslationDisclosure>
        </Section>

        <Section title="Virtualized list">
          <VirtualList
            items={Array.from({ length: 1000 }, (_, i) => `Row ${i}`)}
            getKey={(item) => item}
            itemHeight={44}
            label="Demo virtualized list"
            className="h-64 rounded-md border border-line"
            renderItem={(item) => <div className="px-3 py-3 text-ink">{item}</div>}
          />
        </Section>

        <Section title="User content (UGC pipeline)">
          <div data-testid="ugc-formatting" className="rounded-lg border border-line p-4">
            <UgcBody markdown={UGC_FORMATTING_SAMPLE} />
          </div>
          <div data-testid="ugc-attack" className="rounded-lg border border-line p-4">
            <UgcBody markdown={UGC_ATTACK_SAMPLE} />
          </div>
        </Section>

        <Section title="Participation composer">
          <ComposerDemo />
        </Section>
      </div>
    </AppShell>
  );
}

/** The styleguide route component (self-contained: providers included). */
export function Styleguide(): React.ReactElement {
  return (
    <I18nProvider>
      <RouteAnnouncer>
        {/* The skip link is provided by AppShell (inside Gallery). */}
        <ToastProvider>
          <Gallery />
        </ToastProvider>
      </RouteAnnouncer>
    </I18nProvider>
  );
}
