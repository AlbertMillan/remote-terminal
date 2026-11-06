/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink.
 */
package com.termux.terminal;

/**
 * Circular buffer of {@link TerminalRow} objects representing both the visible
 * screen and the scrollback history.
 * <p>
 * Row addressing:
 * <ul>
 *   <li>Screen rows are numbered 0 (top) through {@code mScreenRows - 1} (bottom).</li>
 *   <li>Scrollback rows are at negative indices: -1 is the most recent scrollback
 *       line, -{@link #getActiveTranscriptRows()} is the oldest.</li>
 * </ul>
 */
public final class TerminalBuffer {

    /** The backing circular array of rows. */
    TerminalRow[] mLines;

    /** Total capacity (screen rows + scrollback rows). */
    int mTotalRows;

    /** Number of visible screen rows. */
    int mScreenRows;

    /** Number of columns. */
    int mColumns;

    /**
     * Index into {@link #mLines} of the first visible screen row.
     * Wraps around modulo {@link #mTotalRows}.
     */
    int mScreenFirstRow = 0;

    /** Number of scrollback rows that actually contain data. */
    private int mActiveTranscriptRows = 0;

    public TerminalBuffer(int columns, int totalRows, int screenRows) {
        mColumns = columns;
        mTotalRows = totalRows;
        mScreenRows = screenRows;
        mLines = new TerminalRow[totalRows];
        long defaultStyle = TextStyle.encode(0, 0, 0);
        for (int i = 0; i < totalRows; i++) {
            mLines[i] = new TerminalRow(columns, defaultStyle);
        }
    }

    // ---- Row access ----

    /** Number of scrollback rows that contain data. */
    public int getActiveTranscriptRows() {
        return mActiveTranscriptRows;
    }

    /**
     * Convert an external row number to an internal index into {@link #mLines}.
     * External row 0 is the first visible screen row.  Negative values address
     * scrollback (e.g. -1 is the most recent scrollback line).
     */
    public int externalToInternalRow(int externalRow) {
        int internalRow = (mScreenFirstRow + externalRow) % mTotalRows;
        if (internalRow < 0) internalRow += mTotalRows;
        return internalRow;
    }

    /**
     * Return the {@link TerminalRow} for the given external row, allocating a
     * fresh row if the slot is somehow null (should not happen normally).
     */
    public TerminalRow allocateFullLineIfNecessary(int externalRow) {
        int internalRow = externalToInternalRow(externalRow);
        if (mLines[internalRow] == null) {
            mLines[internalRow] = new TerminalRow(mColumns, TextStyle.encode(0, 0, 0));
        }
        return mLines[internalRow];
    }

    // ---- Cell access ----

    /** Set a single cell at (column, row) on the visible screen. */
    public void setChar(int column, int row, int codePoint, long style) {
        allocateFullLineIfNecessary(row).setChar(column, codePoint, style);
    }

    // ---- Dimensions ----

    public int getScreenRows() {
        return mScreenRows;
    }

    public int getColumns() {
        return mColumns;
    }

    // ---- Scrolling ----

    /**
     * Scroll the region between {@code topMargin} and {@code bottomMargin}
     * (inclusive, screen-relative) up by one line.  The new blank line at the
     * bottom of the region uses the given style.
     */
    public void scrollDownOneLine(int topMargin, int bottomMargin, long style) {
        if (topMargin == 0 && bottomMargin == mScreenRows - 1) {
            // Fast path: whole-screen scroll.  Rotate the ring buffer.
            mScreenFirstRow = (mScreenFirstRow + 1) % mTotalRows;
            mActiveTranscriptRows = Math.min(mActiveTranscriptRows + 1, mTotalRows - mScreenRows);
            mScrollCounter++;
            mLines[externalToInternalRow(mScreenRows - 1)] = new TerminalRow(mColumns, style);
        } else {
            // Scroll a sub-region: shift rows up within the region.
            int topInternal = externalToInternalRow(topMargin);
            TerminalRow removedRow = mLines[topInternal];
            for (int i = topMargin; i < bottomMargin; i++) {
                mLines[externalToInternalRow(i)] = mLines[externalToInternalRow(i + 1)];
            }
            removedRow.clear(style);
            mLines[externalToInternalRow(bottomMargin)] = removedRow;
        }
    }

    /**
     * Scroll the region between {@code topMargin} and {@code bottomMargin}
     * (inclusive) down by one line (i.e. insert a blank line at the top of the
     * region and push the bottom line out).
     */
    public void scrollUpOneLine(int topMargin, int bottomMargin, long style) {
        int bottomInternal = externalToInternalRow(bottomMargin);
        TerminalRow removedRow = mLines[bottomInternal];
        for (int i = bottomMargin; i > topMargin; i--) {
            mLines[externalToInternalRow(i)] = mLines[externalToInternalRow(i - 1)];
        }
        removedRow.clear(style);
        mLines[externalToInternalRow(topMargin)] = removedRow;
    }

    // ---- Block operations ----

    /**
     * Copy a rectangular block of cells from one location to another within
     * the visible screen.
     */
    public void blockCopy(int srcX, int srcY, int w, int h, int destX, int destY) {
        if (w <= 0 || h <= 0) return;

        boolean copyForward = (destY < srcY) || (destY == srcY && destX < srcX);
        if (copyForward) {
            for (int y = 0; y < h; y++) {
                TerminalRow srcRow = allocateFullLineIfNecessary(srcY + y);
                TerminalRow dstRow = allocateFullLineIfNecessary(destY + y);
                for (int x = 0; x < w; x++) {
                    int sc = srcX + x;
                    int dc = destX + x;
                    if (sc < mColumns && dc < mColumns) {
                        dstRow.setChar(dc, srcRow.getChar(sc), srcRow.getStyle(sc));
                    }
                }
            }
        } else {
            for (int y = h - 1; y >= 0; y--) {
                TerminalRow srcRow = allocateFullLineIfNecessary(srcY + y);
                TerminalRow dstRow = allocateFullLineIfNecessary(destY + y);
                for (int x = w - 1; x >= 0; x--) {
                    int sc = srcX + x;
                    int dc = destX + x;
                    if (sc < mColumns && dc < mColumns) {
                        dstRow.setChar(dc, srcRow.getChar(sc), srcRow.getStyle(sc));
                    }
                }
            }
        }
    }

    /**
     * Fill a rectangular block of cells with a code point and style.
     */
    public void blockSet(int x, int y, int w, int h, int codePoint, long style) {
        for (int row = y; row < y + h; row++) {
            TerminalRow line = allocateFullLineIfNecessary(row);
            for (int col = x; col < x + w; col++) {
                if (col >= 0 && col < mColumns) {
                    line.setChar(col, codePoint, style);
                }
            }
        }
    }

    // ---- Resize ----

    /**
     * Resize the buffer to new dimensions, keeping the scrollback (claude-remote: the
     * Termlink fork dropped it, and a phone resizes on every keyboard show/hide).
     * Rows are not reflowed: a narrower terminal truncates them, a wider one pads.
     * When the cursor would fall below the new screen, the top screen rows move
     * into the scrollback so the cursor stays on screen.
     *
     * @param newColumns   new number of columns
     * @param newRows      new visible screen rows
     * @param newTotalRows new total capacity
     * @param style        style for newly created blank cells
     * @param cursorRow    current cursor row (used for content anchoring)
     * @return how many rows the content moved up; the caller moves its cursor by as much
     */
    public int resize(int newColumns, int newRows, int newTotalRows, long style, int cursorRow) {
        int shift = Math.max(0, cursorRow - newRows + 1);
        int maxTranscript = newTotalRows - newRows;
        int newTranscript = Math.min(mActiveTranscriptRows + shift, maxTranscript);

        TerminalRow[] newLines = new TerminalRow[newTotalRows];
        for (int newRow = -newTranscript; newRow < newRows; newRow++) {
            int oldRow = newRow + shift;
            int index = newRow < 0 ? newTotalRows + newRow : newRow;
            if (oldRow >= -mActiveTranscriptRows && oldRow < mScreenRows) {
                TerminalRow old = allocateFullLineIfNecessary(oldRow);
                if (old.getColumns() == newColumns) {
                    newLines[index] = old;
                } else {
                    TerminalRow copy = new TerminalRow(newColumns, style);
                    copy.copyInterval(old, 0, 0, Math.min(old.getColumns(), newColumns));
                    copy.mLineWrap = old.mLineWrap && old.getColumns() <= newColumns;
                    newLines[index] = copy;
                }
            }
        }
        for (int i = 0; i < newTotalRows; i++) {
            if (newLines[i] == null) newLines[i] = new TerminalRow(newColumns, style);
        }

        mLines = newLines;
        mTotalRows = newTotalRows;
        mScreenRows = newRows;
        mColumns = newColumns;
        mScreenFirstRow = 0;
        mActiveTranscriptRows = newTranscript;
        return shift;
    }

    /**
     * How many lines have scrolled off the top of the screen since this buffer was made
     * (claude-remote): a view scrolled into the history keeps its place by this count.
     */
    public long getScrollCounter() {
        return mScrollCounter;
    }

    private long mScrollCounter = 0;

    // ---- Text selection ----

    /**
     * Extract text within a rectangular selection on the visible screen.
     *
     * @param selX1 start column (inclusive)
     * @param selY1 start row (inclusive)
     * @param selX2 end column (inclusive)
     * @param selY2 end row (inclusive)
     * @return the selected text with newlines between rows
     */
    public String getSelectedText(int selX1, int selY1, int selX2, int selY2) {
        StringBuilder result = new StringBuilder();
        for (int row = selY1; row <= selY2; row++) {
            TerminalRow lineRow = allocateFullLineIfNecessary(row);
            int startCol = (row == selY1) ? selX1 : 0;
            int endCol = (row == selY2) ? selX2 + 1 : mColumns;
            endCol = Math.min(endCol, mColumns);

            // Find the last non-space column to trim trailing whitespace.
            int lastNonSpace = startCol - 1;
            for (int col = startCol; col < endCol; col++) {
                char c = lineRow.getChar(col);
                if (c != ' ' && c != TerminalRow.WIDE_CHAR_PLACEHOLDER) {
                    lastNonSpace = col;
                }
            }

            for (int col = startCol; col <= lastNonSpace; col++) {
                char c = lineRow.getChar(col);
                if (c != TerminalRow.WIDE_CHAR_PLACEHOLDER) {
                    result.append(c);
                }
            }
            if (row < selY2 && !lineRow.mLineWrap) {
                result.append('\n');
            }
        }
        return result.toString();
    }
}
