/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink.
 */
package com.termux.terminal;

import java.util.Arrays;

/**
 * A single row of the terminal screen or scrollback buffer.
 * <p>
 * Each column position stores one character (as a {@code char}) and one packed
 * style value (as a {@code long}).  Wide (double-width) characters occupy two
 * columns: the first column holds the actual code point and the second holds
 * a {@link #WIDE_CHAR_PLACEHOLDER} sentinel so the renderer knows the cell is
 * part of the preceding character.
 */
public final class TerminalRow {

    /** Sentinel stored in the second column of a wide character. */
    static final char WIDE_CHAR_PLACEHOLDER = '\uFFFF';

    private static final char EMPTY_CHAR = ' ';

    private final int mColumns;

    /** Character content for each column. */
    char[] mText;

    /** Packed {@link TextStyle} for each column. */
    long[] mStyle;

    /** Whether this line was wrapped (soft newline at the end). */
    boolean mLineWrap = false;

    public TerminalRow(int columns, long style) {
        mColumns = columns;
        mText = new char[columns];
        mStyle = new long[columns];
        clear(style);
    }

    /** Reset every column to a space with the given style. */
    public void clear(long style) {
        Arrays.fill(mText, EMPTY_CHAR);
        Arrays.fill(mStyle, style);
        mLineWrap = false;
    }

    /**
     * Write a code point at the given column with the given style.
     * <p>
     * If the code point is wide (display width 2), the next column is
     * automatically filled with {@link #WIDE_CHAR_PLACEHOLDER}.
     */
    public void setChar(int column, int codePoint, long style) {
        if (column < 0 || column >= mColumns) return;

        // If we are overwriting the second half of a previous wide char,
        // blank out its first half so we don't leave a dangling placeholder.
        if (column > 0 && mText[column] == WIDE_CHAR_PLACEHOLDER) {
            mText[column - 1] = EMPTY_CHAR;
        }

        // If we are overwriting the first half of a wide char, blank the
        // second half placeholder.
        if (column + 1 < mColumns && mText[column + 1] == WIDE_CHAR_PLACEHOLDER) {
            mText[column + 1] = EMPTY_CHAR;
        }

        mText[column] = (char) codePoint;
        mStyle[column] = style;

        int width = WcWidth.width(codePoint);
        if (width == 2 && column + 1 < mColumns) {
            mText[column + 1] = WIDE_CHAR_PLACEHOLDER;
            mStyle[column + 1] = style;
        }
    }

    /** Return the character at the given column. */
    public char getChar(int column) {
        if (column < 0 || column >= mColumns) return EMPTY_CHAR;
        return mText[column];
    }

    /** Return the packed style at the given column. */
    public long getStyle(int column) {
        if (column < 0 || column >= mColumns) return 0;
        return mStyle[column];
    }

    /** Return the number of columns in this row. */
    public int getColumns() {
        return mColumns;
    }

    /**
     * Copy a range of columns from another row into this row.
     *
     * @param srcRow  the source row
     * @param srcCol  first source column (inclusive)
     * @param dstCol  first destination column (inclusive)
     * @param count   number of columns to copy
     */
    public void copyInterval(TerminalRow srcRow, int srcCol, int dstCol, int count) {
        int len = Math.min(count, Math.min(srcRow.mColumns - srcCol, mColumns - dstCol));
        if (len <= 0) return;
        System.arraycopy(srcRow.mText, srcCol, mText, dstCol, len);
        System.arraycopy(srcRow.mStyle, srcCol, mStyle, dstCol, len);
    }
}
