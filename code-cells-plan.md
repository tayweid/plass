# Plan: Executable Code Cells in wys

Goal: bring pymd's executable Python cells into wys as a first-class block type, so wys becomes the single editor. pymd's editor layer (Milkdown/ProseMirror + CodeMirror NodeViews) is conceptually close to wys's, and its Python backend is nearly drop-in — so this is mostly a port of pymd's *patterns* onto wys's *plumbing*, not a rewrite of either.

## What each project contributes

**From wys (unchanged foundation):**
- ProseMirror document model with a well-worn "add a block type" checklist (schema → NodeView → typeset-plugin pagination → typ-serializer/parser → editing/toolbar).
- The FigureView pattern (`src/figures.ts`) — a block NodeView hosting a foreign interactive widget with correct `stopEvent`/`ignoreMutation` scoping and `scheduleTypeset()` on async content load. A code cell is "FigureView where the widget is CodeMirror and the image is execution output."
- Typst serialization + PDF export pipeline.

**From pymd (ported):**
- The Python sidecar (`python/pymd_server/`: `executor.py`, `server.py`) — persistent-namespace exec, stdout/stderr/traceback capture, matplotlib figure capture to base64 PNG, WebSocket protocol (`execute_block`, `execute_all`, `execute_up_to`, `reset`). Reusable nearly verbatim.
- The WebSocket client (`src/services/pymdClient.ts`) — event-emitter wrapper with auto-reconnect.
- The PM↔CodeMirror bridge mechanics from `src/plugins/codeMirrorBlock.ts`: `forwardUpdate()` (CM edits → PM transactions), `update()` (PM changes → CM), arrow-key/Backspace escape handling at cell boundaries.
- The output-cache idea: outputs live in a sidecar JSON keyed by hash(code), never in the document file. The `.typ` stays clean, and unchanged cells restore their outputs on open without re-running.

## Key design decisions

### 1. Node shape: textblock, not atom
`code_cell` is a textblock (`content: "text*"`, `code: true`, `marks: ""`) with attrs `{ lang: 'python', id, flags }`. Source lives as PM text content — this keeps undo history, find, and serialization natural, and matches both the official PM/CodeMirror example and pymd's implementation. Outputs do **not** go in attrs (they'd bloat undo history and localStorage); they live in a runtime store + sidecar cache (decision 4).

### 2. Execution backend: pymd's sidecar first, behind an interface
Define a small `Executor` interface (`execute(cellId, code)`, `executeAll`, `reset`, events for results/status). First implementation: pymd's `pymd_server` over localhost WebSocket — real CPython, real matplotlib/pandas, already written. wys is a plain browser app (no Tauri), so the server is started manually or via an npm script (`concurrently "vite" "pymd-server --port 9742"`); the UI shows a connect-status indicator and cells degrade gracefully to read-only-source when disconnected.

Pyodide-in-a-worker (the wys spec's v2 idea) becomes a second `Executor` implementation later if a zero-install browser-only mode matters. Don't build it first — it's slower to load, weaker for plotting, and the interface keeps the door open.

### 3. Serialization: Typst raw block with an exec marker
`blockToTyp` emits a fenced raw block whose language tag carries the metadata, mirroring pymd's info-string approach:

    ```python-exec
    x = 42
    print(x)
    ```

(plus flags like `python-exec hide` appended to the tag). `typ-parser` recognizes the `*-exec` suffix and rebuilds a `code_cell`; any other parser sees a legal Typst raw block, and older wys builds round-trip it losslessly as a `typst-raw` island. Byte-identical round-trip is testable in the existing `typ-parser.test.ts` style.

### 4. Outputs: runtime store + sidecar cache, baked into PDF at export
- **Runtime:** a `Map<cellId, Output>` (`{stdout, stderr, error, figures: dataURI[]}`) owned by the executor module; NodeViews subscribe and render into their output div. Height changes call `scheduleTypeset(view)` so pagination stays correct (same as FigureView on image load).
- **Persistence:** on each result, debounce-write `<file>.outputs.json` next to the `.typ` via the existing file-manager handle, keyed by `hash(code)` (pymd's scheme — cache invalidates automatically when code changes). On open, restore matching outputs without executing.
- **PDF export:** Typst can't run Python, so `docToTyp()` for export injects cached outputs after each cell — stdout/errors as a styled raw block, figures as images registered through `prepareAssets()` into the Typst VFS. `hide`-flagged cells emit output only.

### 5. Pagination: atomic first, splittable later
Cells take the existing `atomic()` path in `paginate()` — whole cell moves to the next page. That's correct for typical cells and ships Phase 1. Cells/outputs taller than a page overflow (known wys limitation shared by figures/tables today); a splittable handler (break between source and output, or at CM line boundaries) is deliberately deferred to Phase 4 since it's genuinely new pagination work.

## Phases

### Phase 1 — Inert code cell block (no execution)
1. `src/schema.ts`: add `code_cell` NodeSpec (after `schema.ts:169-175` customs).
2. New `src/code-cell.ts`: `CodeCellView` NodeView — CodeMirror 6 (`codemirror`, `@codemirror/lang-python`) + header chrome + empty output div. Port pymd's `forwardUpdate`/`update` sync and boundary-key handling; copy FigureView's `stopEvent`/`ignoreMutation` scoping. Add `insertCodeCell` command.
3. Register in `nodeViews` (`src/main.ts:121-127`); toolbar button (`src/toolbar.ts` structure group); ``` ```py ``` -style input rule + keymap entries (`src/editing.ts`).
4. `src/typ-serializer.ts` + `src/typ-parser.ts`: `python-exec` raw-block round-trip, with tests.
5. `src/style.css`: cell chrome + `@media print` rules. Bottom-margin-only spacing (wys spacer-math invariant).

**Risk to verify early:** CM-in-PM sync must not storm the typeset loop. `dispatchDecos` already skips non-paragraphs, but every PM transaction re-runs pagination (~6–8ms/13pp); confirm typing in a cell stays smooth, debounce CM→PM sync if not.

### Phase 2 — Execution
1. Copy `python/pymd_server/` into wys (or better: extract it as a tiny shared package both projects install). Add `npm run dev:full` to launch server + Vite.
2. New `src/executor.ts`: the `Executor` interface + WebSocket implementation (port `pymdClient.ts`), connection-status indicator.
3. Wire the cell: Run button + Shift-Enter → `execute_block`; spinner/error states; render stdout/stderr/traceback/figures in the output div; `scheduleTypeset` on output change.
4. "Run all" and "run up to here" commands (Cmd-Shift-Enter) — the plumbing pymd has but never wired to the UI; document-order cell collection is a simple doc walk.

### Phase 3 — Output persistence + export
1. Sidecar `.outputs.json` cache (save debounced on results, restore on open) via `file-manager.ts`.
2. Export path: bake outputs into the generated `.typ` for PDF (stdout blocks, figures through `prepareAssets` VFS); respect `hide`.

### Phase 4 — Later, if wanted
- Pyodide `Executor` for a server-less browser mode.
- Page-splitting for tall cells/outputs.
- pymd's `{{variable}}` inline interpolation as PM decorations (the namespace snapshot already arrives with every result).
- Stale-state indicators / run-from-top semantics (pymd's `rerun` flag).

## Suggested first verification milestones
- End of Phase 1: create/edit/delete cells, undo works across cell edits, `.typ` round-trip byte-identical, pagination correct with a cell mid-document.
- End of Phase 2: two cells sharing namespace (`x=1` then `print(x)`), a matplotlib figure rendering inline and repaginating the page below it.
- End of Phase 3: close and reopen a document → outputs restored without execution; exported PDF shows code + outputs.
