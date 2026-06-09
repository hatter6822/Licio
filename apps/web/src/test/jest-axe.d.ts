// SPDX-License-Identifier: AGPL-3.0-or-later
//
// jest-axe@9 ships no type declarations, so we declare the small surface we use.
declare module 'jest-axe' {
  export interface AxeNodeResult {
    readonly html: string;
    readonly target: readonly string[];
    readonly failureSummary?: string;
  }

  export interface AxeViolation {
    readonly id: string;
    readonly impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null;
    readonly description: string;
    readonly help: string;
    readonly helpUrl: string;
    readonly nodes: readonly AxeNodeResult[];
  }

  export interface AxeResults {
    readonly violations: AxeViolation[];
    readonly passes: unknown[];
    readonly incomplete: unknown[];
    readonly inapplicable: unknown[];
  }

  export interface JestAxeConfigureOptions {
    readonly rules?: Record<string, { enabled: boolean }>;
    readonly [option: string]: unknown;
  }

  export function axe(
    html: Element | string,
    options?: JestAxeConfigureOptions,
  ): Promise<AxeResults>;

  export function configureAxe(options?: JestAxeConfigureOptions): typeof axe;

  export const toHaveNoViolations: {
    toHaveNoViolations(results: AxeResults): { pass: boolean; message(): string };
  };
}
