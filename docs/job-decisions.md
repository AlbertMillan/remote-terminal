# Reading a parked job's question

A stage that stops rather than guess writes free prose into `job.detail`: one bullet per
open question, each running the question, its context, the alternatives it weighed and its
recommendation together. The board used to print that verbatim in a `pre-wrap` block, so
the question you had to answer read exactly like the paragraph explaining it, and the
model's own hard wraps pinned the text into a ~500px column of a 1400px panel.

`src/client/decision-format.ts` parses it into `{ preamble, cards }` — question, context
paragraphs, `(a)/(b)/(c)` options, and what the run would do — and `renderDecision()` in
`job-board.ts` gives each part its own element.

- **It is a parser over prose, not a markdown renderer.** The client has never had one and
  does not need one here: `stripMarks()` drops backticks and `**`, and the structure
  carries what the emphasis was for. It deliberately leaves `_` alone — that appears far
  more often inside identifiers (`MAX_HISTORICAL_DAYS`) than as emphasis, and stripping it
  would corrupt the very strings that make a question answerable.
- **Every rule degrades to "no match", never to a wrong match.** A block with no question
  stays whole as a plain note; a detail with no question at all returns `null` and the
  caller shows the text as written. Options need two markers running in order from `a`, so
  a lone "(a)" in prose is not mistaken for a list. Nothing the model wrote is dropped —
  `tests/decision-format.test.ts` asserts that against the real text that prompted this.
- A recommendation ends at its **sentence**, not at the end of the block. The boundary
  needs whitespace and then something that can open a sentence, so `§3.2`, `e.g.` and
  `0.5` do not end one. Taking the rest of the block instead swallows the context.
- `Recommends (b)` loses its lead-in because the callout's label repeats it. `Assumed`
  keeps it: in "I have assumed stop" the lead-in *is* the decision.
- **One answer box per question**, joined into the single string the server takes, each
  labelled with its question — the stage re-runs from its own prompt, and "stop" alone does
  not say which of two questions it settles. All boxes must be filled: a partial answer
  restarts a stage still missing what it stopped for.
- `render()` replaces the board's HTML wholesale and *is* triggered mid-decision (opening a
  spec, ticking a finding), so `captureDrafts()` reads part-written answers back out of the
  DOM first. `act()` returns whether the request landed, so a draft is only dropped once
  the answer was actually accepted.
- The card grid's `minmax(min(460px, 100%), 1fr)` needs the `min()`: with a bare `460px`
  the track is wider than the panel on a phone and the cards run off the side.
- **The question has to be self-contained, and `buildDesignPrompt` says so.** The run reads
  the repo; the person answering sees one paragraph on a card. A real question this stage
  asked opened "Question 2 is unanswerable with `bizumIn === 0`" — where Question 2 was
  item 2 of a numbered list in `SPEC.md`, a document the reader had never opened and which
  the spec itself only ever *referenced*. The prompt now requires the cited line to be
  quoted into the question, files named by path, and any constant the answer turns on
  spelled out. Parsing cannot substitute for this: the same spec's own numbered list is a
  *steps* list whose item 2 is `npm run aspsps`, so resolving "Question 2" against numbered
  items would have answered confidently and wrongly.
