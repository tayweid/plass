// One window per file.
//
// Two Plass windows on one file autosave over each other: each holds its own
// disk baseline, so the second window's "unchanged since I last looked" is the
// first window's stale text. Whichever types last wins and the other's work
// goes without a conflict ever being reported — the one failure mode the
// conflict machinery cannot see, because both writers are Plass.
//
// Windows of one app are same-origin, so they can simply ask each other. A
// file handle is structured-cloneable, which means isSameEntry() can answer
// exactly; inventing a path key instead would call two different files with
// the same name in different folders the same file.
//
// A launch may ask the holder to come forward as well (`front`). Only the
// holder can: in Plass.app the shell fronts a window on that window's own
// request (claerbout.ts), and the shell knows windows while the pages know
// handles, so the window that finds its file elsewhere cannot name the
// holder to anyone. The holder claims first and says afterwards whether it
// was fronted, which is what tells a launch window it may go away.

import { focusThisWindow } from './claerbout';

interface QueryMessage {
  type: 'query';
  id: string;
  handle: FileSystemFileHandle;
  /** Bring yourself forward if you have it. */
  front?: boolean;
}

interface ClaimMessage {
  type: 'claim';
  id: string;
  name: string;
}

/** After its claim, a holder asked to `front` says whether its shell did.
 *  Its own message because fronting a minimized window takes the shell
 *  ~250 ms (macOS un-minimizes it before answering), longer than an asker
 *  waits for silence. */
interface FrontedMessage {
  type: 'fronted';
  id: string;
  focused: boolean;
}

/** Another window's claim on a file: what it calls the file, and whether
 *  that window was brought forward (only when asked, and only where a
 *  shell can). */
interface Elsewhere {
  name: string;
  focused: boolean;
}

const CHANNEL_NAME = 'plass-open-files';
/** How long to wait for another window to speak up. Windows answer from a
 *  message handler, so this is scheduling latency, not I/O — but opening a
 *  file must never hang on a window that is wedged, so the wait is bounded
 *  and silence means "nobody has it". */
const ANSWER_MS = 200;
/** How long a claimed fronting may take: a shell round trip that, for a
 *  minimized window, includes macOS restoring it. Waited only once a holder
 *  has claimed, so a file nobody has still opens after ANSWER_MS. */
const FRONT_MS = 2000;

let channel: BroadcastChannel | null = null;
/** The file THIS window has open, for answering other windows. */
let held: FileSystemFileHandle | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel !== 'function') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  // A BroadcastChannel never delivers to the window that posted, so this
  // only ever answers other windows.
  channel.addEventListener('message', (event: MessageEvent) => void answer(event.data));
  return channel;
}

async function answer(message: unknown): Promise<void> {
  const query = message as QueryMessage | null;
  const mine = held;
  if (query?.type !== 'query' || !mine) return;
  try {
    if (!(await mine.isSameEntry(query.handle))) return;
  } catch {
    return; // A handle that can no longer be compared is not a claim on anything.
  }
  channel?.postMessage({ type: 'claim', id: query.id, name: mine.name } satisfies ClaimMessage);
  if (query.front !== true) return;
  // A shell without the request, or none, answers false; the asker hears
  // that and keeps its toast.
  const focused = await focusThisWindow();
  channel?.postMessage({ type: 'fronted', id: query.id, focused } satisfies FrontedMessage);
}

/** What another window already showing this file calls it, and whether that
 *  window came forward when `front` asked it to; null if no window answers.
 *  Never rejects: a browser without BroadcastChannel, or a window that does
 *  not reply, simply means "nobody else has it". */
export function openInAnotherWindow(handle: FileSystemFileHandle, front = false): Promise<Elsewhere | null> {
  const ch = ensureChannel();
  if (!ch) return Promise.resolve(null);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let claimed: string | null = null;
    let timer = 0;
    const done = (elsewhere: Elsewhere | null) => {
      window.clearTimeout(timer);
      ch.removeEventListener('message', onMessage);
      resolve(elsewhere);
    };
    const onMessage = (event: MessageEvent) => {
      const reply = event.data as ClaimMessage | FrontedMessage | null;
      if (reply?.id !== id) return;
      if (reply.type === 'claim' && claimed === null) {
        if (!front) return done({ name: reply.name, focused: false });
        // Someone has it and is asking its shell: give that its own time.
        claimed = reply.name;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => done({ name: reply.name, focused: false }), FRONT_MS);
      } else if (reply.type === 'fronted' && claimed !== null) {
        done({ name: claimed, focused: reply.focused === true });
      }
    };
    timer = window.setTimeout(() => done(null), ANSWER_MS);
    ch.addEventListener('message', onMessage);
    try {
      ch.postMessage({ type: 'query', id, handle, front } satisfies QueryMessage);
    } catch {
      done(null);
    }
  });
}

/** Declare which file this window has open — null when it lets go. */
export function holdOpenFile(handle: FileSystemFileHandle | null): void {
  held = handle;
  if (handle) ensureChannel();
}
