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

interface QueryMessage {
  type: 'query';
  id: string;
  handle: FileSystemFileHandle;
}

interface ClaimMessage {
  type: 'claim';
  id: string;
  name: string;
}

const CHANNEL_NAME = 'plass-open-files';
/** How long to wait for another window to speak up. Windows answer from a
 *  message handler, so this is scheduling latency, not I/O — but opening a
 *  file must never hang on a window that is wedged, so the wait is bounded
 *  and silence means "nobody has it". */
const ANSWER_MS = 200;

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
  if (query?.type !== 'query' || !held) return;
  try {
    if (await held.isSameEntry(query.handle)) {
      channel?.postMessage({ type: 'claim', id: query.id, name: held.name } satisfies ClaimMessage);
    }
  } catch {
    // A handle that can no longer be compared is not a claim on anything.
  }
}

/** The name another window is already showing for this file, or null if no
 *  window answers. Never rejects: a browser without BroadcastChannel, or a
 *  window that does not reply, simply means "nobody else has it". */
export function openInAnotherWindow(handle: FileSystemFileHandle): Promise<string | null> {
  const ch = ensureChannel();
  if (!ch) return Promise.resolve(null);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const done = (name: string | null) => {
      window.clearTimeout(timer);
      ch.removeEventListener('message', onMessage);
      resolve(name);
    };
    const onMessage = (event: MessageEvent) => {
      const claim = event.data as ClaimMessage | null;
      if (claim?.type === 'claim' && claim.id === id) done(claim.name);
    };
    const timer = window.setTimeout(() => done(null), ANSWER_MS);
    ch.addEventListener('message', onMessage);
    try {
      ch.postMessage({ type: 'query', id, handle } satisfies QueryMessage);
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
