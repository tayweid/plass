// Low-level Typst entry points for security probes, differential tests, and
// the frozen paragraph-fragment research oracle. Product editor paint and
// layout must use the brokered whole-document publication in pdf.ts.

import {
  runCoordinatedCompilerTask,
  runFinalCompilerTask,
  type CompilerValue,
  type CoordinatedCompileRequest,
} from '../compiler/coordinated-compiler';
import {
  COMPILER_DEADLINES,
  type CompilerTask,
} from '../typst-worker-protocol';

async function runDirectCompilerTask<T extends CompilerValue>(
  task: CompilerTask,
  options: { timeoutMs: number; onMessage?: (message: string) => void },
): Promise<T> {
  const { runCompilerTask } = await import('../typst-worker-client');
  return runCompilerTask<T>(task, options);
}

export function compileSvg(
  src: string,
  onMsg: (message: string) => void = () => {},
  coordinated?: CoordinatedCompileRequest,
): Promise<string | null> {
  const task = { kind: 'svg' as const, source: src };
  const promise = coordinated
    ? runCoordinatedCompilerTask<string>(task, {
        ...coordinated,
        timeoutMs: COMPILER_DEADLINES.previewMs,
        onMessage: onMsg,
      })
    : runDirectCompilerTask<string>(task, {
        timeoutMs: COMPILER_DEADLINES.previewMs,
        onMessage: onMsg,
      });
  return promise.catch((error) => {
    console.warn('research fragment compile failed', error);
    return null;
  });
}

export function typstQuery<T = unknown>(
  src: string,
  selector: string,
  onMsg: (message: string) => void = () => {},
  coordinated?: CoordinatedCompileRequest,
): Promise<T[] | null> {
  const task = { kind: 'query' as const, source: src, selector };
  const promise = coordinated
    ? runCoordinatedCompilerTask<unknown[]>(task, {
        ...coordinated,
        timeoutMs: COMPILER_DEADLINES.previewMs,
        onMessage: onMsg,
      })
    : runDirectCompilerTask<unknown[]>(task, {
        timeoutMs: COMPILER_DEADLINES.previewMs,
        onMessage: onMsg,
      });
  return promise.then(
    (value) => value as T[],
    (error) => {
      console.warn('research Typst query failed', error);
      return null;
    },
  );
}

export function compileTyp(
  src: string,
  onMsg: (message: string) => void = () => {},
): Promise<Uint8Array> {
  return runFinalCompilerTask<Uint8Array>(
    { kind: 'pdf', source: src, assets: [] },
    { timeoutMs: COMPILER_DEADLINES.exportMs, onMessage: onMsg },
  );
}
