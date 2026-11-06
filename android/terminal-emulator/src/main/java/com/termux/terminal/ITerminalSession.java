/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink: decouples terminal emulation from local PTY,
 * enabling remote WebSocket-backed sessions.
 */
package com.termux.terminal;

/**
 * Abstraction over a terminal session. Implementations may back this with a
 * local PTY process (traditional Termux) or a remote WebSocket connection
 * (Termlink).
 */
public interface ITerminalSession {

    /** Return the {@link TerminalEmulator} driving this session. */
    TerminalEmulator getEmulator();

    /** Write raw bytes to the session's input (PTY stdin or WebSocket send). */
    void write(byte[] data, int offset, int length);

    /** Convenience: write a UTF-8 string to the session. */
    void write(String data);

    /** Notify the session of a terminal size change. */
    void updateSize(int columns, int rows);

    /** Whether the underlying process / connection is still alive. */
    boolean isRunning();

    /** Human-readable title (OSC 0/2 title, or a default). */
    String getTitle();
}
