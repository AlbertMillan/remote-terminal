# Drop and share any file into a session

## Goal

Dropping an image onto the terminal already uploads it and pastes its path, which Claude Code
attaches as `[Image #N]` (`a341a1d`, `sessions/pasted-images.ts`). Extend that to **any file**
(PDF, `.md`, `.csv`, code…) on the web client and in the Android app: the file is uploaded to
the server, and its path is pasted into the prompt, never sent. Claude opens it with its Read
tool when it needs it.

## Design decisions (confirmed 2026-11-09)

1. **Any file type**, up to **20 MB** (the same cap as images). Images keep their byte check:
   a file whose bytes are PNG/JPEG/GIF/WebP is saved with that extension, so Claude Code still
   attaches it as `[Image #N]`.
2. **A plain path is pasted**, not an `@`-mention: it works at any size, and Claude reads the
   file only when it needs to. A path containing a space is quoted, as it is today, and ends with a
   trailing space.
3. **Storage stays out of the cwd:** `<dataDir>/uploads/<session>/<stamp>-<uuid8>/<name>`.
   It is never saved in the session's cwd, or a worktree's `commitAll` would commit it. The
   folder is deleted with the session, and the boot sweep removes the folders of gone sessions
   and anything older than 30 days. The existing `images/` root is still swept and deleted, so
   nothing is left behind.
4. **The original file name is kept** (cleaned up) inside a unique folder, so Claude sees
   `spec.pdf` instead of a random name.
5. **Several files at once:** every dropped or picked file is uploaded and all their paths are
   pasted in one paste, in drop order. Folders are skipped. If some uploads fail, the ones that
   succeeded are still pasted and a toast names the failures.
6. **Android, in this change too:**
   - **Keys bar:** the `Image` key becomes **`Attach`**, pinned at the right edge **outside the
     scrolling keys**, so it is always on screen at full size (48dp tall, at least 72dp wide,
     with a divider and a fade over the scrolling keys). Tapping it opens a menu with **Photo**
     (today's photo picker) and **File** (the system document picker: any type, multi-select).
     While an upload runs it reads `Attach…` and ignores taps. Mock-up:
     https://claude.ai/artifact/MTxXMSnufwRidMGwZz9Mxc (Option A).
   - **Share sheet:** the app is a share target for any file (`SEND` and `SEND_MULTIPLE`,
     `*/*`). The session chooser is titled **"Paste the files into"** for every shared file,
     images included. Text shares keep their current title.
   - **Paste key:** a clipboard item holding a content URI of any type is uploaded too (today
     only images are).

## Planned changes

### Server — `src/server/sessions/pasted-images.ts` → `uploads.ts`

- `POST /api/sessions/:id/files?name=<file name>`: the raw bytes are the body, with any
  `Content-Type`. Its own plugin scope with a `*` buffer parser and a 20 MB `bodyLimit`.
  Answers `{ path }`. Errors: 404 for an unknown session, 400 for an empty body, 413 for a file
  over the cap.
- `POST /api/sessions/:id/images` stays, as an alias, for Android builds already installed.
- `safeFileName(name)`: keeps only the base name, strips control characters and
  `<>:"/\|?*`, trims trailing dots and spaces, prefixes Windows reserved names
  (`CON`, `NUL`, `COM1`…), caps the length at 100 characters while keeping the extension, and
  falls back to `file`. When the bytes sniff as an image, the extension is set from that sniff.
- `saveUpload()`, `sweepUploads()` (both roots, folder-level age check) and
  `deleteUploads()` (both roots), called from `manager.ts` and `app.ts` where the image
  versions are today.

### Web client — `src/client/pasted-image.ts` → `pasted-file.ts`, `terminal.ts`, `session-manager.ts`

- `filesFromTransfer(data)` returns every file, skipping folders
  (`webkitGetAsEntry()?.isDirectory`). A paste or drop that carries no file is still left to
  xterm, so text paste is unchanged.
- `uploadPastedFile(sessionId, file)` POSTs to `/files?name=…`.
- `onImage` becomes `onFiles(files: File[])`. `pasteFiles()` uploads the files in order, pastes
  the paths that succeeded in one `paste()` (only while that session is still the one shown,
  the same rule as today), and raises one error toast for any failures.
- A drop highlight: an outline on the terminal while files are dragged over it, cleared on
  `dragleave` and `drop`.

### Android — `android/`

- `sessions/PastedImages.kt` → `PastedFiles.kt`: the upload goes to `/files?name=…`, with
  the display name read from `OpenableColumns.DISPLAY_NAME`, streamed from the provider as
  today.
- `TerminalPane.kt`: in `KeysBar`, the scrolling `Row` takes `weight(1f)` and the pinned
  `Attach` sits after it, with a `DropdownMenu` (Photo / File).
- `MainScreen.kt`: `pasteFiles(sessionId, uris)` replaces `pasteImage` (keeping the upload
  count). Adds an `OpenMultipleDocuments(arrayOf("*/*"))` launcher, the Paste key for any
  URI, and a shared-files chooser.
- `MainActivity.kt` and `AndroidManifest.xml`: `SEND`/`SEND_MULTIPLE` `*/*` filters.
  `takeLink` checks `EXTRA_TEXT` first for a `text/plain` share; otherwise it reads the
  `EXTRA_STREAM` URI(s) into `app.pendingShareFiles`, which replaces `pendingShareImage`.
- No `/ws` message changes, so `protocol.ts`, `Protocol.kt` and the fixture are untouched.

## Verification

- `npm test`:
  - Server route tests: any type is saved under its cleaned-up name; an image keeps its
    sniffed extension; 404, 400 and 413 errors; the `/images` alias still works.
  - Unit tests for `safeFileName`: path traversal, reserved names, long names, empty names.
  - The sweep and the deletion cover both roots.
  - Client: `filesFromTransfer` with several files, a folder, and text only; a DOM test that a
    drop of two files pastes both paths and that a text paste is untouched.
- `npm run android:test`: unit tests for share-intent parsing (text versus one or several
  streams) and for `PastedFiles`.
- `npm run build`, `npm run lint`, and the isolated boot (`project/QA.md`, Flow 3) with a
  `curl` upload of a `.md` and a `.pdf`.
- By hand (needs a browser, an emulator and a server restart after landing): drop a PDF, an
  `.md` file and two files at once on the web client; in the app, use Attach → Photo,
  Attach → File (multi-select), and share from Files.

## Out of scope

- An attach button in the web client (drop and paste only).
- Upload progress beyond the busy state, dropping folders, and deduplicating repeat uploads.
- Changing how Claude Code handles the pasted path.
