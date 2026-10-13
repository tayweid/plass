// One toast for the app (#toast, main.ts showMessage). Modules that refuse
// an edit or report a result say so here; main.ts installs the sink. Before
// it does (tests, a headless import) a message goes to the console.

type Sink = (text: string) => void;

let sink: Sink | null = null;

export function setNotifySink(fn: Sink): void {
  sink = fn;
}

export function notify(text: string): void {
  if (sink) sink(text);
  else console.warn(text);
}
