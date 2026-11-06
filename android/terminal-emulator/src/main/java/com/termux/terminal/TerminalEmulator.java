/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink: decouples terminal emulation from local PTY,
 * enabling remote WebSocket-backed sessions.
 */
package com.termux.terminal;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * VT100/xterm terminal emulator.
 * <p>
 * Processes an incoming byte stream (from a PTY or remote WebSocket) and
 * updates a {@link TerminalBuffer} accordingly.  Handles:
 * <ul>
 *   <li>UTF-8 decoding</li>
 *   <li>C0/C1 control characters</li>
 *   <li>CSI (Control Sequence Introducer) sequences -- cursor movement,
 *       scrolling, erase, SGR, scroll region, DEC private modes, etc.</li>
 *   <li>OSC (Operating System Command) sequences -- window title, etc.</li>
 *   <li>Character attributes (bold, italic, underline, colors, ...)</li>
 *   <li>Alternate screen buffer</li>
 * </ul>
 */
public final class TerminalEmulator {

    // ---- Buffers ----

    /** The primary (main) screen buffer, including scrollback. */
    public final TerminalBuffer mMainBuffer;

    /** The alternate screen buffer (no scrollback). */
    private final TerminalBuffer mAltBuffer;

    /** The currently active screen buffer. */
    private TerminalBuffer mScreen;

    /** Whether the alternate screen is currently active. */
    private boolean mUsingAlternateScreen = false;

    /** Output callback. */
    private final TerminalOutput mClient;

    /** Color palette. */
    public final TerminalColors mColors = new TerminalColors();

    // ---- Cursor ----

    private int mCursorRow;
    private int mCursorCol;

    // ---- Dimensions ----

    private int mRows;
    private int mColumns;

    // ---- Character style state ----

    private int mForeColor;
    private int mBackColor;
    private int mEffect;

    // ---- Terminal modes ----

    private boolean mCursorVisible = true;
    private boolean mInsertMode = false;
    private boolean mAutowrapMode = true;
    private boolean mOriginMode = false;
    private boolean mCursorKeysApplication = false;
    private boolean mKeypadApplication = false;
    private boolean mBracketedPasteMode = false;

    /**
     * Whether the cursor has moved to the right edge but has not yet wrapped.
     * The next printable character will trigger a wrap if autowrap is enabled.
     */
    private boolean mAboutToAutoWrap = false;

    // ---- Scroll margins ----

    private int mTopMargin;
    private int mBottomMargin;

    // ---- Tab stops ----

    private boolean[] mTabStops;

    // ---- Parser state machine ----

    private static final int STATE_NORMAL  = 0;
    private static final int STATE_ESCAPE  = 1;
    private static final int STATE_CSI     = 2;
    private static final int STATE_CSI_PARAM = 3;
    private static final int STATE_OSC     = 4;
    private static final int STATE_OSC_ESC = 5;  // ESC within OSC (for ST = ESC \)
    private static final int STATE_CSI_INTERMEDIATE = 6;

    private int mParseState = STATE_NORMAL;

    /** CSI parameter values. */
    private final int[] mCSIParams = new int[16];
    private int mCSIParamCount = 0;

    /** CSI prefix character ('?' or '>' or '!'). */
    private int mCSIPrefix = 0;

    /** CSI intermediate characters (collected between params and final byte). */
    private final StringBuilder mCSIIntermediate = new StringBuilder();

    /** OSC string accumulator. */
    private final StringBuilder mOSCArgs = new StringBuilder();

    /** Window / icon title. */
    private String mTitle = "";

    // ---- Saved cursor (DECSC/DECRC) ----

    private int mSavedCursorRow;
    private int mSavedCursorCol;
    private int mSavedForeColor;
    private int mSavedBackColor;
    private int mSavedEffect;
    private boolean mSavedOriginMode;

    // ---- Saved cursor for alternate screen ----

    private int mSavedAltCursorRow;
    private int mSavedAltCursorCol;

    // ---- UTF-8 decode state ----

    private int mUtf8ToFollow = 0;
    private int mUtf8CodePoint = 0;

    // ---- Constants ----

    /** Default number of scrollback rows in the main buffer. */
    private static final int SCROLLBACK_LINES = 4000;

    // ====================================================================
    // Constructor
    // ====================================================================

    public TerminalEmulator(TerminalOutput client, int columns, int rows) {
        mClient = client;
        mColumns = columns;
        mRows = rows;
        mTopMargin = 0;
        mBottomMargin = rows - 1;

        mMainBuffer = new TerminalBuffer(columns, rows + SCROLLBACK_LINES, rows);
        mAltBuffer  = new TerminalBuffer(columns, rows, rows);
        mScreen = mMainBuffer;

        mTabStops = new boolean[columns];
        setDefaultTabStops();

        reset();
    }

    // ====================================================================
    // Public accessors
    // ====================================================================

    public TerminalBuffer getScreen() { return mScreen; }
    public int getCursorRow()   { return mCursorRow; }
    public int getCursorCol()   { return mCursorCol; }
    public int getRows()        { return mRows; }
    public int getColumns()     { return mColumns; }
    public boolean isCursorVisible()           { return mCursorVisible; }
    public boolean isCursorKeysApplication()   { return mCursorKeysApplication; }
    public boolean isKeypadApplication()       { return mKeypadApplication; }
    public boolean isAlternateBufferActive()   { return mUsingAlternateScreen; }
    public String  getTitle()                  { return mTitle; }
    public TerminalColors getColors()            { return mColors; }

    /** Return the current style (packed fore/back/effect). */
    public long getStyle() {
        return TextStyle.encode(mForeColor, mBackColor, mEffect);
    }

    // ====================================================================
    // Reset
    // ====================================================================

    /** Full soft reset of the terminal state. */
    public void reset() {
        mForeColor = 0;
        mBackColor = 0;
        mEffect = 0;
        mCursorRow = 0;
        mCursorCol = 0;
        mCursorVisible = true;
        mInsertMode = false;
        mAutowrapMode = true;
        mOriginMode = false;
        mCursorKeysApplication = false;
        mKeypadApplication = false;
        mBracketedPasteMode = false;
        mAboutToAutoWrap = false;
        mTopMargin = 0;
        mBottomMargin = mRows - 1;
        mParseState = STATE_NORMAL;
        mUtf8ToFollow = 0;
        mUtf8CodePoint = 0;
        setDefaultTabStops();
        mColors.reset();
    }

    // ====================================================================
    // Resize
    // ====================================================================

    public void resize(int columns, int rows) {
        if (columns == mColumns && rows == mRows) return;
        if (columns < 1 || rows < 1) return;

        int oldCursorRow = mCursorRow;

        mMainBuffer.resize(columns, rows, rows + SCROLLBACK_LINES, getStyle(), oldCursorRow);
        mAltBuffer.resize(columns, rows, rows, getStyle(), oldCursorRow);

        mColumns = columns;
        mRows = rows;
        mTopMargin = 0;
        mBottomMargin = rows - 1;
        mCursorRow = Math.min(mCursorRow, rows - 1);
        mCursorCol = Math.min(mCursorCol, columns - 1);
        mAboutToAutoWrap = false;

        boolean[] newTabStops = new boolean[columns];
        int copyLen = Math.min(mTabStops.length, columns);
        System.arraycopy(mTabStops, 0, newTabStops, 0, copyLen);
        // Set default tab stops for new columns beyond old size
        for (int i = mTabStops.length; i < columns; i++) {
            newTabStops[i] = (i % 8 == 0);
        }
        mTabStops = newTabStops;
    }

    // ====================================================================
    // Main entry point: process incoming bytes
    // ====================================================================

    /**
     * Process incoming bytes from the terminal data source.
     *
     * @param data   byte buffer
     * @param length number of bytes to process
     */
    public void process(byte[] data, int length) {
        for (int i = 0; i < length; i++) {
            byte b = data[i];

            // --- UTF-8 continuation bytes ---
            if (mUtf8ToFollow > 0) {
                if ((b & 0xC0) == 0x80) {
                    mUtf8CodePoint = (mUtf8CodePoint << 6) | (b & 0x3F);
                    mUtf8ToFollow--;
                    if (mUtf8ToFollow == 0) {
                        processCodePoint(mUtf8CodePoint);
                    }
                } else {
                    // Broken UTF-8 sequence; reset and re-process this byte.
                    mUtf8ToFollow = 0;
                    i--;
                }
                continue;
            }

            // --- UTF-8 lead bytes ---
            if ((b & 0x80) == 0) {
                // ASCII (0x00-0x7F)
                processCodePoint(b & 0x7F);
            } else if ((b & 0xE0) == 0xC0) {
                mUtf8ToFollow = 1;
                mUtf8CodePoint = b & 0x1F;
            } else if ((b & 0xF0) == 0xE0) {
                mUtf8ToFollow = 2;
                mUtf8CodePoint = b & 0x0F;
            } else if ((b & 0xF8) == 0xF0) {
                mUtf8ToFollow = 3;
                mUtf8CodePoint = b & 0x07;
            } else {
                // Invalid UTF-8 byte; ignore.
            }
        }
    }

    // ====================================================================
    // Code point dispatch
    // ====================================================================

    private void processCodePoint(int cp) {
        switch (mParseState) {
            case STATE_NORMAL:
                processNormal(cp);
                break;
            case STATE_ESCAPE:
                processEscape(cp);
                break;
            case STATE_CSI:
            case STATE_CSI_PARAM:
            case STATE_CSI_INTERMEDIATE:
                processCSI(cp);
                break;
            case STATE_OSC:
                processOSC(cp);
                break;
            case STATE_OSC_ESC:
                processOSCEsc(cp);
                break;
        }
    }

    // ====================================================================
    // STATE_NORMAL
    // ====================================================================

    private void processNormal(int cp) {
        switch (cp) {
            case 0:    // NUL -- ignore
                break;
            case 7:    // BEL
                mClient.onBell();
                break;
            case 8:    // BS (backspace)
                if (mCursorCol > 0) {
                    mCursorCol--;
                    mAboutToAutoWrap = false;
                }
                break;
            case 9:    // HT (horizontal tab)
                mCursorCol = nextTabStop(mCursorCol);
                mAboutToAutoWrap = false;
                break;
            case 10:   // LF (line feed)
            case 11:   // VT (vertical tab, same as LF)
            case 12:   // FF (form feed, same as LF)
                doLineFeed();
                break;
            case 13:   // CR (carriage return)
                mCursorCol = 0;
                mAboutToAutoWrap = false;
                break;
            case 14:   // SO (shift out) -- ignore charset switching
            case 15:   // SI (shift in) -- ignore charset switching
                break;
            case 24:   // CAN -- abort escape sequence
            case 26:   // SUB -- abort escape sequence
                mParseState = STATE_NORMAL;
                break;
            case 27:   // ESC
                mParseState = STATE_ESCAPE;
                break;
            default:
                if (cp >= 32) {
                    emitCodePoint(cp);
                }
                break;
        }
    }

    // ====================================================================
    // STATE_ESCAPE
    // ====================================================================

    private void processEscape(int cp) {
        switch (cp) {
            case '[':  // CSI
                mParseState = STATE_CSI;
                mCSIParamCount = 0;
                mCSIPrefix = 0;
                mCSIIntermediate.setLength(0);
                Arrays.fill(mCSIParams, -1);
                break;
            case ']':  // OSC
                mParseState = STATE_OSC;
                mOSCArgs.setLength(0);
                break;
            case '(':  // G0 charset designation -- ignore the next byte
            case ')':  // G1 charset designation -- ignore the next byte
            case '*':  // G2 charset designation
            case '+':  // G3 charset designation
                // Just consume the following designator byte.
                // We don't actually implement charset switching.
                mParseState = STATE_NORMAL;
                // Note: this consumes the next byte as part of the sequence.
                // Since we consume one byte above, we need to handle the next
                // byte.  For simplicity we just return to normal state and
                // let the designator byte be silently consumed in the next
                // processCodePoint call.  This works because designator bytes
                // are printable ASCII (like 'B', '0', etc.) and printing them
                // would be harmless but incorrect.  Better approach: set a flag
                // to skip one byte.  For now, this is acceptable.
                break;
            case 'D':  // IND (index -- move cursor down, scroll if needed)
                doLineFeed();
                mParseState = STATE_NORMAL;
                break;
            case 'E':  // NEL (next line)
                mCursorCol = 0;
                doLineFeed();
                mParseState = STATE_NORMAL;
                break;
            case 'H':  // HTS (horizontal tab set)
                if (mCursorCol < mColumns) {
                    mTabStops[mCursorCol] = true;
                }
                mParseState = STATE_NORMAL;
                break;
            case 'M':  // RI (reverse index -- move cursor up, scroll if needed)
                if (mCursorRow == mTopMargin) {
                    mScreen.scrollUpOneLine(mTopMargin, mBottomMargin, getStyle());
                } else if (mCursorRow > 0) {
                    mCursorRow--;
                }
                mAboutToAutoWrap = false;
                mParseState = STATE_NORMAL;
                break;
            case '7':  // DECSC (save cursor)
                saveCursor();
                mParseState = STATE_NORMAL;
                break;
            case '8':  // DECRC (restore cursor)
                restoreCursor();
                mParseState = STATE_NORMAL;
                break;
            case '=':  // DECKPAM (keypad application mode)
                mKeypadApplication = true;
                mParseState = STATE_NORMAL;
                break;
            case '>':  // DECKPNM (keypad numeric mode)
                mKeypadApplication = false;
                mParseState = STATE_NORMAL;
                break;
            case 'c':  // RIS (full reset)
                reset();
                long style = getStyle();
                mScreen.blockSet(0, 0, mColumns, mRows, ' ', style);
                mParseState = STATE_NORMAL;
                break;
            case '\\': // ST (string terminator) -- ignore stray ST
                mParseState = STATE_NORMAL;
                break;
            default:
                // Unknown escape sequence -- ignore and return to normal.
                mParseState = STATE_NORMAL;
                break;
        }
    }

    // ====================================================================
    // STATE_CSI (and CSI_PARAM, CSI_INTERMEDIATE)
    // ====================================================================

    private void processCSI(int cp) {
        // Collect prefix character (?, >, !)
        if (mParseState == STATE_CSI && (cp == '?' || cp == '>' || cp == '!')) {
            mCSIPrefix = cp;
            mParseState = STATE_CSI_PARAM;
            return;
        }

        // Transition from initial CSI to param state
        if (mParseState == STATE_CSI) {
            mParseState = STATE_CSI_PARAM;
        }

        // Digit: accumulate parameter
        if (cp >= '0' && cp <= '9') {
            if (mCSIParamCount == 0) mCSIParamCount = 1;
            int cur = mCSIParams[mCSIParamCount - 1];
            if (cur < 0) cur = 0;
            mCSIParams[mCSIParamCount - 1] = cur * 10 + (cp - '0');
            return;
        }

        // Semicolon: next parameter
        if (cp == ';') {
            if (mCSIParamCount < mCSIParams.length) {
                mCSIParamCount++;
                mCSIParams[mCSIParamCount - 1] = -1;
            }
            return;
        }

        // Intermediate bytes (0x20-0x2F)
        if (cp >= 0x20 && cp <= 0x2F) {
            mCSIIntermediate.append((char) cp);
            mParseState = STATE_CSI_INTERMEDIATE;
            return;
        }

        // Final byte (0x40-0x7E): execute the CSI sequence
        if (cp >= 0x40 && cp <= 0x7E) {
            executeCSI(cp);
            mParseState = STATE_NORMAL;
            return;
        }

        // C0 controls within CSI: handle inline
        if (cp < 0x20) {
            processNormal(cp);
            return;
        }

        // Anything else: abort
        mParseState = STATE_NORMAL;
    }

    /** Helper: get CSI param with a default value. */
    private int getCSIParam(int index, int defaultValue) {
        if (index >= mCSIParamCount) return defaultValue;
        int v = mCSIParams[index];
        return v < 0 ? defaultValue : v;
    }

    private void executeCSI(int finalByte) {
        // Handle intermediate characters (e.g., CSI ? ... h, CSI SP q)
        String intermediate = mCSIIntermediate.toString();

        if (mCSIPrefix == '?') {
            executeDECPrivateMode(finalByte);
            return;
        }

        if (mCSIPrefix == '!' && finalByte == 'p') {
            // DECSTR -- soft terminal reset
            reset();
            return;
        }

        switch (finalByte) {
            case '@': { // ICH -- insert blank characters
                int n = getCSIParam(0, 1);
                insertBlankChars(n);
                break;
            }
            case 'A': { // CUU -- cursor up
                int n = getCSIParam(0, 1);
                int newRow = mCursorRow - n;
                int top = mOriginMode ? mTopMargin : 0;
                mCursorRow = Math.max(newRow, top);
                mAboutToAutoWrap = false;
                break;
            }
            case 'B': { // CUD -- cursor down
                int n = getCSIParam(0, 1);
                int newRow = mCursorRow + n;
                int bottom = mOriginMode ? mBottomMargin : mRows - 1;
                mCursorRow = Math.min(newRow, bottom);
                mAboutToAutoWrap = false;
                break;
            }
            case 'C': { // CUF -- cursor forward
                int n = getCSIParam(0, 1);
                mCursorCol = Math.min(mCursorCol + n, mColumns - 1);
                mAboutToAutoWrap = false;
                break;
            }
            case 'D': { // CUB -- cursor backward
                int n = getCSIParam(0, 1);
                mCursorCol = Math.max(mCursorCol - n, 0);
                mAboutToAutoWrap = false;
                break;
            }
            case 'E': { // CNL -- cursor next line
                int n = getCSIParam(0, 1);
                mCursorCol = 0;
                int bottom = mOriginMode ? mBottomMargin : mRows - 1;
                mCursorRow = Math.min(mCursorRow + n, bottom);
                mAboutToAutoWrap = false;
                break;
            }
            case 'F': { // CPL -- cursor previous line
                int n = getCSIParam(0, 1);
                mCursorCol = 0;
                int top = mOriginMode ? mTopMargin : 0;
                mCursorRow = Math.max(mCursorRow - n, top);
                mAboutToAutoWrap = false;
                break;
            }
            case 'G': { // CHA -- cursor horizontal absolute
                int col = getCSIParam(0, 1) - 1;
                mCursorCol = Math.max(0, Math.min(col, mColumns - 1));
                mAboutToAutoWrap = false;
                break;
            }
            case 'H': // CUP -- cursor position
            case 'f': { // HVP -- horizontal vertical position
                int row = getCSIParam(0, 1) - 1;
                int col = getCSIParam(1, 1) - 1;
                if (mOriginMode) row += mTopMargin;
                mCursorRow = Math.max(0, Math.min(row, mRows - 1));
                mCursorCol = Math.max(0, Math.min(col, mColumns - 1));
                mAboutToAutoWrap = false;
                break;
            }
            case 'I': { // CHT -- cursor forward tabulation
                int n = getCSIParam(0, 1);
                for (int t = 0; t < n; t++) {
                    mCursorCol = nextTabStop(mCursorCol);
                }
                mAboutToAutoWrap = false;
                break;
            }
            case 'J': { // ED -- erase in display
                int mode = getCSIParam(0, 0);
                eraseInDisplay(mode);
                break;
            }
            case 'K': { // EL -- erase in line
                int mode = getCSIParam(0, 0);
                eraseInLine(mode);
                break;
            }
            case 'L': { // IL -- insert lines
                int n = getCSIParam(0, 1);
                if (mCursorRow >= mTopMargin && mCursorRow <= mBottomMargin) {
                    for (int j = 0; j < n; j++) {
                        mScreen.scrollUpOneLine(mCursorRow, mBottomMargin, getStyle());
                    }
                    mCursorCol = 0;
                    mAboutToAutoWrap = false;
                }
                break;
            }
            case 'M': { // DL -- delete lines
                int n = getCSIParam(0, 1);
                if (mCursorRow >= mTopMargin && mCursorRow <= mBottomMargin) {
                    for (int j = 0; j < n; j++) {
                        mScreen.scrollDownOneLine(mCursorRow, mBottomMargin, getStyle());
                    }
                    mCursorCol = 0;
                    mAboutToAutoWrap = false;
                }
                break;
            }
            case 'P': { // DCH -- delete characters
                int n = getCSIParam(0, 1);
                deleteChars(n);
                break;
            }
            case 'S': { // SU -- scroll up
                int n = getCSIParam(0, 1);
                for (int j = 0; j < n; j++) {
                    mScreen.scrollDownOneLine(mTopMargin, mBottomMargin, getStyle());
                }
                break;
            }
            case 'T': { // SD -- scroll down
                int n = getCSIParam(0, 1);
                for (int j = 0; j < n; j++) {
                    mScreen.scrollUpOneLine(mTopMargin, mBottomMargin, getStyle());
                }
                break;
            }
            case 'X': { // ECH -- erase characters
                int n = getCSIParam(0, 1);
                long style = getStyle();
                int end = Math.min(mCursorCol + n, mColumns);
                TerminalRow row = mScreen.allocateFullLineIfNecessary(mCursorRow);
                for (int col = mCursorCol; col < end; col++) {
                    row.setChar(col, ' ', style);
                }
                break;
            }
            case 'Z': { // CBT -- cursor backward tabulation
                int n = getCSIParam(0, 1);
                for (int t = 0; t < n; t++) {
                    mCursorCol = prevTabStop(mCursorCol);
                }
                mAboutToAutoWrap = false;
                break;
            }
            case '`': { // HPA -- horizontal position absolute (same as CHA)
                int col = getCSIParam(0, 1) - 1;
                mCursorCol = Math.max(0, Math.min(col, mColumns - 1));
                mAboutToAutoWrap = false;
                break;
            }
            case 'a': { // HPR -- horizontal position relative (same as CUF)
                int n = getCSIParam(0, 1);
                mCursorCol = Math.min(mCursorCol + n, mColumns - 1);
                mAboutToAutoWrap = false;
                break;
            }
            case 'b': { // REP -- repeat preceding graphic character
                int n = getCSIParam(0, 1);
                // We don't track the last graphic char, so ignore.
                break;
            }
            case 'c': { // DA -- device attributes
                if (getCSIParam(0, 0) == 0) {
                    // Response: VT220 with ANSI color
                    byte[] response = "\033[?62;22c".getBytes(StandardCharsets.UTF_8);
                    mClient.write(response, 0, response.length);
                }
                break;
            }
            case 'd': { // VPA -- vertical position absolute
                int row = getCSIParam(0, 1) - 1;
                if (mOriginMode) row += mTopMargin;
                mCursorRow = Math.max(0, Math.min(row, mRows - 1));
                mAboutToAutoWrap = false;
                break;
            }
            case 'e': { // VPR -- vertical position relative
                int n = getCSIParam(0, 1);
                int bottom = mOriginMode ? mBottomMargin : mRows - 1;
                mCursorRow = Math.min(mCursorRow + n, bottom);
                mAboutToAutoWrap = false;
                break;
            }
            case 'g': { // TBC -- tabulation clear
                int mode = getCSIParam(0, 0);
                if (mode == 0) {
                    // Clear tab stop at current column.
                    if (mCursorCol < mColumns) mTabStops[mCursorCol] = false;
                } else if (mode == 3) {
                    // Clear all tab stops.
                    Arrays.fill(mTabStops, false);
                }
                break;
            }
            case 'h': { // SM -- set mode
                for (int k = 0; k < mCSIParamCount; k++) {
                    setMode(getCSIParam(k, 0), true);
                }
                break;
            }
            case 'l': { // RM -- reset mode
                for (int k = 0; k < mCSIParamCount; k++) {
                    setMode(getCSIParam(k, 0), false);
                }
                break;
            }
            case 'm': { // SGR -- select graphic rendition
                selectGraphicRendition();
                break;
            }
            case 'n': { // DSR -- device status report
                int param = getCSIParam(0, 0);
                if (param == 5) {
                    // Status report: "OK"
                    byte[] response = "\033[0n".getBytes(StandardCharsets.UTF_8);
                    mClient.write(response, 0, response.length);
                } else if (param == 6) {
                    // Cursor position report
                    int reportRow = mCursorRow + 1;
                    int reportCol = mCursorCol + 1;
                    if (mOriginMode) reportRow -= mTopMargin;
                    byte[] response = ("\033[" + reportRow + ";" + reportCol + "R")
                            .getBytes(StandardCharsets.UTF_8);
                    mClient.write(response, 0, response.length);
                }
                break;
            }
            case 'r': { // DECSTBM -- set top and bottom margins
                int top = getCSIParam(0, 1) - 1;
                int bottom = getCSIParam(1, mRows) - 1;
                if (top < 0) top = 0;
                if (bottom >= mRows) bottom = mRows - 1;
                if (top < bottom) {
                    mTopMargin = top;
                    mBottomMargin = bottom;
                    // Move cursor to home (respecting origin mode).
                    mCursorRow = mOriginMode ? mTopMargin : 0;
                    mCursorCol = 0;
                    mAboutToAutoWrap = false;
                }
                break;
            }
            case 's': { // SCP / ANSI.SYS save cursor position
                saveCursor();
                break;
            }
            case 't': { // Window manipulation -- largely ignored
                // We respond to CSI 18 t (report terminal size)
                int param = getCSIParam(0, 0);
                if (param == 18) {
                    byte[] response = ("\033[8;" + mRows + ";" + mColumns + "t")
                            .getBytes(StandardCharsets.UTF_8);
                    mClient.write(response, 0, response.length);
                }
                break;
            }
            case 'u': { // RCP / ANSI.SYS restore cursor position
                restoreCursor();
                break;
            }
            default:
                // Unknown CSI final byte -- ignore.
                break;
        }
    }

    // ---- DEC Private Modes (CSI ? ... h/l) ----

    private void executeDECPrivateMode(int finalByte) {
        if (finalByte != 'h' && finalByte != 'l') {
            // Unknown final byte for DEC private mode
            return;
        }
        boolean set = (finalByte == 'h');
        for (int k = 0; k < Math.max(mCSIParamCount, 1); k++) {
            int param = getCSIParam(k, 0);
            switch (param) {
                case 1:    // DECCKM -- application cursor keys
                    mCursorKeysApplication = set;
                    break;
                case 5:    // DECSCNM -- reverse video (ignore, but acknowledge)
                    break;
                case 6:    // DECOM -- origin mode
                    mOriginMode = set;
                    mCursorRow = mOriginMode ? mTopMargin : 0;
                    mCursorCol = 0;
                    mAboutToAutoWrap = false;
                    break;
                case 7:    // DECAWM -- auto-wrap mode
                    mAutowrapMode = set;
                    break;
                case 12:   // ATT610 -- start blinking cursor (ignore)
                    break;
                case 25:   // DECTCEM -- cursor visible
                    mCursorVisible = set;
                    break;
                case 47:   // Alternate screen buffer (no save/restore cursor)
                    if (set) {
                        switchToAlternateScreen();
                    } else {
                        switchToMainScreen();
                    }
                    break;
                case 1000: // X11 mouse tracking -- ignore
                case 1002: // Cell motion mouse tracking -- ignore
                case 1003: // All motion mouse tracking -- ignore
                case 1005: // UTF-8 mouse mode -- ignore
                case 1006: // SGR mouse mode -- ignore
                case 1015: // URXVT mouse mode -- ignore
                    break;
                case 1034: // Interpret Meta key sets 8th bit -- ignore
                    break;
                case 1047: // Alternate screen buffer
                    if (set) {
                        switchToAlternateScreen();
                    } else {
                        switchToMainScreen();
                    }
                    break;
                case 1048: // Save/restore cursor
                    if (set) saveCursor();
                    else     restoreCursor();
                    break;
                case 1049: // Save cursor + switch to alt screen (most common)
                    if (set) {
                        saveCursor();
                        switchToAlternateScreen();
                        // Clear the alternate screen
                        mScreen.blockSet(0, 0, mColumns, mRows, ' ', getStyle());
                        mCursorRow = 0;
                        mCursorCol = 0;
                    } else {
                        switchToMainScreen();
                        restoreCursor();
                    }
                    mAboutToAutoWrap = false;
                    break;
                case 2004: // Bracketed paste mode
                    mBracketedPasteMode = set;
                    break;
                default:
                    // Unimplemented DEC private mode -- ignore.
                    break;
            }
        }
    }

    // ---- Standard modes (SM/RM) ----

    private void setMode(int mode, boolean set) {
        switch (mode) {
            case 4: // IRM -- insert/replace mode
                mInsertMode = set;
                break;
            case 20: // LNM -- automatic newline (ignored by most terminals)
                break;
            default:
                break;
        }
    }

    // ====================================================================
    // SGR (Select Graphic Rendition)
    // ====================================================================

    private void selectGraphicRendition() {
        if (mCSIParamCount == 0) {
            // CSI m with no params == CSI 0 m (reset)
            mEffect = 0;
            mForeColor = 0;
            mBackColor = 0;
            return;
        }

        for (int i = 0; i < mCSIParamCount; i++) {
            int p = getCSIParam(i, 0);

            if (p == 0) {
                // Reset all
                mEffect = 0;
                mForeColor = 0;
                mBackColor = 0;
            } else if (p == 1) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_BOLD;
            } else if (p == 2) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_DIM;
            } else if (p == 3) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_ITALIC;
            } else if (p == 4) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE;
            } else if (p == 5 || p == 6) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_BLINK;
            } else if (p == 7) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_INVERSE;
            } else if (p == 8) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE;
            } else if (p == 9) {
                mEffect |= TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH;
            } else if (p == 22) {
                // Normal intensity (remove bold and dim)
                mEffect &= ~(TextStyle.CHARACTER_ATTRIBUTE_BOLD | TextStyle.CHARACTER_ATTRIBUTE_DIM);
            } else if (p == 23) {
                mEffect &= ~TextStyle.CHARACTER_ATTRIBUTE_ITALIC;
            } else if (p == 24) {
                mEffect &= ~TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE;
            } else if (p == 25) {
                mEffect &= ~TextStyle.CHARACTER_ATTRIBUTE_BLINK;
            } else if (p == 27) {
                mEffect &= ~TextStyle.CHARACTER_ATTRIBUTE_INVERSE;
            } else if (p == 28) {
                mEffect &= ~TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE;
            } else if (p == 29) {
                mEffect &= ~TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH;
            } else if (p >= 30 && p <= 37) {
                // Standard foreground color (palette indices 0-7)
                mForeColor = p - 30 + 1; // +1 because 0 means default
            } else if (p == 38) {
                // Extended foreground color
                i = parseExtendedColor(i, true);
            } else if (p == 39) {
                // Default foreground
                mForeColor = 0;
            } else if (p >= 40 && p <= 47) {
                // Standard background color
                mBackColor = p - 40 + 1;
            } else if (p == 48) {
                // Extended background color
                i = parseExtendedColor(i, false);
            } else if (p == 49) {
                // Default background
                mBackColor = 0;
            } else if (p >= 90 && p <= 97) {
                // Bright foreground color (palette indices 8-15)
                mForeColor = p - 90 + 8 + 1;
            } else if (p >= 100 && p <= 107) {
                // Bright background color
                mBackColor = p - 100 + 8 + 1;
            }
        }
    }

    /**
     * Parse an extended color specification (SGR 38 or 48).
     * <ul>
     *   <li>38;5;N -- 256-color palette</li>
     *   <li>38;2;R;G;B -- 24-bit true color</li>
     * </ul>
     *
     * @param paramIndex current index into mCSIParams (pointing at the 38 or 48)
     * @param foreground true for foreground, false for background
     * @return the new param index after consuming sub-parameters
     */
    private int parseExtendedColor(int paramIndex, boolean foreground) {
        int nextIndex = paramIndex + 1;
        if (nextIndex >= mCSIParamCount) return paramIndex;

        int subType = getCSIParam(nextIndex, 0);
        if (subType == 5) {
            // 256-color: 38;5;N
            nextIndex++;
            if (nextIndex < mCSIParamCount) {
                int colorIndex = getCSIParam(nextIndex, 0);
                if (colorIndex >= 0 && colorIndex <= 255) {
                    int encoded = colorIndex + 1; // +1 because 0 = default
                    if (foreground) mForeColor = encoded;
                    else            mBackColor = encoded;
                }
            }
            return nextIndex;
        } else if (subType == 2) {
            // True color: 38;2;R;G;B
            // We map to the nearest 256-color palette index.
            if (nextIndex + 3 < mCSIParamCount) {
                int r = getCSIParam(nextIndex + 1, 0);
                int g = getCSIParam(nextIndex + 2, 0);
                int b = getCSIParam(nextIndex + 3, 0);
                r = Math.max(0, Math.min(255, r));
                g = Math.max(0, Math.min(255, g));
                b = Math.max(0, Math.min(255, b));
                int colorIndex = mapTrueColorToPalette(r, g, b);
                int encoded = colorIndex + 1;
                if (foreground) mForeColor = encoded;
                else            mBackColor = encoded;
                return nextIndex + 3;
            }
            return paramIndex;
        }
        return paramIndex;
    }

    /**
     * Map an RGB true color value to the nearest index in the 256-color palette.
     * Checks both the 216-color cube (16-231) and the 24-step grayscale (232-255).
     */
    private int mapTrueColorToPalette(int r, int g, int b) {
        // Check if it's a grayscale
        if (r == g && g == b) {
            if (r < 4) return 16;   // Closest to black in cube
            if (r > 248) return 231; // Closest to white in cube
            // Grayscale ramp: index = round((r - 8) / 10) + 232
            int grayIndex = Math.round((r - 8) / 10.0f) + 232;
            grayIndex = Math.max(232, Math.min(255, grayIndex));
            return grayIndex;
        }

        // Map to 6x6x6 cube
        int ri = (r < 48) ? 0 : (r < 115) ? 1 : (r - 35) / 40;
        int gi = (g < 48) ? 0 : (g < 115) ? 1 : (g - 35) / 40;
        int bi = (b < 48) ? 0 : (b < 115) ? 1 : (b - 35) / 40;
        ri = Math.max(0, Math.min(5, ri));
        gi = Math.max(0, Math.min(5, gi));
        bi = Math.max(0, Math.min(5, bi));
        return 16 + 36 * ri + 6 * gi + bi;
    }

    // ====================================================================
    // STATE_OSC
    // ====================================================================

    private void processOSC(int cp) {
        if (cp == 7) {
            // BEL terminates OSC
            executeOSC();
            mParseState = STATE_NORMAL;
        } else if (cp == 27) {
            // ESC might start ST (ESC \)
            mParseState = STATE_OSC_ESC;
        } else {
            if (mOSCArgs.length() < 4096) { // Sanity limit
                mOSCArgs.append((char) cp);
            }
        }
    }

    private void processOSCEsc(int cp) {
        if (cp == '\\') {
            // ST = ESC \ -- terminates OSC
            executeOSC();
        } else {
            // Not ST; put the ESC back and process this byte normally
            mOSCArgs.append('\033');
            mOSCArgs.append((char) cp);
        }
        mParseState = STATE_NORMAL;
    }

    private void executeOSC() {
        String oscString = mOSCArgs.toString();
        int semicolonIndex = oscString.indexOf(';');
        if (semicolonIndex < 0) return;

        String commandStr = oscString.substring(0, semicolonIndex);
        String arg = oscString.substring(semicolonIndex + 1);

        int command;
        try {
            command = Integer.parseInt(commandStr);
        } catch (NumberFormatException e) {
            return;
        }

        switch (command) {
            case 0:  // Set icon name and window title
            case 2: { // Set window title
                String oldTitle = mTitle;
                mTitle = arg;
                mClient.titleChanged(oldTitle, mTitle);
                break;
            }
            case 1: {
                // Set icon name only -- we treat it as title too.
                String oldTitle = mTitle;
                mTitle = arg;
                mClient.titleChanged(oldTitle, mTitle);
                break;
            }
            case 4: {
                // Change/query color palette entries -- partially handled.
                // OSC 4 ; <index> ; <colorspec> ST
                // For now, just acknowledge without changing colors.
                break;
            }
            case 10: {
                // Set/query default foreground color
                if ("?".equals(arg)) {
                    // Query: respond with current foreground color
                    int color = mColors.mCurrentColors[TerminalColors.COLOR_INDEX_FOREGROUND];
                    String response = "\033]10;" + colorToXParseColor(color) + "\033\\";
                    byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
                    mClient.write(responseBytes, 0, responseBytes.length);
                }
                break;
            }
            case 11: {
                // Set/query default background color
                if ("?".equals(arg)) {
                    int color = mColors.mCurrentColors[TerminalColors.COLOR_INDEX_BACKGROUND];
                    String response = "\033]11;" + colorToXParseColor(color) + "\033\\";
                    byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
                    mClient.write(responseBytes, 0, responseBytes.length);
                }
                break;
            }
            case 52: {
                // Clipboard access (OSC 52)
                // OSC 52 ; <selection> ; <data> ST
                int semi2 = arg.indexOf(';');
                if (semi2 >= 0) {
                    String clipData = arg.substring(semi2 + 1);
                    if (!"?".equals(clipData)) {
                        // Base64 encoded clipboard content
                        try {
                            byte[] decoded = java.util.Base64.getDecoder().decode(clipData);
                            mClient.clipboardText(new String(decoded, StandardCharsets.UTF_8));
                        } catch (IllegalArgumentException e) {
                            // Invalid base64 -- ignore.
                        }
                    }
                }
                break;
            }
            case 104: // Reset color palette -- partially handled
                mColors.reset();
                mClient.onColorsChanged();
                break;
            case 110: // Reset default foreground
                mColors.mCurrentColors[TerminalColors.COLOR_INDEX_FOREGROUND] =
                        TerminalColors.DEFAULT_COLORSCHEME[TerminalColors.COLOR_INDEX_FOREGROUND];
                mClient.onColorsChanged();
                break;
            case 111: // Reset default background
                mColors.mCurrentColors[TerminalColors.COLOR_INDEX_BACKGROUND] =
                        TerminalColors.DEFAULT_COLORSCHEME[TerminalColors.COLOR_INDEX_BACKGROUND];
                mClient.onColorsChanged();
                break;
            default:
                // Unknown OSC command -- ignore.
                break;
        }
    }

    /** Convert an ARGB color int to an X11 rgb: color string for terminal queries. */
    private static String colorToXParseColor(int color) {
        int r = (color >> 16) & 0xFF;
        int g = (color >> 8) & 0xFF;
        int b = color & 0xFF;
        return String.format("rgb:%02x%02x/%02x%02x/%02x%02x", r, r, g, g, b, b);
    }

    // ====================================================================
    // Character emission
    // ====================================================================

    /**
     * Emit a printable code point at the current cursor position.
     */
    private void emitCodePoint(int cp) {
        int displayWidth = WcWidth.width(cp);
        if (displayWidth <= 0) {
            // Zero-width or control character.
            if (displayWidth == 0) {
                // Combining character: attach to previous cell (simplified: just ignore).
                // A proper implementation would combine with the preceding character.
            }
            return;
        }

        // Handle autowrap: if the cursor just passed the right edge in a
        // previous call, wrap now.
        if (mAboutToAutoWrap) {
            if (mAutowrapMode) {
                // Mark the current line as wrapped
                mScreen.allocateFullLineIfNecessary(mCursorRow).mLineWrap = true;
                mCursorCol = 0;
                doLineFeedInternal();
            }
            mAboutToAutoWrap = false;
        }

        // Wide character: if there isn't room, pad and wrap
        if (displayWidth == 2 && mCursorCol == mColumns - 1) {
            // No room for a wide char at the last column.
            if (mAutowrapMode) {
                mScreen.allocateFullLineIfNecessary(mCursorRow).setChar(mCursorCol, ' ', getStyle());
                mScreen.allocateFullLineIfNecessary(mCursorRow).mLineWrap = true;
                mCursorCol = 0;
                doLineFeedInternal();
            } else {
                // Can't display wide char here; just put it in the last column (truncated).
                displayWidth = 1;
            }
        }

        // Insert mode: shift existing characters right.
        if (mInsertMode) {
            int shift = displayWidth;
            TerminalRow row = mScreen.allocateFullLineIfNecessary(mCursorRow);
            for (int col = mColumns - 1; col >= mCursorCol + shift; col--) {
                row.setChar(col, row.getChar(col - shift), row.getStyle(col - shift));
            }
        }

        long style = getStyle();
        mScreen.setChar(mCursorCol, mCursorRow, cp, style);
        mCursorCol += displayWidth;

        if (mCursorCol >= mColumns) {
            // Cursor is now at/past the right edge.
            mCursorCol = mColumns - 1;
            mAboutToAutoWrap = true;
        }
    }

    // ====================================================================
    // Line feed
    // ====================================================================

    private void doLineFeed() {
        doLineFeedInternal();
        mAboutToAutoWrap = false;
    }

    /**
     * Move cursor down by one row.  If the cursor is at the bottom margin,
     * scroll the content up instead.
     */
    private void doLineFeedInternal() {
        if (mCursorRow == mBottomMargin) {
            mScreen.scrollDownOneLine(mTopMargin, mBottomMargin, getStyle());
        } else if (mCursorRow < mRows - 1) {
            mCursorRow++;
        }
    }

    // ====================================================================
    // Erase
    // ====================================================================

    private void eraseInDisplay(int mode) {
        long style = getStyle();
        switch (mode) {
            case 0: // Erase from cursor to end of display
                eraseInLine(0);
                for (int row = mCursorRow + 1; row < mRows; row++) {
                    mScreen.allocateFullLineIfNecessary(row).clear(style);
                }
                break;
            case 1: // Erase from start of display to cursor
                for (int row = 0; row < mCursorRow; row++) {
                    mScreen.allocateFullLineIfNecessary(row).clear(style);
                }
                eraseInLine(1);
                break;
            case 2: // Erase entire display
                for (int row = 0; row < mRows; row++) {
                    mScreen.allocateFullLineIfNecessary(row).clear(style);
                }
                break;
            case 3: // Erase scrollback (xterm extension)
                // Clear scrollback by resetting transcript
                // For simplicity, just clear the visible area like mode 2.
                for (int row = 0; row < mRows; row++) {
                    mScreen.allocateFullLineIfNecessary(row).clear(style);
                }
                break;
        }
    }

    private void eraseInLine(int mode) {
        long style = getStyle();
        TerminalRow row = mScreen.allocateFullLineIfNecessary(mCursorRow);
        switch (mode) {
            case 0: // Erase from cursor to end of line
                for (int col = mCursorCol; col < mColumns; col++) {
                    row.setChar(col, ' ', style);
                }
                break;
            case 1: // Erase from start of line to cursor
                for (int col = 0; col <= mCursorCol && col < mColumns; col++) {
                    row.setChar(col, ' ', style);
                }
                break;
            case 2: // Erase entire line
                row.clear(style);
                break;
        }
    }

    // ====================================================================
    // Insert / delete characters
    // ====================================================================

    private void insertBlankChars(int count) {
        long style = getStyle();
        TerminalRow row = mScreen.allocateFullLineIfNecessary(mCursorRow);
        int end = mColumns;
        // Shift characters to the right
        for (int col = end - 1; col >= mCursorCol + count; col--) {
            row.setChar(col, row.getChar(col - count), row.getStyle(col - count));
        }
        // Fill inserted positions with blanks
        for (int col = mCursorCol; col < mCursorCol + count && col < end; col++) {
            row.setChar(col, ' ', style);
        }
    }

    private void deleteChars(int count) {
        long style = getStyle();
        TerminalRow row = mScreen.allocateFullLineIfNecessary(mCursorRow);
        // Shift characters to the left
        for (int col = mCursorCol; col + count < mColumns; col++) {
            row.setChar(col, row.getChar(col + count), row.getStyle(col + count));
        }
        // Fill vacated positions at the end with blanks
        for (int col = Math.max(mCursorCol, mColumns - count); col < mColumns; col++) {
            row.setChar(col, ' ', style);
        }
    }

    // ====================================================================
    // Cursor save / restore
    // ====================================================================

    private void saveCursor() {
        if (mUsingAlternateScreen) {
            mSavedAltCursorRow = mCursorRow;
            mSavedAltCursorCol = mCursorCol;
        } else {
            mSavedCursorRow = mCursorRow;
            mSavedCursorCol = mCursorCol;
            mSavedForeColor = mForeColor;
            mSavedBackColor = mBackColor;
            mSavedEffect = mEffect;
            mSavedOriginMode = mOriginMode;
        }
    }

    private void restoreCursor() {
        if (mUsingAlternateScreen) {
            mCursorRow = Math.min(mSavedAltCursorRow, mRows - 1);
            mCursorCol = Math.min(mSavedAltCursorCol, mColumns - 1);
        } else {
            mCursorRow = Math.min(mSavedCursorRow, mRows - 1);
            mCursorCol = Math.min(mSavedCursorCol, mColumns - 1);
            mForeColor = mSavedForeColor;
            mBackColor = mSavedBackColor;
            mEffect = mSavedEffect;
            mOriginMode = mSavedOriginMode;
        }
        mAboutToAutoWrap = false;
    }

    // ====================================================================
    // Alternate screen
    // ====================================================================

    private void switchToAlternateScreen() {
        if (!mUsingAlternateScreen) {
            mUsingAlternateScreen = true;
            mScreen = mAltBuffer;
        }
    }

    private void switchToMainScreen() {
        if (mUsingAlternateScreen) {
            mUsingAlternateScreen = false;
            mScreen = mMainBuffer;
        }
    }

    // ====================================================================
    // Tab stops
    // ====================================================================

    private void setDefaultTabStops() {
        for (int i = 0; i < mTabStops.length; i++) {
            mTabStops[i] = (i % 8 == 0);
        }
    }

    private int nextTabStop(int col) {
        for (int i = col + 1; i < mColumns; i++) {
            if (mTabStops[i]) return i;
        }
        return mColumns - 1;
    }

    private int prevTabStop(int col) {
        for (int i = col - 1; i >= 0; i--) {
            if (mTabStops[i]) return i;
        }
        return 0;
    }

    // ====================================================================
    // Paste support
    // ====================================================================

    /**
     * Return bracketed paste prefix/suffix if bracketed paste mode is active.
     *
     * @param start true for the start bracket, false for the end bracket
     * @return the bracket string, or empty string if mode is off
     */
    public String getBracketedPasteBracket(boolean start) {
        if (!mBracketedPasteMode) return "";
        return start ? "\033[200~" : "\033[201~";
    }
}
