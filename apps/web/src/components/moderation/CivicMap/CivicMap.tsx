// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Civic Map (WS-H.7.4, SPEC §12.4/§34) — the Reeb attention landscape, on
// the console's Integrity tab beside the coordinated-report incidents. The two
// answer the same question from opposite ends: the incidents ask "did these
// accounts act together?", the landscape asks "what shape is attention taking,
// and where is it about to come apart?".
//
// WHY A MERGE TREE and not a force-directed blob. The Reeb graph IS a merge
// tree: a scalar sweep over a similarity graph, where basins are born at peaks
// and join at saddles. Drawn faithfully that is a small, honest diagram — the
// vertical axis is the sweep level, each basin is a vertical stem from its
// peak, and a saddle is the horizontal join where two stems meet. A physics
// layout would look busier and say less, and it would invite reading node size
// as importance. So: no simulation, no animation, no layout library — the
// geometry is computed directly from the data in `layout()` below.
//
// WHAT IT REFUSES TO BE. `level` is the sweep scalar (a story's hourly event
// count). It positions a stem on the axis and NOTHING else: no number is
// printed for it, basins are not ordered by it, and the panel never speaks of
// "top" or "most". This is the same restraint the wire schema's header asks of
// consumers, applied at the render boundary so a future edit has to break an
// explicit rule rather than drift past an implicit one.
//
// ACCESSIBILITY. A picture is not a data surface. The SVG is `aria-hidden` and
// the real content is a parallel semantic list underneath it — basins with
// their topics, then the fragile saddles with their bridge action. Screen
// readers get the whole landscape as structured text; the diagram is the
// sighted shortcut to the same facts. Nothing animates, so the §26.2
// reduced-motion requirement is satisfied by construction rather than by a
// media query.
import type { CivicMapBasin, CivicMapResponse, CivicMapSaddle } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface CivicMapProps {
  data: CivicMapResponse;
  /** Open a bridge request on a basin's thread (WS-H.4.2d). Absent ⇒ the map
   *  renders read-only, which is what a steward without room grants sees. */
  onOpenBridge?: (threadId: string, basinTitle: string) => void;
  /** Thread ids with a request in flight, so the button can disable itself. */
  pendingThreadIds?: readonly string[];
}

/** Diagram geometry. Small on purpose: this is a panel, not a page. */
const VIEW_W = 320;
const VIEW_H = 140;
const PAD_X = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
/** Stems past this many are summarised in text rather than drawn — a merge tree
 *  with forty stems is a smear, and the list below carries them all anyway. */
const MAX_DRAWN_BASINS = 12;

interface Stem {
  basinId: string;
  title: string;
  x: number;
  /** y for the basin's peak (its birth) — higher level sits higher. */
  yPeak: number;
  /** y where the stem STOPS: its absorbing saddle, or the floor if it survives. */
  yEnd: number;
}

interface Join {
  x1: number;
  x2: number;
  y: number;
  fragile: boolean;
}

/**
 * A NEUTRAL, engagement-independent order for basins.
 *
 * "Do not re-sort — preserve the sweep's own order" was exactly wrong. The
 * sweep descends through levels highest-first and appends each peak as it is
 * born, so the response order IS descending hourly engagement. Preserving it
 * made the x-axis and the text list an exact popularity ranking while the
 * component's own rule ("never re-order by level") was satisfied to the letter.
 * A ranking nobody sorted is still a ranking.
 *
 * Alphabetical by title, basin id as tiebreak: deterministic, useful for a
 * human scanning the list, and carrying no engagement signal at all.
 */
function neutralOrder(basins: readonly CivicMapBasin[]): CivicMapBasin[] {
  return [...basins].sort(
    (a, b) => a.title.localeCompare(b.title) || a.basin_id.localeCompare(b.basin_id),
  );
}

/**
 * Place stems left-to-right and map levels onto the vertical axis.
 *
 * Stems TERMINATE at the saddle where their basin is absorbed: a merge tree in
 * which both branches continue past their join is not a merge tree, and
 * successive joins would draw phantom basins contradicting `final`.
 */
function layout(data: CivicMapResponse): { stems: Stem[]; joins: Join[]; drawn: number } {
  const basins = neutralOrder(data.basins).slice(0, MAX_DRAWN_BASINS);
  if (basins.length === 0) return { stems: [], joins: [], drawn: 0 };

  const levels = [
    ...basins.map((b) => b.level),
    ...data.merges.map((m) => m.level),
    ...data.splits.map((s) => s.level),
  ];
  const maxLevel = Math.max(...levels, 1);
  const minLevel = Math.min(...levels, 0);
  const span = Math.max(1, maxLevel - minLevel);
  const yFor = (level: number): number =>
    PAD_TOP + (1 - (level - minLevel) / span) * (VIEW_H - PAD_TOP - PAD_BOTTOM);

  // Where each basin ENDS: the highest-level merge that absorbs it (the one it
  // does not survive). Absent ⇒ it reaches the floor.
  const absorbedAt = new Map<string, number>();
  for (const saddle of data.merges) {
    for (const basinId of [saddle.basin_a, saddle.basin_b]) {
      if (basinId === saddle.survivor) continue;
      const existing = absorbedAt.get(basinId);
      // Descending sweep: the FIRST (highest-level) absorption is the real end.
      if (existing === undefined || saddle.level > existing) absorbedAt.set(basinId, saddle.level);
    }
  }

  const usable = VIEW_W - PAD_X * 2;
  const step = basins.length === 1 ? 0 : usable / (basins.length - 1);
  const floor = VIEW_H - PAD_BOTTOM;
  const stems: Stem[] = basins.map((basin, i) => {
    const end = absorbedAt.get(basin.basin_id);
    return {
      basinId: basin.basin_id,
      title: basin.title,
      x: basins.length === 1 ? VIEW_W / 2 : PAD_X + i * step,
      yPeak: yFor(basin.level),
      yEnd: end === undefined ? floor : yFor(end),
    };
  });

  const xOf = new Map(stems.map((s) => [s.basinId, s.x]));
  const joins: Join[] = [];
  for (const saddle of data.merges) {
    const x1 = xOf.get(saddle.basin_a);
    const x2 = xOf.get(saddle.basin_b);
    // A saddle whose basins are past the draw cap has no stems to join; the
    // text list still reports it.
    if (x1 === undefined || x2 === undefined) continue;
    joins.push({ x1, x2, y: yFor(saddle.level), fragile: saddle.fragile });
  }
  return { stems, joins, drawn: basins.length };
}

/**
 * The window's own bounds, rendered.
 *
 * The sweep reads the LAST COMPLETED hour — `floor(now/1h) - 1h` — so at 12:30
 * the response describes 11:00–12:00 while the copy said "this hour". An
 * analyst attributing a previous-window cluster to current activity is the kind
 * of error a live surface must not invite, and the response already carries the
 * exact interval, so it is rendered rather than described.
 */
function hourLabel(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** How a join is named back to the caller of `onOpenBridge` — the two basins,
 *  since the bridge target is a connecting conversation rather than either. */
function joinLabel(t: ReturnType<typeof useT>, a: string, b: string): string {
  const unknown = t('civicMap.unknownBasin', 'an unavailable story');
  return `${a === '' ? unknown : a} ⇄ ${b === '' ? unknown : b}`;
}

/** The saddles worth acting on, strongest signal first (fewest connecting
 *  edges = most fragile). */
function fragileFirst(saddles: readonly CivicMapSaddle[]): CivicMapSaddle[] {
  return saddles
    .filter((s) => s.fragile)
    .slice()
    .sort((a, b) => a.connecting_edges - b.connecting_edges);
}

export function CivicMap({
  data,
  onOpenBridge,
  pendingThreadIds = [],
}: CivicMapProps): React.ReactElement {
  const t = useT();
  const { stems, joins, drawn } = layout(data);
  const fragile = fragileFirst(data.merges);
  const basinById = new Map(data.basins.map((b) => [b.basin_id, b]));
  const pending = new Set(pendingThreadIds);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-line bg-canvas p-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-ink text-sm">
          {t('civicMap.title', 'Attention landscape')}
        </h3>
        <p className="text-ink-muted text-xs">
          {t(
            'civicMap.help',
            'How attention grouped across topic-adjacent stories between {from} and {to}. Basins are clusters; a fragile join means two clusters are held together by very little, and a bridging comment would help.',
            { from: hourLabel(data.window.start), to: hourLabel(data.window.end) },
          )}
        </p>
      </div>

      {/* The diagram is decoration over the list below — hidden from assistive
          tech, which reads the structured content instead. */}
      {stems.length > 0 ? (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full"
        >
          {/* No <title>: the svg is aria-hidden, so a title would be both
              unreachable to assistive tech and a duplicate of the heading
              above it for anything that ignored the hint. */}
          {/* Baseline — the floor of the sweep. */}
          <line
            x1={0}
            y1={VIEW_H - PAD_BOTTOM}
            x2={VIEW_W}
            y2={VIEW_H - PAD_BOTTOM}
            className="stroke-line"
            strokeWidth={1}
          />
          {/* Stems: each basin from its peak down to where it ENDS — the saddle
              that absorbs it, or the floor if it survives to the end. */}
          {stems.map((stem) => (
            <g key={stem.basinId}>
              <line
                x1={stem.x}
                y1={stem.yPeak}
                x2={stem.x}
                y2={stem.yEnd}
                className="stroke-ink-muted"
                strokeWidth={1.5}
              />
              <circle cx={stem.x} cy={stem.yPeak} r={3.5} className="fill-ink-muted" />
            </g>
          ))}
          {/* Joins: horizontal connectors at the saddle level. A fragile join
              is dashed and warning-toned — reinforced by the text list, never
              carried by colour alone. */}
          {joins.map((join, i) => (
            <line
              // Geometry has no id of its own; index is stable for one render
              // and the elements are decorative.
              key={`${join.x1}-${join.x2}-${join.y}-${i}`}
              x1={join.x1}
              y1={join.y}
              x2={join.x2}
              y2={join.y}
              className={join.fragile ? 'stroke-warning' : 'stroke-line'}
              strokeWidth={join.fragile ? 2 : 1.5}
              strokeDasharray={join.fragile ? '4 3' : undefined}
            />
          ))}
        </svg>
      ) : null}

      {/* The structural summary, in words. ICU plurals rather than bare counts,
          so "1 fragile joins" can never reach a steward. */}
      <p className="text-ink-muted text-xs">
        {t('civicMap.clusters', '{count, plural, one {# cluster} other {# clusters}}', {
          count: data.summary.basin_count,
        })}
        {' · '}
        {t('civicMap.branches', '{count, plural, one {# branch point} other {# branch points}}', {
          count: data.summary.split_count,
        })}
        {' · '}
        {t('civicMap.fragile', '{count, plural, one {# fragile join} other {# fragile joins}}', {
          count: data.summary.fragile_saddle_count,
        })}
        {drawn < data.summary.basin_count
          ? ` · ${t('civicMap.drawnCap', 'showing {n} in the diagram', { n: drawn })}`
          : ''}
      </p>

      {/* A bounded scan says so. The landscape stops at its node cap or its scan
          ceiling on a busy hour — and a partial hour read as the hour is the
          same mistake as an empty report read as a clean room. */}
      {!data.scan.complete ? (
        <p className="text-ink-muted text-xs" role="note">
          {t(
            'civicMap.partialScan',
            'This hour had more activity than one map holds: {n} items were examined and the busiest were kept. Treat what is missing as unexamined, not absent.',
            { n: String(data.scan.examined) },
          )}
        </p>
      ) : null}

      {data.coverage < 0.25 ? (
        <p className="text-ink-muted text-xs" role="note">
          {t(
            'civicMap.thinCoverage',
            'Most stories this hour share no topic with another, so the landscape is mostly separate points rather than a connected shape.',
          )}
        </p>
      ) : null}

      {/* Fragile joins — the actionable part (SPEC §12.4 bridge prompts). */}
      {fragile.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium text-ink text-xs">
            {t('civicMap.fragileHeading', 'Fragile joins')}
          </h4>
          <ul className="flex flex-col gap-2">
            {fragile.map((saddle) => {
              // Titles come from the SADDLE, not from `basins`. See
              // `civicMapSaddleSchema`: a split's ids are ascending-sweep
              // minima and are in no peak list, so the lookup that happens to
              // work for merges finds nothing for them.
              const a = saddle.basin_a_title;
              const b = saddle.basin_b_title;
              // ONE target, chosen by the SERVER: `bridge_thread_id`.
              //
              // Two things this component cannot know decide it. Which
              // conversation carries the join — basins meet through their
              // lower-level members, so the thread is usually a connecting
              // story's rather than either peak's, and opening on a peak would
              // point the endpoint's SCOI baseline at a different subject. And
              // which threads THIS analyst may act on — reading the landscape is
              // a platform-integrity power, acting on a room's conversation is a
              // room-steward one, so offering every thread rendered controls
              // that deterministically 404. Null means "nothing here you can
              // act on", and the two reasons are deliberately indistinguishable.
              const target = saddle.bridge_thread_id;
              const shared = saddle.shared_topics.map((topic) => topic.name).join(', ');
              return (
                <li
                  key={`${saddle.basin_a}-${saddle.basin_b}`}
                  className="flex flex-col gap-1 rounded-md border border-line p-2"
                >
                  <span className="flex items-start gap-2 text-sm">
                    <Icon
                      name="triangle-exclamation"
                      className="mt-0.5 shrink-0 text-warning-on-soft"
                    />
                    <span className="text-ink">
                      {t('civicMap.joinedBy', '“{a}” and “{b}” are joined by {n} connections', {
                        a: a === '' ? t('civicMap.unknownBasin', 'an unavailable story') : a,
                        b: b === '' ? t('civicMap.unknownBasin', 'an unavailable story') : b,
                        n: String(saddle.connecting_edges),
                      })}
                    </span>
                  </span>
                  {shared ? (
                    <span className="ps-6 text-ink-muted text-xs">
                      {t('civicMap.sharedTopics', 'Shared topics: {topics}', { topics: shared })}
                    </span>
                  ) : null}
                  {onOpenBridge && target !== null ? (
                    <span className="flex flex-wrap gap-2 ps-6">
                      <Button
                        variant="ghost"
                        onClick={() => onOpenBridge(target, joinLabel(t, a, b))}
                        disabled={pending.has(target)}
                      >
                        {pending.has(target)
                          ? t('civicMap.bridgeOpening', 'Opening…')
                          : t('civicMap.openBridgeOnJoin', 'Open a bridge request on this join')}
                      </Button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* EVERY join in words, not only the actionable ones.
          The diagram draws every merge; the fragile list above covers only the
          ones with an action. Without this a screen-reader user could see the
          aggregate count but never learn WHICH basins join — a relationship
          plainly visible to a sighted user, which breaks the equivalence this
          component claims. */}
      {data.merges.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted">
            {t('civicMap.joinsToggle', 'List every join')}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {data.merges.map((saddle) => {
              const survivor = basinById.get(saddle.survivor);
              return (
                <li
                  key={`${saddle.basin_a}-${saddle.basin_b}-${saddle.level}`}
                  className="text-ink-muted"
                >
                  {t(
                    'civicMap.joinRow',
                    '“{a}” and “{b}” join by {n, plural, one {# connection} other {# connections}}; “{survivor}” continues',
                    {
                      a:
                        saddle.basin_a_title === ''
                          ? t('civicMap.unknownBasin', 'an unavailable story')
                          : saddle.basin_a_title,
                      b:
                        saddle.basin_b_title === ''
                          ? t('civicMap.unknownBasin', 'an unavailable story')
                          : saddle.basin_b_title,
                      n: saddle.connecting_edges,
                      survivor:
                        survivor?.title ?? t('civicMap.unknownBasin', 'an unavailable story'),
                    },
                  )}
                  {saddle.fragile ? ` · ${t('civicMap.fragileTag', 'fragile')}` : ''}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {/* SPLITS, in words.
          The summary counted them and nothing showed them: the diagram is a
          MERGE tree and both detail lists iterated `data.merges`, so an analyst
          could see that three basins bifurcated and not which, at what level, or
          into what. That is half the landscape SPEC §12.4 asks this surface to
          support, and it is the half that detects a community coming apart.

          A list rather than tree geometry: a split tree is the merge tree's dual
          and drawing both on one axis would assert a shape neither has. */}
      {data.splits.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted">
            {t('civicMap.splitsToggle', 'List every branch point')}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {data.splits.map((split) => {
              const shared = split.shared_topics.map((topic) => topic.name).join(', ');
              return (
                <li
                  key={`split-${split.basin_a}-${split.basin_b}-${split.level}`}
                  className="text-ink-muted"
                >
                  {t(
                    'civicMap.splitRow',
                    '“{a}” and “{b}” separate here, with {n, plural, one {# connection} other {# connections}} left between them',
                    {
                      a:
                        split.basin_a_title === ''
                          ? t('civicMap.unknownBasin', 'an unavailable story')
                          : split.basin_a_title,
                      b:
                        split.basin_b_title === ''
                          ? t('civicMap.unknownBasin', 'an unavailable story')
                          : split.basin_b_title,
                      n: split.connecting_edges,
                    },
                  )}
                  {shared
                    ? ` · ${t('civicMap.sharedTopics', 'Shared topics: {topics}', { topics: shared })}`
                    : ''}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {/* The full landscape as text — the accessible equivalent of the diagram,
          and the only place basins are enumerated. Neutral order, as above. */}
      <details className="text-xs">
        <summary className="cursor-pointer text-ink-muted">
          {t('civicMap.listToggle', 'List every cluster')}
        </summary>
        <ul className="mt-2 flex flex-col gap-1">
          {neutralOrder(data.basins).map((basin) => (
            <li key={basin.basin_id} className="text-ink-muted">
              <span className="text-ink">{basin.title}</span>
              {basin.topics.length > 0
                ? ` · ${basin.topics.map((topic) => topic.name).join(', ')}`
                : ''}
              {basin.final ? ` · ${t('civicMap.separate', 'stayed separate')}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
