// focusThisWindow: the page's side of the shell's `focus` request. Its
// answer is what lets a launch window close itself and leave the file to
// the window that has it (main.ts openLaunched), so what counts as
// "fronted" is pinned here: only a shell that answers {focused: true}. An
// older shell (null to anything it does not know), a bridge that fails,
// an answer without the field, and no shell at all are all "no".
import { focusThisWindow, isNativeShell } from './claerbout';

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log('  ok ', name);
  else {
    console.error(' FAIL', name);
    failed++;
  }
}

const asked: Record<string, unknown>[] = [];
const global = globalThis as { window?: unknown };
/** A shell bridge on `window`, answering every request the given way. */
function shell(answer: () => Promise<unknown>): void {
  global.window = {
    claerbout: {
      request: (message: Record<string, unknown>) => {
        asked.push(message);
        return answer();
      },
      on: () => () => {},
    },
  };
}

console.log('focusThisWindow');

delete global.window;
check('no shell: not in the app, nothing to ask', !isNativeShell() && (await focusThisWindow()) === false);

shell(async () => ({ focused: true }));
check('the shell is present', isNativeShell());
check('a shell that fronted the window: true', (await focusThisWindow()) === true);
check('what it was asked', JSON.stringify(asked.at(-1)) === '{"type":"focus"}');

shell(async () => null);
check('an older shell answers null: false', (await focusThisWindow()) === false);

shell(async () => ({}));
check('an answer without focused: false', (await focusThisWindow()) === false);

shell(async () => ({ focused: false }));
check('a shell that could not: false', (await focusThisWindow()) === false);

shell(() => Promise.reject(new Error('the bridge is down')));
check('a failing bridge: false, never a rejection', (await focusThisWindow()) === false);

if (failed) {
  console.error(`\n${failed} focusThisWindow test(s) failed`);
  process.exit(1);
}
console.log('\nall focusThisWindow tests passed');
