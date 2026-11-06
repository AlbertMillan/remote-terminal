/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink.
 */
package com.termux.terminal;

/**
 * Callback interface that the terminal emulator uses to communicate output
 * events back to the session host (e.g. data to write to a PTY or WebSocket,
 * title changes, bell notifications, clipboard requests).
 */
public abstract class TerminalOutput {

    /** Called when the terminal emulator produces output bytes (e.g. query responses). */
    public abstract void write(byte[] data, int offset, int count);

    /** Called when the terminal title changes via OSC 0 or OSC 2. */
    public abstract void titleChanged(String oldTitle, String newTitle);

    /** Called when the terminal receives a BEL character (0x07). */
    public abstract void onBell();

    /** Called when the terminal requests clipboard content via OSC 52. */
    public abstract void clipboardText(String text);

    /** Called when terminal colors are changed (e.g. via OSC 4/10/11). */
    public abstract void onColorsChanged();
}
