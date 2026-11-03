# Builder + critic pairs on one track

Track: Session orchestration

## Goal

A parent session can put a **critic** beside a session it started on a track. The critic
shares the track's worktree, gets no feature or issue, only a standard to judge against
(a spec, a reference image, a style guide, a benchmark). It reads the builder's output,
gathers reference material (online too), and talks to the builder directly to keep the
work on target. It never changes the work. This should work for any project and any kind
of work (code, art, writing, research), with no setup in the project, and Claude Code
learns when and how to use it from the `claude-remote-sessions` skill.

## Depends on

- `f-s3w8qd` (started sessions, `startAgentSession()` in `sessions-api.ts`), `f-u7nq2k`
  (prompt file via `--add-dir`), `f-cbq80b` (`--name`, so peers address each other by our
  name), `f-rkppyr` (`launchFlags()` profile re-applied on revive and Resume).

## What blocks it today

- `startAgentSession()` refuses a second live session from the same caller on the same
  track (409, `sessions-api.ts` around the `trackKey` check).
- A started session can't start sessions (403), so the builder can't start its own critic.

## Design decisions

1. **A first-class role, not a generic "alongside" flag.** `start --track X --critic`
   (body `role: 'critic'`). A generic flag would let a parent put two *builders* in one
   worktree, where they collide on builds and the git index, which is exactly what the 409
   prevents. A role lets the server relax the 409 for one case only and enforce the rest.
   The role is stored on the row (`sessions.role`, NULL = builder) so revive and Resume
   re-apply the critic's profile, like the MCP and permission profile.
2. **Who may start one.** Only the parent, after it has a live builder on that track (the
   409 now means "one builder and at most one critic per caller and track"). A critic with
   no live builder is refused (409, "start the builder first"). The builder still can't
   start sessions: one level of nesting, and the parent stays the one place that decides
   to spend the second session. A critic counts toward `maxPerParent` like any child.
3. **Names.** The critic defaults to `<builder name> critic` (`--name` overrides it), so
   `ListAgents` shows `Split view` and `Split view critic` side by side. Both names are
   known before either session needs them, which the handshake (6) relies on.
4. **Read-only, enforced where it can be.** The critic's launch adds a `--settings` JSON
   (written under `<dataDir>/mcp/`-style per-session config, never in the worktree) that
   **denies `Edit`, `Write` and `NotebookEdit` inside the worktree** and allows them in its
   notes folder. Bash can't be fenced reliably by permission patterns, so the critic's
   preamble forbids writing in the worktree and running anything that writes the git index
   (`git add/commit/checkout/stash/reset`, builds, installs). That part is a prompt rule; the
   spec says so rather than claiming a sandbox.
5. **Notes folder outside the repo.** `<dataDir>/critique/<track-branch id>/`, passed with
   `--add-dir`. It is outside every project, so it needs no `.gitignore` and can't be swept in
   by `commitAll`, and it doesn't depend on the project's layout. Keyed by the track branch,
   not the session, so a revived or replacement critic keeps its references. Deleted when the
   track is landed or deleted. The start result prints its path so the parent can read the
   critic's notes.
6. **The builder speaks first.** The critic starts, reads its standard, gathers references
   into its notes folder, then **waits**. The builder messages the critic at checkpoints it
   chooses ("ready for review: what changed, where to look, the commit"), and the critic
   replies with one verdict. An idle Claude costs nothing, so a critic that waits for a
   checkpoint is far cheaper than one that polls the worktree. The parent's builder prompt
   names the critic (3 makes the name predictable); the server-written critic preamble names
   the builder and the parent.
7. **Verdicts and how the loop ends.** Every critic reply starts with `APPROVED`,
   `CHANGES` (numbered, each tied to the standard) or `ESCALATE`. Sign-off is `APPROVED` on
   the builder's final checkpoint. The default cap is **3 `CHANGES` rounds per checkpoint**
   (`--rounds N` to change it): at the cap, or on a disagreement the builder won't take, the
   critic sends `ESCALATE` with both positions to the **parent**, and the builder stops and
   waits instead of looping. The parent decides or asks the user. The cap lives in the
   prompts (`SendMessage` is Claude Code's, the server never sees it); that is stated, not
   hidden.
8. **The server writes the critic's protocol, the parent writes the standard.** The
   critic's prompt file is a fixed preamble (role, builder/parent names, notes folder,
   read-only rules, verdict format, round cap) followed by the parent's standard. The skill
   only has to teach *when* to pair and *what a standard looks like*, and every critic follows
   the same protocol whatever the project. The builder gets no server preamble: the skill
   tells the parent to add three lines (critic's name, checkpoint habit, stop on ESCALATE).
9. **Tools for judging.** The critic's launch allows `WebFetch`, `WebSearch` and `Read`
   without asking (`--allowedTools`), so gathering references and viewing images (Read
   shows PNG/JPG) never stall an unattended session. It still loads no MCP server by
   default; `--mcp` works as for any start (e.g. `--mcp playwright` to judge a running UI).
10. **When to pair (the skill).** A pair costs roughly a second session's tokens per review
    round. Pair when the work is judged against something outside the code and tests can't
    check it: art or UI against references, writing against a voice or brief, research
    against sources, or work the user explicitly wants reviewed as it goes. Don't pair when
    the spec's tests are the standard (the test run is the critic), for small changes, or
    when the parent can't write a concrete standard: a critic with nothing specific to judge
    against only adds opinions.
11. **Sidebar and logs.** The critic is a child of the parent (it's `spawned_by` the parent),
    rendered right after its builder with a `critic` chip. The session log gets one entry
    per conversation as today; the critic's is labelled `(critic)` so the track's history
    doesn't read as two builders.

## Planned changes

- `src/server/db/`: migration adding `sessions.role` (TEXT NULL).
- `src/server/agent/sessions-api.ts`: `StartBody.role`, `rounds`; the 409 split into
  builder/critic slots; critic requires a live builder; default name; critic preamble
  composed before `writePromptFile()`; start result gains `role` and `notesPath`; `list`
  shows `role`.
- `launchFlags()` (wherever it lives with the MCP profile): for `role = critic`, the
  `--settings` deny/allow JSON, `--allowedTools WebFetch WebSearch Read`, and the extra
  `--add-dir` for the notes folder, on start, revive and Resume.
- Track land / delete: remove `<dataDir>/critique/<id>/`.
- `scripts/cr-session.mjs`: `--critic`, `--rounds`.
- Client sidebar: `critic` chip; order critic after its builder.
- Session log: `(critic)` label.
- `skills/claude-remote-sessions/SKILL.md`: a "Pair a critic" section (when, the builder's
  three lines, writing a standard, reading the notes folder, handling ESCALATE).
- `docs/session-orchestration.md`: a section on pairs; CLAUDE.md gets a rule only if one is
  needed (the role is enforced in the server).

## Verification (to check before and during implementation)

1. **Messaging between the pair.** Both sessions see each other in `ListAgents` and
   `SendMessage` delivers both ways. Check whether differing permission modes hold messages
   for approval; if they do, the critic inherits the builder's mode by default and the skill
   says so.
2. **Tools without prompts.** In `auto`, the critic runs `WebSearch`, `WebFetch` and `Read`
   on an image in the worktree and in its notes folder without a permission prompt, with no
   MCP servers loaded.
3. **Read-only.** An `Edit`/`Write` in the worktree is denied; one in the notes folder works.
4. **Start rules.** Second builder → 409; critic without builder → 409; second critic → 409;
   critic counts toward the per-parent limit (5); builder can't start a critic (403).
5. **`list`, `land --track` and Delete track with two sessions in one worktree**, on Windows:
   both close (awaited, no `EBUSY` on `git worktree remove`), notes folder removed.
6. **Revive and Resume** re-apply the critic profile (settings, allowed tools, notes dir).
7. Sidebar order and chip; session log has two entries, the critic's labelled.
8. Unit tests for the 409 slots, the preamble composition and the critic launch flags;
   the end-to-end checks on the isolated boot (`project/QA.md`, Flow 3), never on 4220.

## Out of scope

- A server-side round counter or message relay (no claude-remote mailbox; see
  `peer-session-names.md` decision 6).
- More than one critic per builder, or critics on job worktrees.
- Letting a started session start its own critic.
