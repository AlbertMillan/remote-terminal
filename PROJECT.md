---
name: claude-remote
status: active
---

## Track: Core remote terminal
- [x] `f-n9vt37` Web terminal over WebSocket — xterm.js client, ConPTY/PTY server
- [x] `f-e2et3t` Session lifecycle — create, attach, rename, terminate, SQLite persistence
- [x] `f-pklmbg` Session persistence — tmux on Linux/macOS, scrollback buffer on Windows
- [x] `f-04ke3d` Tailscale identity verification, optional user allowlist and TLS
- [x] `f-yhplgt` Session categories with drag-and-drop organization and sort order
- [x] `f-6aoexu` File logging with rotation plus uncaught-exception crash handlers
- [x] `f-o86ddo` Notification system — needs-input / completed badges via Claude Code hooks
- [x] `f-7o88el` Frontend redesign and mobile navigation overlay for touch devices
- [x] `f-qfr8va` Picture-in-Picture terminal overlay using the Document PiP API
- [x] `f-5x3pcj` Draggable custom scrollbar overlay for terminal sessions
- [x] `f-p9jzhd` Keyboard shortcuts registry driving the modal and welcome hints
- [x] `f-5fv6fv` Recent-paths dropdown on the new-session working directory field
- [x] `f-vaq9ns` Session fork — ephemeral branched Claude conversations with Keep
- [x] `f-shu9vw` Windows auto-start via start-server.bat and the hidden VBS launcher

## Track: Project Session Log
- [x] `f-j6jxm9` Step 1 — Plan / design doc
- [x] `f-49wrv4` Step 2 — Backend: config block, logged_at migration, maybeLogSession triggers, skip-gate, generator, startup sweep
- [x] `f-0wweo3` Step 3 — Global ~/.claude/CLAUDE.md convention block
- [x] `f-zyt99p` Step 4 — Backfill endpoint and cross-source project discovery
- [x] `f-8011o9` Step 5 — Dashboard UI: Projects sidebar tab, detail view, getProjectBoard()
- [x] `f-yvnzyl` Step 6 — Reliability hardening: verify the run wrote, skip huge transcripts, retry-on-no-write
- [x] `f-xn3jn8` Step 7 — Plan-phases progress board: normalized manifest and per-track tables
- [x] `f-5zopl1` Collapsible phase groups and Re-sync action to refresh phases from plan docs
- [x] `f-xpd148` Edit-scope enforcement (post-run revert), hard-fail, per-project backfill
- [x] `f-leww3w` One entry per conversation — scoped gate, amend in place instead of appending

## Track: Session history actions
- [x] `f-vo32tl` Resume and Fork buttons on session-history entries
- [x] `f-fjf44n` Delete button — remove the entry and unlink the backing transcript
- [x] `f-ipv193` Index-staleness 409 contract and conversation-scoped delete

## Track: Project workspace & job pipeline
- [x] `f-a8ndv4` Canonical PROJECT.md doc format, project registry, VCS tiers and store
- [x] `f-fpretm` Workspace board assembly and slug-based project recovery
- [x] `f-m38qta` Shared headless claude-run safety stack extracted into one module
- [x] `f-etbsz5` Project migration plus workspace API routes with revision/409 staleness
- [x] `f-jgs1pb` Project workspace UI — editable feature board in the Projects tab
- [x] `f-uufkna` Job pipeline foundation — worktree isolation, scheduler, design stage, design gate
- [x] `f-wi1jyx` Job board UI
- [x] `f-7gmz3v` Implement, integrate and merge stages with the merge gate
- [x] `f-qemxfo` Review stage, selectable findings, and the fix stage
- [x] `f-gr797e` QA stage, per-project QA contract, and skip alerts
- [x] `f-soj5vl` Rebuild stage and the cross-project rollup overview
- [x] `f-3kw82m` P1 Job abort & discard — cancel mid-stage, discard terminal jobs, 20-min stage timeout → project/job-abort-and-discard.md

## Track: Token & cost accounting for jobs
- [x] `f-4jqq6m` Section 3 — Server: stage token-usage migration, RunUsage parsing, addStageUsage, sumUsage rollups
- [x] `f-k3ttmk` Section 4 — Client: stage and job cost chips, project total beside the Jobs heading
