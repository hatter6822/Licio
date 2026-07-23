// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Diagnosis for a failed `server.listen` — the boot's LAST possible failure and
// the one an operator hits most often locally.
//
// Left unhandled, the server's `'error'` event becomes an uncaught exception:
// the terminal fills with a `node:net` stack ending in `EADDRINUSE` and
// `address: '::'`, which says what the kernel refused but nothing about what to
// do. This module turns each known cause into one sentence naming the PORT and
// the NEXT ACTION.
//
// It is a pure string function, separate from `index.ts`, so the wording is
// unit-testable without booting the whole API (importing `index.ts` would run
// the entire production wiring).

/**
 * The `code` of a Node system error, extracted without a cast or `any`: an
 * `'error'` listener is typed as receiving `Error`, but a listen failure is
 * really an `ErrnoException` carrying the interesting part.
 */
export function systemErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** The kill hint for the current platform (Windows has no `lsof`). */
function freePortHint(port: number): string {
  return process.platform === 'win32'
    ? `\`netstat -ano | findstr :${port}\` then \`taskkill /PID <pid> /F\``
    : `\`lsof -ti :${port} | xargs kill -9\``;
}

/**
 * A one-line, actionable explanation of why the server could not listen.
 *
 * `EADDRINUSE` gets the longest treatment because its usual cause is
 * non-obvious: a `tsx watch` supervisor RESPAWNS its child, so killing only the
 * process holding the port brings it straight back — the watcher has to go too.
 * That is exactly the loop a developer gets stuck in after closing a terminal
 * without stopping `pnpm dev`.
 */
export function describeListenFailure(code: string | undefined, port: number): string {
  switch (code) {
    case 'EADDRINUSE':
      return (
        `Port ${port} is already in use — this API cannot start. Another instance is ` +
        'probably still running: a second `pnpm dev`, or a previous run whose `tsx watch` ' +
        'supervisor outlived its terminal. Killing only the process on the port is not ' +
        'enough — the watcher respawns it, so stop the watcher too: ' +
        `${freePortHint(port)}, then kill any lingering \`tsx watch src/index.ts\`. ` +
        'Or leave it alone and start this instance elsewhere with `PORT=<n>`.'
      );
    case 'EACCES':
      return (
        `Permission denied binding port ${port}. Ports below 1024 are privileged; ` +
        'choose a higher one with `PORT=<n>` (or grant the capability deliberately).'
      );
    case 'EADDRNOTAVAIL':
      return (
        `The configured address is not available on this host, so port ${port} could not ` +
        'be bound. Check any HOST/interface override — the address must belong to a local ' +
        'network interface.'
      );
    default:
      return (
        `The server failed to listen on port ${port}` +
        `${code === undefined ? '' : ` (${code})`}. ` +
        'The API did not start; see the attached error.'
      );
  }
}
