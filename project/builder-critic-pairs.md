# Read-only peers beside a builder on one track

Track: Session orchestration

## Goal

A parent session can put up to two **read-only peers** beside a session it started on a
track. The usual peer is a reviewer: it judges the builder's work as it goes, against a
standard (a spec, reference images, a style guide, a benchmark). A peer can also gather
references, or be a second pair of eyes when the builder is stuck. The builder and its peers
talk directly over Claude Code's `SendMessage`.

The server enforces one thing only: **one session writes in the worktree**. The skill
(`claude-remote-sessions`) teaches the rest as conventions: who reviews, when, and how a
review ends. The server runs no protocol for it.

This works for any project and any kind of work (code, Blender art, writing, research), with
no setup in the project.

## Superseded design

The first version of this spec (commit `ef431b0`) proposed a server-enforced `role: 'critic'`:
- one critic per builder;
- a server-written preamble with the verdict format and round cap.

It was replaced on 2026-11-04, after the research below:
- Keep the single-writer rule as the only thing the server enforces.
- Let the parent decide what each peer is for.
- Move the review discipline into the skill. That's where it can differ per task, and the
  server never saw `SendMessage` anyway.

## Research this leans on (2026-11-04)

- **Free conversation hurts verdicts.**
  - In open discussion, agents switch from a right answer to a wrong one to agree with each
    other, and longer debates get worse (Wynn 2025, arXiv 2509.05396; Yao 2025, arXiv
    2509.23055).
  - Plain debate rarely beats simple baselines once you count its cost (Smit 2024, arXiv
    2311.17371).
  - The three-model debate user (HN 46365105): removing the human "would have been insanity".
- **Free conversation helps the work.** The same thread reports two models getting unstuck
  together after each was stuck alone.
- **Every tool with a reviewer fixes the role and ends on a hard rule.** Examples are Cursor
  Bugbot, Amp's oracle, a2a-loop and master-workflow; none uses free peers for verdicts.
- **Review helps when it is grounded:**
  - in executed tests or commands, references, or a stronger or different reviewer
    (Olausson 2024, arXiv 2306.09896; AgentCoder, arXiv 2312.13010);
  - because models favour their own output when judging (Panickssery 2024, arXiv 2404.13076).
- **A persistent reviewer drifts.**
  - "A reviewer that already critiqued round 1 will defend its own findings in round 2"
    (dev.to/nunc, Claude+Codex loop).
  - Long Blender sessions match "what success looks like" instead of looking (MindStudio).
- **Reviewers over-find.** "A reviewer that's asked to find problems will always find
  *something*" (code.claude.com best practices).
- **Cost.** Multi-agent systems use about 15× chat tokens (Anthropic, multi-agent research
  system). Nobody has measured a builder+reviewer pair.

## Depends on

- `f-s3w8qd`: started sessions, `startAgentSession()` in `sessions-api.ts`.
- `f-u7nq2k`: the prompt file through `--add-dir`.
- `f-cbq80b`: `--name`, so peers address each other by our name.
- `f-rkppyr`: the `launchFlags()` profile, re-applied on revive and Resume.

## What blocks it today

- `startAgentSession()` refuses a second live session from the same caller on the same
  track (409, the `trackKey` check in `sessions-api.ts`).
- A started session can't start sessions (403), so the builder can't start its own peer.

## Design decisions

1. **An access mode, not a role.**
   - The flag is `start --track X --read-only` (body `access: 'read'`). It is stored as
     `sessions.access` (NULL = write), so revive and Resume re-apply it like the MCP and
     permission profile.
   - The server knows who may write, not what a session is for. The parent's brief decides
     whether a peer reviews, gathers references or helps debug.
   - It is not dropped altogether: two writers in one worktree collide on builds and the git
     index however well they talk. That's what the 409 exists for.
2. **One writer and at most two read-only peers per caller and track.**
   - A second writer gets 409, as today.
   - A read-only start with no live writer on the track gets 409 ("start the builder first").
   - A third peer gets 409. Each peer costs a session's tokens, and more reviewers add
     agreement, not insight (research above).
   - Peers count toward `maxPerParent`.
   - The builder still can't start sessions (403). There's one level of nesting, and the
     parent stays the one place that decides to spend another session.
3. **Names.**
   - A peer defaults to `<builder name> peer` (`peer 2` for the second). The skill tells the
     parent to name it by its job with `--name` (`Split view reviewer`).
   - Both names are known before either session needs them, so the builder's brief can name
     its peers.
4. **Read-only, enforced where it can be.**
   - The peer's launch adds a `--settings` JSON that denies `Edit`, `Write` and `NotebookEdit`
     inside the worktree and allows them in the notes folder (5). The JSON lives in per-session
     config under `<dataDir>`, never in the worktree.
   - Bash can't be fenced reliably by permission patterns. The server header (8) forbids
     writing in the worktree and running anything that writes the git index
     (`git add/commit/checkout/stash/reset`, builds, installs).
   - That part is a prompt rule, and this spec says so rather than claiming a sandbox. An
     OS-level sandbox (Codex CLI's `--sandbox read-only`) is out of scope.
5. **One notes folder per track, outside the repo.**
   - Path: `<dataDir>/peers/<track-branch id>/`, passed to each peer with `--add-dir`.
   - It is outside every project, so it needs no `.gitignore` and can't be swept in by
     `commitAll`.
   - Keyed by the track branch, so a revived or replacement peer keeps the references and the
     findings ledger (7b).
   - Deleted when the track is landed or deleted. The start result prints its path so the
     parent can read it.
   - The builder never needs it: open findings travel in each verdict message.
6. **The builder speaks first, at checkpoints. Peers never poll.**
   - A peer starts, reads its brief, gathers references into the notes folder, then waits.
   - The builder messages it at checkpoints it chooses: what changed, where to look, the
     commit, and the evidence (7c).
   - An idle Claude costs nothing; a peer polling the worktree does.
   - **Liveness:** the builder sends each checkpoint with `notify_when_idle: true`. If the
     peer goes idle without a verdict, or exits, Claude Code tells the builder. The builder
     carries on, marks that checkpoint unreviewed, and tells the parent; it never waits
     forever. `list` shows each peer's state, so the parent sees one that exited. No server
     machinery is needed.
7. **Review conventions (taught by the skill, not enforced).**
   - a. **A fresh judge for each checkpoint.** The peer starts a subagent for each verdict.
     The subagent sees only the standard, the checkpoint's evidence, the open findings and the
     peer's references; the peer doesn't judge from its own long context.
   - b. **A findings ledger** in the notes folder.
     - Findings are numbered (F1, F2, …) and marked open, fixed, or rejected with the
       builder's reason.
     - A finding the builder accepted but hasn't fixed stays open.
     - A rejected finding comes back only with new evidence.
     - Each verdict lists the open findings, so the builder needs no file.
   - c. **Proof both ways.**
     - A checkpoint carries command or test output, or renders from fixed cameras (11).
     - A verdict cites evidence for what passes as well as what fails.
   - d. **Scope.** Report only gaps against the standard, never style. At most five optional
     suggestions, which never block approval.
   - e. **A fixed verdict.** The first word is `APPROVED`, `CHANGES` or `NOT CONVERGED`.
     Anything else counts as not approved.
   - f. **The builder triages.** It may reject a finding with a reason, which the peer records
     (b).
   - g. **The end.** After about 3 `CHANGES` rounds on one checkpoint, or one round in which no
     finding moved to fixed, the peer sends `NOT CONVERGED` to the parent with both positions.
     The builder waits, and the parent decides or asks the user.
   - h. **Free conversation otherwise.** The builder can ask a peer for help, references or a
     second opinion at any time. Only a checkpoint gets a verdict.

   The server never sees `SendMessage`, so these stay conventions. Claude Code's own throttle
   is a backstop, not the end rule: a per-sender rate limit, identical repeats dropped, at
   most 50 queued.
8. **The server writes facts; the skill writes behaviour.**
   - A peer's prompt file starts with a short server header:
     - it is read-only in `<worktree>` (with the Bash rule from 4);
     - its notes folder is `<path>`;
     - the writer is `<builder name>` and the parent is `<parent name>`.
   - The parent's brief follows the header. The skill gives the parent two templates:
     - the lines it adds to the builder's prompt (peer names, the checkpoint habit,
       `notify_when_idle`, stop on `NOT CONVERGED`);
     - a reviewer brief carrying 7a–h, with a slot for the standard.
   - The parent may write a different brief for a peer that isn't a reviewer.
9. **Tools for judging.**
   - The peer's launch allows `WebFetch`, `WebSearch` and `Read` without asking
     (`--allowedTools`). Gathering references and viewing images (Read shows PNG/JPG) then
     never stalls an unattended session.
   - It loads no MCP server by default. `--mcp` works as for any start (e.g. `--mcp
     playwright` to judge a running UI).
10. **When to add a peer (the skill).**
    - Add one when there is a concrete standard, or something runnable to check against:
      - art or UI judged against references;
      - writing judged against a brief or a voice;
      - research checked against its sources;
      - work the user wants reviewed as it goes.
    - Don't add one:
      - when the spec's tests are the standard (the test run is the reviewer);
      - for small changes;
      - when the parent can't write a concrete standard. Review that rests on opinion alone
        has no support.
    - Expect at least 2–3× the tokens of the builder alone.
11. **Art and renders.**
    - At each checkpoint the builder renders fixed camera angles headless (EEVEE preview,
      about 1 s each) into a folder the project's git ignores. The skill says to check with
      `git check-ignore`, or `commitAll` sweeps the renders in.
    - The peer's subagent compares only those PNGs with the references, against a rubric
      from the brief.
    - This is the least proven part. No one reported a second-session reviewer for 3D.
12. **Sidebar and logs.**
    - A peer is a child of the parent (`spawned_by`), shown right after its builder with a
      `read-only` chip.
    - The session log labels its entry `(peer)`, so the track's history doesn't read as
      several builders.
13. **Not Claude Code's agent teams.** It is the free-communication design ready-made, but:
    - it is experimental;
    - it has no session resume, which breaks revive;
    - it allows one team per session;
    - its docs say same-file work belongs in one session.

    Revisit if it stabilises.

## Planned changes

- `src/server/db/`: a migration adding `sessions.access` (TEXT NULL).
- `src/server/agent/sessions-api.ts`:
  - `StartBody.access`.
  - The 409 split into one writer and at most two read-only peers per caller and track.
  - A read-only start requires a live writer.
  - Default peer names.
  - The server header composed before `writePromptFile()`.
  - The start result gains `access` and `notesPath`, and `list` shows `access`.
- `launchFlags()` in `src/server/sessions/launch-profile.ts`, for `access = read`, on start,
  revive and Resume:
  - the `--settings` deny/allow JSON;
  - `--allowedTools WebFetch WebSearch Read`;
  - `--add-dir` for the notes folder.
- Track land and delete: remove `<dataDir>/peers/<id>/`.
- `scripts/cr-session.mjs`: `--read-only`.
- Client sidebar: the `read-only` chip, ordered after its builder.
- Session log: the `(peer)` label.
- `skills/claude-remote-sessions/SKILL.md`, a "Read-only peers" section:
  - when to add one (10);
  - the builder lines and the reviewer brief (8, 7a–h);
  - renders (11);
  - `notify_when_idle`;
  - handling `NOT CONVERGED`.
- `docs/session-orchestration.md`: a section on peers. CLAUDE.md gets a rule only if one is
  needed; the access mode is enforced in the server.

## Verification (to check before and during implementation)

1. **Messaging.**
   - Builder and peers see each other in `ListAgents`, and `SendMessage` delivers every way.
   - Check whether differing permission modes hold messages for approval. If they do, a peer
     inherits the builder's mode by default, and the skill says so.
2. **Liveness.** A checkpoint sent with `notify_when_idle` gets an idle notice when the peer
   exits, or goes idle without replying.
3. **Tools without prompts.** In `auto`, with no MCP servers loaded, a peer runs `WebSearch`
   and `WebFetch` and uses `Read` on a PNG, both in the worktree and in the notes folder,
   without a permission prompt.
4. **Read-only.** An `Edit`/`Write` in the worktree is denied; one in the notes folder works.
5. **Start rules.**
   - A second writer gets 409.
   - A peer with no writer gets 409.
   - A third peer gets 409.
   - Peers count toward `maxPerParent`.
   - The builder can't start a peer (403).
6. **`list`, `land --track` and Delete track with three sessions in one worktree**, on
   Windows: all close, each awaited, with no `EBUSY` on `git worktree remove`, and the notes
   folder is removed.
7. **Revive and Resume** re-apply the access profile: settings, allowed tools and the notes
   folder.
8. Sidebar order and chip. The session log has one entry per session, with the peers
   labelled.
9. Unit tests for the 409 slots, the header composition and the read-only launch flags.
10. The end-to-end checks run on the isolated boot (`project/QA.md`, Flow 3), never on 4220.

## Out of scope

- A server-side round counter, verdict parser or message relay. There is no claude-remote
  mailbox; see `peer-session-names.md` decision 6.
- Peers running another model (Codex CLI with its OS-level read-only sandbox). This is worth
  revisiting: different blind spots are the most reported benefit, but the evidence is
  anecdotal.
- More than one writer per track, and peers on job worktrees.
- Letting a started session start its own peers.
