# Typeset Editor — Design Conversation

**Date:** July 6, 2026
**Participants:** Taylor, Claude Fable 5

---

## Taylor

hey can you tell me about typst and how it compares to something like the nice wysiwyg in typora for example

## Claude

**Typst** is a markup-based typesetting system — think of it as a modern replacement for LaTeX. You write plain text with lightweight markup syntax (headings with `=`, bold with `*`, math in `$ $`), and a compiler turns it into PDFs. It was first released open-source in March 2023 and has been growing fast — GitHub ranked it the second fastest-growing language by percentage in 2025. The latest version (0.15, released literally last week) added variable fonts, HTML export with MathML, multi-file bundle export, and multiple bibliographies.

**Typora** is a WYSIWYG Markdown editor — you type Markdown but it renders inline as you go, so you never see raw syntax unless you want to. It's for writing prose documents, blog posts, notes, etc.

The key differences that matter:

**Paradigm.** Typst is code-in, PDF-out. You're writing in a text file with markup and scripting, then compiling. Typora hides the markup and gives you a "what you see is what you get" live rendering experience. Typst has a web app with instant preview side-by-side, but it's still fundamentally a two-pane source-and-output workflow.

**Power ceiling.** This is where Typst pulls way ahead. It has a full scripting language built in — loops, conditionals, functions, data loading from JSON/CSV — so you can automate document generation, build custom components, and do things like generate tables from data programmatically. Typora is just Markdown with some extensions; there's no programmability.

**Math.** Typst's math mode is excellent and purpose-built for academic work — cleaner syntax than LaTeX (`sqrt(x)` instead of `\sqrt{x}`), no backslash hell. Typora supports LaTeX math via MathJax/KaTeX, which works fine but you're still writing LaTeX syntax for the math parts.

**Output quality.** Typst produces publication-quality typeset PDFs with proper paragraph optimization (same Knuth-Plass algorithm as LaTeX), intelligent page breaks, float placement for figures, proper kerning, ligatures, microtypography. Plus accessible PDF/UA-1 output by default. Typora outputs Markdown, which you can export to PDF/HTML/Word, but the typographic quality is nowhere close.

**Use case fit.** For academic papers or anything headed toward publication, Typst would be the tool — it's in the same category as LaTeX, just dramatically more pleasant to use. For quick notes, blog drafts, or prose where you want zero friction and a clean writing environment, Typora's WYSIWYG is hard to beat. They're not really competitors.

One caveat on the academic side: journal acceptance is still very limited — as of early 2026 only two journals natively accept Typst manuscripts. So you'd likely still need to export or convert for submission, though the PDF output itself is accepted broadly.

---

## Taylor

well I've also been thinking about an app for making python in markdown and a way of writing latex like in typora. so just thinking about a wysiwyg but powerful.

## Claude

What you're really after is the intersection: a writing environment that feels as clean as Typora but can also run Python and render LaTeX inline. That's a more specific and interesting design space. A few things worth knowing about:

**Quarto** is probably the closest to what you're describing. It's markdown-based with executable Python (or R/Julia) code blocks, full LaTeX math support, and it outputs to PDF, HTML, slides, websites, books — basically anything. The key thing: it has a visual editor mode (in both VS Code and RStudio) that gives you a WYSIWYM interface for all of Pandoc markdown, including inline math rendering, tables, citations, cross-references, and you can execute code cells and see output inline. You can toggle between source and visual mode at any time. It's built by Posit (the RStudio people) and is very mature.

The catch is that the visual editor experience in VS Code isn't quite as polished as in RStudio — code outputs go to the console rather than rendering inline in the document. So the WYSIWYG-ness has gaps depending on which editor you use.

**Marimo** is the newer, more exciting option if the Python side matters as much as the writing side. It's a reactive Python notebook — run a cell or interact with a UI element and it automatically reruns dependent cells, keeping everything consistent. Notebooks are stored as pure Python files, which means they're git-friendly (unlike Jupyter's JSON mess). You can write markdown with `mo.md`, interpolate Python values directly into it with f-strings, and it supports LaTeX math. It also has a markdown editor mode with hotkeys for formatting. The reactive model is really compelling for teaching — you could build interactive explorations where students drag a slider and the whole analysis updates.

The tradeoff: Marimo is notebook-first, document-second. It's amazing for computational narratives and interactive apps, but it's not trying to be a Typora-like prose writing environment. The writing experience is "write markdown inside Python cells," not "write a document with code embedded in it."

Neither one is quite the "Typora but with Python and LaTeX superpowers" dream tool though. That app kind of doesn't exist yet in a fully polished form.

---

## Taylor

yeah I just want it to exist and seem technically possible

## Claude

Yeah, it's totally technically possible. All the pieces exist independently and are well-proven:

The editor layer would be something like **ProseMirror** or **TipTap** — these are the same rich-text editing frameworks that power Notion, Typora-style editors, and even Quarto's visual mode. They handle the WYSIWYG markdown rendering, cursor behavior, inline formatting, all of that. Very mature.

LaTeX rendering inline is solved — **KaTeX** renders math in milliseconds, fast enough to render as-you-type the way Typora does. No compile step needed.

Python execution is solved — you either talk to a **Jupyter kernel** over the wire (ipykernel is battle-tested) or run **Pyodide** in-browser for a zero-install version. Marimo proved the reactive dependency graph approach works beautifully.

Code editing inside the document is solved — **CodeMirror 6** gives you a proper code editor widget that you embed inside the rich text flow, with syntax highlighting, completions, the works.

The file format question is solved too — it's just markdown with fenced code blocks. Quarto's `.qmd` and Marimo's `.md` format both demonstrate this works fine with git.

So why doesn't the integrated thing exist? It's a market/incentive gap more than a technical one. The notebook people (Jupyter, Marimo) build outward from computation and treat prose as decoration. The writing-tool people (Typora, Obsidian) build outward from text and treat code as an afterthought. Quarto bridges them but inherited the two-pane compile-and-preview paradigm from LaTeX/RMarkdown rather than going full WYSIWYG.

The hard-but-doable engineering is really just the seams — making code output (a matplotlib figure, a pandas table) flow naturally into the rich text document layout, handling reactivity without jank, and keeping the underlying markdown file clean and portable. None of that is unsolved, it's just product integration work that nobody has prioritized as a single coherent vision.

Honestly it's a very buildable side project if someone with the right frustration level decided to glue TipTap + CodeMirror + ipykernel + KaTeX together with an Electron or Tauri shell. The hard part would be polish, not architecture.

---

## Taylor

it seems the hard part is really the fully featured latex formatting typesetting right? or is that also solved

## Claude

That's the right question, and it depends on what you mean by "LaTeX formatting."

**Math rendering** — totally solved. KaTeX does it in sub-millisecond, in-browser, as you type. That's a closed problem.

**Full document typesetting** — this is the genuinely hard part, and it's *not* solved for WYSIWYG. Here's why:

Publication-quality typesetting means Knuth-Plass paragraph optimization (looking at a whole paragraph to decide where to break lines, not just greedily wrapping), intelligent page breaks, float placement for figures, proper kerning, ligatures, microtypography. LaTeX does all of this. Typst does it too, faster. But they're both compilers — they take source in, emit PDF out. The editing surface and the output are separate things.

In a WYSIWYG editor, your editing surface is the browser DOM, and the browser's text layout engine is CSS. CSS does greedy line wrapping, not Knuth-Plass. It doesn't do intelligent page breaks or academic float placement. So you hit a fundamental tension: either you accept browser-quality layout (which is honestly fine for 90% of use cases — lecture notes, course materials, blog posts) or you need a compiler in the loop, which pushes you back toward a preview pane.

The interesting middle ground is that **Typst compiles fast enough** (low milliseconds, incremental) that you could plausibly use it as a live rendering backend — type in a WYSIWYG editor, sync the underlying markup to Typst, render the output, and display it so fast it feels like WYSIWYG. Typst's web app already does something close to this. But the editing surface still isn't the output surface, it just updates fast enough that the distinction feels small.

So the honest answer: if your standard is "looks good on screen and in HTML/PDF export" — solved, use the browser. If your standard is "typeset like a journal article" — solved as a compiler, not solved as WYSIWYG editing. The gap is narrow and shrinking (Typst's speed makes near-WYSIWYG viable), but true "edit directly in the typeset output" at publication quality doesn't exist and is architecturally hard.

---

## Taylor

is pure latex as fast as typst? and what are the 10 percent you mention that latex is truly better

## Claude

No, not even close on speed. LaTeX is orders of magnitude slower. A moderately complex paper might take 1-3 seconds to compile with pdflatex, and you often need multiple passes (for references, citations, cross-refs) so it's more like 3-9 seconds. LuaLaTeX is even slower. Typst compiles the same document in low milliseconds with incremental compilation — it only reprocesses what changed. That's the whole reason Typst's web app can give you instant preview that feels almost live.

On the 10% where LaTeX genuinely wins — the real list of things that require a proper typesetting engine (LaTeX or Typst, not browser layout) is something like:

**Knuth-Plass paragraph optimization** is the big one. It considers all possible line breaks in a paragraph simultaneously and minimizes a global "badness" metric. The browser just fills lines greedily left to right. For body text in a well-typeset book or paper the difference is subtle but real — fewer rivers of whitespace, more even spacing, better hyphenation decisions.

**Float placement** — figures and tables that intelligently position themselves across pages based on where they fit best rather than just landing wherever they appear in the source. CSS has nothing like this.

**Page-aware layout generally** — widows, orphans, footnotes that split across pages, running headers that change based on what section you're in, margin notes. The browser doesn't think in pages at all.

**Microtypography** — character protrusion (letting hyphens and punctuation hang slightly into the margin for a visually cleaner edge), font expansion (subtly stretching or compressing glyphs to improve justification). LaTeX does this with the microtype package. Typst added character-level justification in 0.14.

**Cross-reference and bibliography systems** — LaTeX's ecosystem here is deep (biblatex, cleveref, etc.), though Typst is catching up fast.

The thing is, Typst handles almost all of these too, and often more cleanly. The remaining gap where LaTeX is truly better is really just ecosystem and inertia — specific journal templates, niche packages (tikz for complex diagrams, minted for code listings, exotic math notation), and the 40+ years of accumulated community solutions for weird edge cases.

---

## Taylor

maybe the way to do it is a wysiwyg that exports to latex to render. but I just think someone should do the real thing. any thoughts on how it could be done?

## Claude

The WYSIWYG-that-exports-to-LaTeX approach has been tried — LyX has been doing it since the 90s. It's clunky because you're constantly fighting the impedance mismatch between the editing model and LaTeX's macro expansion model. You end up with a tool that's worse at editing than Typora and worse at LaTeX than just writing LaTeX.

The "real thing" is more interesting to think about. The core architectural question is: what is your rendering surface?

**Option 1: Canvas/WebGL.** You stop fighting the browser's layout engine entirely. Your editing surface is a canvas. You implement Knuth-Plass, float placement, page breaks, microtypography — all of it — as your own layout engine that paints to canvas. Text selection, cursor placement, IME input, accessibility — you reimplement all of it on top. This is basically what Google Docs does. It's a massive engineering lift but gives you total control.

**Option 2: Typst-as-WASM-library.** This is the more interesting path. Typst is written in Rust, already compiles to WASM, does incremental compilation in milliseconds, and gives you a fully laid-out document with precise glyph positions. So the architecture would be:

You build a ProseMirror/TipTap editing layer that captures user intent. That layer maintains an AST that maps bidirectionally to Typst markup. On every edit, you push the updated markup into Typst-WASM, which returns a laid-out frame tree with exact glyph positions, line breaks, page breaks, float placements, everything. You render that frame tree onto a canvas (or even SVG) as the display layer.

The hard problems become:

**Bidirectional mapping.** Every cursor position in the visual output needs to map back to a position in the markup AST. Typst's source mapping gives you most of this. But edge cases — cursor inside a macro expansion, inside a show rule — get gnarly.

**Latency budget.** For it to feel WYSIWYG, you need keystroke-to-repaint under ~16ms. So you'd want an optimistic rendering strategy: immediately update the editing layer with approximate layout (browser-quality), then async re-render from Typst and swap in the correct layout.

**The editing model gap.** In a rich text editor, you think in terms of "bold this selection." In Typst, that's `*this selection*` or a `#strong[]` call. Most of the time the mapping is trivial. But Typst's power comes from scripting. The right design is probably a mode spectrum: mostly WYSIWYG surface with an escape hatch to a source view for the programmable parts.

**Float placement feedback loops.** User inserts a figure. Typst places it on the next page. But the user is editing this page. Where does the figure appear in the editing view? That's a design problem more than an engineering one.

The Typst-WASM path is remarkably viable. The Typst team has already built 80% of the hardest parts. What's missing is someone building the editing shell around it. It's a year-long project for a small team, not a research problem.

---

## Taylor

yeah not interested in doing that. maybe fable 5 could do it quickly. maybe it's just going to be "looks 90 percent, export to latex to render for the last 10 percent".

## Claude

Yeah, that's probably the right landing spot. And honestly that's basically what Quarto already is — WYSIWYG-ish editing in the visual mode, looks great in HTML, and when you need camera-ready you flip the output format to PDF and it runs through LaTeX (or you could point it at Typst now). The 90% covers everything you'd use day-to-day for teaching and the 10% is there when you submit the Hyperstar paper.

Claude Fable 5 is Anthropic's latest Mythos-class model made safe for general use — the kind of tool that could just build the polished version quickly. The "glue TipTap + Typst-WASM + CodeMirror together" project is probably within spitting distance of what agentic coding can do now. The architecture is clear, the libraries exist, there's no novel research. It's integration and polish.

But the pragmatic move for right now is probably just to try Quarto's visual editor in VS Code for a week. It won't be the platonic ideal, but it covers the Python-in-markdown, inline LaTeX, nice output trifecta, and it's already built. The dream tool can wait for someone to get frustrated enough to build it — or for the models to get good enough to build it in a weekend.

---

## Taylor

the other thought was to embed the knuth algs into the css that does the rendering

## Claude

People have been trying this for over a decade and it kind of works. There are JS libraries like tex-linebreak2 that implement Knuth-Plass and apply it to the DOM by manipulating word spacing — rendering visible elements usually takes under 40ms. And there's a really clean recent one — a project called "kp" that uses canvas text measurement to get accurate glyph widths, runs the dynamic program, and encodes the break points back into the HTML.

The fundamental problem is that you have to wrap each word in spans, manipulate CSS word-spacing or absolute-position individual words, and some browsers don't even support sub-pixel word-spacing. You're fighting the browser rather than working with it. And it's fragile — resize the window, change the font, and you have to recompute everything.

But here's the actually interesting development: **browsers are starting to do this natively.** Chrome has shipped `text-wrap: pretty`, though the current implementation only optimizes the last four lines of a paragraph (to avoid orphans) rather than doing full Knuth-Plass across the whole paragraph.

The honest assessment: for a WYSIWYG editor, the JS-polyfill approach adds enough latency and fragility that it's probably not worth it during live editing. But you could do a hybrid — edit with browser-native layout, and when you hit "export" or "preview final," run Knuth-Plass over the output.

The deeper point though is that `text-wrap: pretty` becoming a real CSS property might just solve this over time. If Chrome eventually does full-paragraph optimization rather than just the last four lines, the gap between browser layout and TeX layout mostly disappears.

---

## Taylor

but how is typst doing fast but we can't build a web app that does the same?

## Claude

That's the right question and it kind of undermines the whole previous discussion. Typst *is* running in the browser. Their web app compiles Typst to WASM, runs the full layout engine — Knuth-Plass, float placement, page breaks, all of it — and renders the result. In milliseconds. Incrementally. It's already a web app that does the same thing.

The gap isn't computation. It's that Typst renders to a *display surface* (PDF pages shown as images, essentially) rather than to the DOM. The output is a picture of your document, not live editable browser text. So you can look at it but you can't click into it and type.

The reason you can't just swap the browser's layout engine for Typst's is that browsers tightly couple layout and editing. Text selection, cursor movement, IME composition, copy-paste, screen readers, right-click spell check — all of that depends on the text living in the DOM and being laid out by the browser's own engine.

So the real question is: how hard is that reimplementation? Google did it for Docs. Figma did it for design. Both use canvas rendering with custom text handling. It's hard but it's been done multiple times by well-funded teams.

For a Typst-based WYSIWYG specifically, the path would be: Typst-WASM does the layout and returns a frame tree with exact glyph positions and source mappings. You paint that to canvas. You build a thin input layer that captures keystrokes and maps click coordinates back to source positions via Typst's source map.

The honest answer: there's no technical reason we can't. It's just that nobody has built the editing shell yet. Typst's team is focused on the compiler and on their two-pane web app. The leap to true WYSIWYG is a product decision more than an engineering barrier. They have all the pieces.

---

## Taylor

is it open source?

## Claude

The compiler is — Apache 2.0 license, fully open source. That's the layout engine, the parser, the WASM build, all of it. You can embed it in your own applications commercially.

The web app is proprietary. That's the collaborative editor, the project management, the preview pane — all the product stuff around the compiler.

So the exact piece you'd need — the layout engine that does Knuth-Plass, float placement, incremental compilation, and compiles to WASM — is fully open source and explicitly designed to be used as a library. The editing shell that someone would need to build around it to make a WYSIWYG is the part that doesn't exist yet.

---

## Taylor

how long would building the editor take?

## Claude

Depends heavily on what "done" means, but roughly:

**Proof of concept (2-4 weeks, one person):** Typst-WASM renders to canvas, you can click to place a cursor, type characters, see the document re-render live. Basic formatting via keyboard shortcuts. Janky selection, no IME, breaks on edge cases constantly. Enough to make a demo video that gets people excited.

**Usable MVP (3-6 months, 2-3 people):** Solid text editing, selection, copy-paste, undo/redo. Inline math rendering. Code blocks with syntax highlighting (CodeMirror embedded). Basic formatting toolbar. Export to PDF. Good enough that you'd actually write a lecture note in it and not rage-quit. IME probably still broken, accessibility nonexistent, collaboration not even started.

**Real product (1-2 years, small team of 4-6):** IME support for international users, accessibility/screen readers, real-time collaboration (CRDT-based), file management, image handling, citation management, plugin system. The stuff that makes it competitive with Typora or Overleaf rather than just a cool demo.

The long pole is honestly not the rendering or the Typst integration — it's text editing. Building a correct, performant text editor that handles all the weird edge cases (bidi text, combining characters, emoji sequences, drag-and-drop, browser inconsistencies across platforms) is one of those problems that looks 80% done after a month and stays 80% done for a year. There's a reason ProseMirror and CodeMirror each took Marijn Haverbeke years to build.

The smart shortcut would be to not build the text input layer from scratch at all — use ProseMirror for input capture and editing state, but override the rendering pipeline to paint Typst's output instead of letting the browser lay out the DOM. You'd still fight some impedance mismatch but you'd skip the worst of the text-editing tar pit.

---

## Taylor

hmm I guess I still don't get why we couldn't get css to implement the typst alg

## Claude

You're right to push on this. There's no fundamental reason. The algorithm is well-known, fast, and Typst proved it can run in milliseconds. Chrome already ships `text-wrap: pretty` which is a half-step in this direction. The browser vendors could just... do it.

The reasons they haven't are institutional, not technical:

**Backward compatibility paranoia.** If Chrome changes how paragraphs break, every website in the world reflows. Text that used to fit in a div now doesn't. Layouts break. Ad placements shift. Somebody's e-commerce checkout button moves below the fold. Browser vendors are extremely conservative about changing layout behavior.

**No constituency is pushing for it.** The people who care about typography use LaTeX or Typst. Web developers mostly don't care. The CSS working group prioritizes features that web developers are actually asking for.

**The spec process is glacial.** Even if someone proposed full-paragraph optimization as a CSS property tomorrow, it would take years to get through the W3C process.

But the real answer: you're right, it's the obvious solution, and `text-wrap: pretty` is the opening wedge. If that property eventually expanded to do full-paragraph Knuth-Plass optimization rather than just the last four lines, you'd get 95% of Typst's layout quality for free in the DOM.

The frustrating thing is it's maybe a few engineer-months of work inside Chromium to just... do full Knuth-Plass in `text-wrap: pretty`. The algorithm is already partially there.

---

## Taylor

but does it require chromium? couldn't a css do it independently? or am I missing how it works?

## Claude

You're conflating two things, which is understandable because the terminology is confusing.

CSS is just a spec — a document that says "when a developer writes `text-wrap: pretty`, the browser should do X." It's literally a PDF on the W3C website. CSS doesn't execute anything. It's a description of desired behavior.

The thing that actually lays out text is the **browser engine's layout code** — C++ (or Rust in Firefox's case) that runs when the browser renders a page. Chromium has Blink, Firefox has Gecko, Safari has WebKit. Each one has its own implementation of line breaking, and each one currently does greedy first-fit.

So when people say "CSS should implement Knuth-Plass," what they mean is a two-step process: first the CSS working group adds a spec that says `text-wrap: optimal` (or whatever) should do full-paragraph optimization, and then each browser engine team writes the actual code to do it in their respective C++/Rust codebase.

There's no way to do it "in CSS" the way you can write a JavaScript polyfill. CSS doesn't have that kind of power — it's declarative. You can't write an algorithm in CSS. You're telling the browser what you want, and the browser decides how to do it.

So yeah, it necessarily requires changes to Chromium, Gecko, and WebKit. The good news is that all three are open source, and once one ships it the others tend to follow.

---

## Taylor

but I mean, chromium is putting words on the page in a particular way, I don't think anything latex could do can't be said to chromium in css. am I wrong that there's a one to one mapping there? then we just write the mapping.

## Claude

You're basically right. If Typst says "break this line here, use 3.2px word-spacing on line 4, hyphenate 'economics' after 'eco-'" — you can express all of that in CSS. Absolute positioning, `word-spacing`, soft hyphens, `letter-spacing`, `hanging-punctuation` for protrusion. The output mapping exists.

So the approach would be: run Typst (or just Knuth-Plass in JS) as a layout *oracle*, then translate its decisions into CSS properties, and let the browser render the DOM with those properties. The browser becomes a dumb renderer following instructions rather than making its own layout decisions.

And that's exactly what the JS polyfill libraries do. They work. The issues are practical, not fundamental:

**You have to re-run it on every change.** User types a character, you re-run Knuth-Plass on that paragraph, recompute the word-spacing values, update the DOM. At ~40ms per paragraph that's fine.

**Measurement circularity.** Knuth-Plass needs to know how wide each word is in pixels. To measure that accurately you need the browser to render the text first. So you measure → compute layout → apply layout → hope the measurements didn't change. Usually fine, occasionally janky.

**Resize.** Window changes width, every paragraph needs recomputation. Doable but it's work the browser currently does for free.

But yeah, your intuition is sound. There's no layout decision Typst can make that CSS can't express. The missing piece is just someone wiring the oracle to the renderer in a way that's robust and fast enough to feel native. It's genuinely not that hard.

---

## Taylor

you keep saying it'll be 40 ms, but typst does it much faster. and how hard would it be to write this? how long would it take?

## Claude

You're right, the 40ms is the JS polyfill number. Those libraries are implementing Knuth-Plass from scratch in JavaScript and doing expensive DOM measurement. If you use Typst-WASM as the oracle instead, you'd get Typst's speed — single-digit milliseconds, incremental. Way under one frame.

And the project scope is actually small when you frame it this way. You're not building an editor. You're not building a layout engine. Both exist. You're building a translation layer:

1. Typst-WASM takes markup, returns layout decisions (where to break, what spacing, where to hyphenate)
2. A thin JS layer translates those decisions into CSS properties on DOM nodes
3. Wire it into ProseMirror so edits trigger re-layout

That's it. You're not reimplementing text editing. You're not reimplementing layout. You're piping output from one existing thing into another existing thing.

A proof of concept — single paragraph, hardcoded font, no images or floats — could be a weekend. Maybe two.

A robust version handling multiple paragraphs, headings, figures, math blocks, resize, and integrated into a ProseMirror editor — maybe 2-4 weeks for someone who knows both the Typst API and ProseMirror internals.

The genuinely unknown part is how much of Typst's layout output is exposed in a structured way. If the WASM API gives you "line 3 breaks after word 7, word-spacing 3.1px" you're golden. If it only gives you "here's a rendered PDF page," you'd need to extract the layout decisions from the frame tree.

---

## Taylor

yeah and look into Claude fable 5 while you're at it

## Claude

### Typst internals — very promising

The Frame is Typst's core layout primitive — a rectangular container holding positioned items (text glyphs, shapes, images) at specific x,y coordinates. The layout engine produces a hierarchical tree of these frames. For inline layout specifically, it does BiDi analysis, text shaping via rustybuzz, CJK-Latin spacing, then line construction where it calculates justification by distributing extra space based on stretchability and shrinkability of glyphs — exactly the Knuth-Plass output you'd need. The frame tree is the input to *all* export formats (PDF, SVG, PNG), so it's a well-defined intermediate representation.

Even better — there's already a project called **typst.ts** that compiles Typst to WASM and runs it in JavaScript, rendering to SVG in the browser. You can literally drop it in with a CDN link, feed it Typst markup, and get rendered SVG back. So the "Typst as layout oracle" architecture isn't hypothetical — the plumbing exists. You'd just need to extract the layout decisions from the frame tree (line break positions, word spacing values, hyphenation points) instead of rendering to SVG, then apply those as CSS.

### Fable 5

Claude Fable 5 is a Mythos-class model that Anthropic made generally available with safety guardrails. State-of-the-art on nearly all benchmarks, with exceptional software engineering performance — Stripe reportedly used it to migrate a 50-million-line Ruby codebase in a day that would have taken a team two months.

For a project like "wire typst.ts frame tree output into CSS properties on DOM nodes, integrate with ProseMirror" — that's exactly the kind of well-scoped integration task where Fable in Claude Code could probably get the proof of concept running in a day or two.

---

## Taylor

ok fable, can you get started writing up a detailed document laying out the details for how you would write this project as the simplest web app? make sure to start by understanding the motivation for why we're interested in a wysiwyg latex style editor, the ideas for how to thread the needle using css and the ideas we've already discussed, and then start by laying out exactly how this will be done. we're not writing code yet, just systematically creating a detailed spec document that we will implement together later. this is aimed to be a professional project once it gets off the ground with a large potential market, although we'll keep it open source.

## Claude

*[Claude produced the full specification document — see `wysiwyg-typeset-editor-spec.md` for the complete spec.]*

The spec covers:

1. **Motivation** — the gap between markup-and-compile tools (LaTeX, Typst) and WYSIWYG tools (Typora, Word), and the core insight that CSS can express every layout decision a TeX-class engine makes ("oracle layout" architecture).

2. **Product definition** — v1 scope (single-document, client-side, no collaboration), feature set, and the bar for "feels right" (16ms keystroke echo, 50ms typeset correction, native selection).

3. **Architecture** — five components:
   - ProseMirror editing surface (document model as source of truth)
   - PM ⇄ Typst bidirectional mapper with position table
   - Typst WASM compiler in a Web Worker
   - Layout translator (frame tree → CSS on DOM)
   - Optimistic echo & scheduling (hide oracle latency)

4. **Hard problems, named and confronted** — measurement agreement, frame-tree exporter, two-layout flicker, selection/copy/a11y across generated structure, performance envelope.

5. **Technology choices** — Typst via typst.ts fork, ProseMirror, KaTeX, CodeMirror 6, Vite + TypeScript, `.typ` as on-disk format.

6. **Milestones** — M0 (oracle viability spike, go/no-go), M1 (static round-trip), M2 (feels like an editor), M3 (full v1 surface), M4 (public launch).

7. **Beyond v1** — executable Python cells (v2), citations/tables (v2.x), collaboration and hosted service (v3).
