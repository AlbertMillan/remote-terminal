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
     * Resize the buffer to new dimensions.  Existing visible content is
     * preserved as much as possible.
     *
     * @param newColumns   new number of columns
     * @param newRows      new visible screen rows
     * @param newTotalRows new total capacity
     * @param style        style for newly created blank cells
     * @param cursorRow    current cursor row (used for content anchoring)
     */
    public void resize(int newColumns, int newRows, int newTotalRows, long style, int cursorRow) {
        TerminalRow[] newLines = new TerminalRow[newTotalRows];
        for (int i = 0; i < newTotalRows; i++) {
            newLines[i] = new TerminalRow(newColumns, style);
        }

        // Determine how many rows of existing content to preserve.
        // Anchor around the cursor: keep rows 0..cursorRow visible.
        int preserveRows = Math.min(cursorRow + 1, Math.min(mScreenRows, newRows));

        for (int i = 0; i < preserveRows; i++) {
            TerminalRow oldRow = allocateFullLineIfNecessary(i);
            int copyCols = Math.min(mColumns, newColumns);
            for (int col = 0; col < copyCols; col++) {
                newLines[i].setChar(col, oldRow.getChar(col), oldRow.getStyle(col));
            }
        }

        mLines = newLines;
        mTotalRows = newTotalRows;
        mScreenRows = newRows;
        mColumns = newColumns;
        mScreenFirstRow = 0;
        mActiveTranscriptRows = 0;
    }

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
