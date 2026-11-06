/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * claude-remote: tests for the resize and scroll-counter changes to this fork.
 */
package com.termux.terminal;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;

import org.junit.Test;

public class TerminalResizeTest {

    private static final TerminalOutput NO_OUTPUT = new TerminalOutput() {
        @Override public void write(byte[] data, int offset, int count) {}
        @Override public void titleChanged(String oldTitle, String newTitle) {}
        @Override public void onBell() {}
        @Override public void clipboardText(String text) {}
        @Override public void onColorsChanged() {}
    };

    private static void feed(TerminalEmulator emulator, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        emulator.process(bytes, bytes.length);
    }

    private static String row(TerminalEmulator emulator, int row) {
        TerminalRow line = emulator.getScreen().allocateFullLineIfNecessary(row);
        StringBuilder sb = new StringBuilder();
        for (int c = 0; c < emulator.getColumns(); c++) sb.append(line.getChar(c));
        return sb.toString().trim();
    }

    private static TerminalEmulator withLines(int count) {
        TerminalEmulator emulator = new TerminalEmulator(NO_OUTPUT, 20, 5);
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= count; i++) {
            sb.append("line ").append(i);
            if (i < count) sb.append("\r\n");
        }
        feed(emulator, sb.toString());
        return emulator;
    }

    @Test
    public void outputScrollsLinesIntoTheHistoryAndCountsThem() {
        TerminalEmulator emulator = withLines(12);
        assertEquals(7, emulator.mMainBuffer.getActiveTranscriptRows());
        assertEquals(7, emulator.mMainBuffer.getScrollCounter());
        assertEquals("line 1", row(emulator, -7));
        assertEquals("line 12", row(emulator, 4));
    }

    @Test
    public void shrinkingKeepsTheHistoryAndTheCursorLine() {
        // The keyboard opening: 5 rows become 3.
        TerminalEmulator emulator = withLines(12);
        emulator.resize(20, 3);
        assertEquals("line 12", row(emulator, 2));
        assertEquals(2, emulator.getCursorRow());
        assertEquals(9, emulator.mMainBuffer.getActiveTranscriptRows());
        assertEquals("line 1", row(emulator, -9));
    }

    @Test
    public void growingAndNarrowingKeepTheHistory() {
        TerminalEmulator emulator = withLines(12);
        emulator.resize(20, 3);
        emulator.resize(6, 8);
        assertEquals("line 1", row(emulator, -9));
        assertEquals("line 1", row(emulator, -9));
        assertEquals("line 1", row(emulator, 2).substring(0, 6));
        feed(emulator, "\r\nnext");
        assertEquals("next", row(emulator, 3));
    }
}
