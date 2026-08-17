// Tiny shared state for the compiler timeout circuit. This module must stay
// dependency-free: main.ts imports it at startup without pulling the lazy
// Typst worker or its 28 MiB WASM into the application entry point.

let epoch = 0;
let blockedThrough = -1;

/** Stamp work with the input generation that authorized it. */
export function compilerCircuitEpoch(): number {
  return epoch;
}

/** A timeout quarantines its own input generation and any older work. */
export function isCompilerCircuitEpochBlocked(workEpoch: number): boolean {
  return workEpoch <= blockedThrough;
}

export function isCompilerCircuitOpen(): boolean {
  return isCompilerCircuitEpochBlocked(epoch);
}

/** Quarantine background work from a timed-out generation. */
export function openCompilerCircuit(workEpoch: number): void {
  blockedThrough = Math.max(blockedThrough, workEpoch);
}

/** A document edit/replacement or explicit export action authorizes one new
 * compiler lifecycle. A timeout in that lifecycle opens it again. */
export function resetCompilerCircuit(): void {
  epoch++;
}
