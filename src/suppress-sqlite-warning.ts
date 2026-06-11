/**
 * Node 22 prints an ExperimentalWarning the first time `node:sqlite` loads.
 * The state registry is core machinery, so that warning is pure noise — filter
 * it (and ONLY it) by intercepting `process.emitWarning`.
 *
 * This module is imported for its side effect and MUST stay the first import
 * of `cli.ts`: imports hoist, so any later import that transitively loads
 * `node:sqlite` would otherwise emit before the filter is installed.
 */
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: ReadonlyArray<never>) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...args: ReadonlyArray<unknown>) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
