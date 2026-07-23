// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared surface treatments (WS-B fabric theme). On the solid canvas, a
// standalone or interactive surface must read as a PRESENT, tactile thing — never
// a transparent "ghost" outline (which is what a bare `border border-line` row
// becomes once the canvas is a flat colour). These are the SINGLE definition of
// each treatment, reused by the `Card` primitive AND by hand-rolled list rows /
// TanStack `<Link>` rows (profile, rooms, security), so the look stays consistent
// and the ghost regression cannot reappear one call-site at a time.
//
// Compose with `cn()`: add the layout + padding utilities at the call site, e.g.
//   cn('flex items-center justify-between gap-3 p-4', raisedSurface, raisedInteractive)

/**
 * A surface lifted off the canvas with the neumorphic paired shadow + a hairline
 * edge and a canvas-coloured fill. The shadow (not the fill) is what separates it
 * from the page, so it stays distinct even though the fill matches the canvas.
 *
 * REACH: `neu-raised` extends 16px, so a LIST of these tiles must use `gap-4`
 * (one spacing unit) for the soft halos never to wash over a neighbour
 * (NEU_OUTER_REACH_BUDGET_PX). Use {@link raisedInteractive} for tappable rows.
 */
export const raisedSurface = 'rounded-lg border border-line bg-canvas neu-raised';

/**
 * Press + focus feedback for a {@link raisedSurface} used as a whole-row link or
 * button: it depresses into the canvas on press and shows the system focus ring.
 * Pair with {@link raisedSurface} on the element that is itself the link/button
 * (so `:active` / `:focus-visible` land on the pressed control).
 */
export const raisedInteractive =
  'transition-shadow active:neu-pressed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * The COMPACT raised tile: the same treatment at the button/chip bevel
 * (`neu-raised-sm`) for dense lists — a scannable stack of summary rows where a
 * 16px-gap grid would waste most of the viewport on air.
 *
 * REACH: `neu-raised-sm` extends 8px, so a list of these rows is safe from
 * `gap-3` (12px) up — the geometry note on `neumorphicShadows['raised-sm']`
 * owns that number. Do NOT swap this in for {@link raisedSurface} on a
 * standalone card: a big surface with a small bevel reads flat.
 */
export const raisedSurfaceSm = 'rounded-md border border-line bg-canvas neu-raised-sm';

/** Press + focus feedback for a {@link raisedSurfaceSm} row (see
 *  {@link raisedInteractive} — same contract at the small bevel). */
export const raisedInteractiveSm =
  'transition-shadow active:neu-pressed-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
