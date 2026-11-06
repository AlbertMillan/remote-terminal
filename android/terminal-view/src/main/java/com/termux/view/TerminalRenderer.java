/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink, then for claude-remote: a view over a remote,
 * WebSocket-backed terminal session.
 */
package com.termux.view;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;

import com.termux.terminal.TerminalBuffer;
import com.termux.terminal.TerminalColors;
import com.termux.terminal.TerminalEmulator;
import com.termux.terminal.TerminalRow;
import com.termux.terminal.TextStyle;

/**
 * Renders a {@link TerminalEmulator}'s buffer contents to an Android {@link Canvas}.
 *
 * <p>Handles monospace font rendering, terminal color resolution, text attributes
 * (bold, italic, underline, strikethrough, dim, inverse, invisible), cursor drawing,
 * text selection highlighting, and wide (CJK) character support.</p>
 */
public final class TerminalRenderer {

    private final int mTextSize;
    private final Typeface mTypeface;
    private final Paint mTextPaint = new Paint();

    /** Measured width of a single monospace character cell in pixels. */
    private final float mFontWidth;

    /** Total line height (ascent + descent + leading) in pixels, rounded up. */
    private final int mFontLineSpacing;

    /** Negative ascent value (distance from baseline to top of tallest glyph). */
    private final int mFontAscent;

    // ---------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------

    /**
     * @param textSize text size in pixels (not dp)
     * @param typeface a monospace {@link Typeface}
     */
    public TerminalRenderer(int textSize, Typeface typeface) {
        mTextSize = textSize;
        mTypeface = typeface;

        mTextPaint.setTypeface(typeface);
        mTextPaint.setAntiAlias(true);
        mTextPaint.setTextSize(textSize);

        mFontLineSpacing = (int) Math.ceil(mTextPaint.getFontSpacing());
        mFontAscent = (int) Math.ceil(mTextPaint.ascent());
        mFontWidth = mTextPaint.measureText("X");
    }

    // ---------------------------------------------------------------------------
    // Accessors
    // ---------------------------------------------------------------------------

    /** Width of a single character cell in pixels. */
    public float getFontWidth() {
        return mFontWidth;
    }

    /** Height of a single row in pixels. */
    public int getFontLineSpacing() {
        return mFontLineSpacing;
    }

    /** Negative ascent (distance above baseline). */
    public int getFontAscent() {
        return mFontAscent;
    }

    /** Text size in pixels that was passed to the constructor. */
    public int getTextSize() {
        return mTextSize;
    }

    /** Typeface that was passed to the constructor. */
    public Typeface getTypeface() {
        return mTypeface;
    }

    // ---------------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------------

    /**
     * Render the terminal buffer to the given canvas.
     *
     * @param emulator the terminal emulator whose buffer to draw
     * @param canvas   the canvas to draw on
     * @param topRow   the first row of the buffer that should appear at the top of the canvas
     *                 (negative values scroll into the scrollback history)
     * @param selY1    selection start row, or -1 for no selection
     * @param selX1    selection start column
     * @param selY2    selection end row
     * @param selX2    selection end column
     */
    public void render(TerminalEmulator emulator, Canvas canvas,
                       int topRow,
                       int selY1, int selX1, int selY2, int selX2) {

        final TerminalBuffer buffer = emulator.mMainBuffer;
        final TerminalColors colors = emulator.getColors();
        final int columns = emulator.getColumns();
        final int rows = emulator.getRows();
        final int cursorRow = emulator.getCursorRow();
        final int cursorCol = emulator.getCursorCol();
        final boolean cursorVisible = emulator.isCursorVisible();

        final int defaultFg = colors.mCurrentColors[TerminalColors.COLOR_INDEX_FOREGROUND];
        final int defaultBg = colors.mCurrentColors[TerminalColors.COLOR_INDEX_BACKGROUND];

        // Temporary buffer for building character strings (avoids allocation per cell).
        final char[] charBuf = new char[2];

        for (int visibleRow = 0; visibleRow < rows; visibleRow++) {
            final int bufferRow = topRow + visibleRow;
            final float rowTop = visibleRow * mFontLineSpacing;
            final float textBaseline = rowTop - mFontAscent;

            final TerminalRow lineRow = buffer.allocateFullLineIfNecessary(bufferRow);

            int col = 0;
            while (col < columns) {
                // --- Decode style --------------------------------------------------
                final long style = lineRow.getStyle(col);
                int fg = TextStyle.decodeForeColor(style);
                int bg = TextStyle.decodeBackColor(style);
                final int effect = TextStyle.decodeEffect(style);

                // Resolve palette / default colours
                int fgColor = resolveColor(fg, defaultFg, colors);
                int bgColor = resolveColor(bg, defaultBg, colors);

                // --- Apply effects -------------------------------------------------

                // Bold may brighten the foreground colour (index 0-7 -> 8-15).
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0 && fg >= 0 && fg < 8) {
                    fgColor = colors.mCurrentColors[fg + 8];
                }

                // Inverse swaps fg and bg.
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0) {
                    int tmp = fgColor;
                    fgColor = bgColor;
                    bgColor = tmp;
                }

                // Dim halves the RGB channels.
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_DIM) != 0) {
                    fgColor = dimColor(fgColor);
                }

                // Invisible hides the foreground by matching it to the background.
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE) != 0) {
                    fgColor = bgColor;
                }

                // --- Selection highlighting ----------------------------------------
                final boolean inSelection = isInSelection(bufferRow, col, selY1, selX1, selY2, selX2);
                if (inSelection) {
                    int tmp = fgColor;
                    fgColor = bgColor;
                    bgColor = tmp;
                }

                // --- Determine character width (wide chars occupy 2 columns) ------
                final char c = lineRow.getChar(col);
                final boolean isWide = isWideCharacter(c);
                final int charCols = isWide ? 2 : 1;
                final float cellWidth = charCols * mFontWidth;
                final float xPixel = col * mFontWidth;

                // --- Draw background -----------------------------------------------
                if (bgColor != defaultBg || inSelection) {
                    mTextPaint.setColor(bgColor);
                    canvas.drawRect(xPixel, rowTop, xPixel + cellWidth, rowTop + mFontLineSpacing, mTextPaint);
                }

                // --- Draw character ------------------------------------------------
                if (c != ' ' && c != 0) {
                    mTextPaint.setColor(fgColor);
                    applyEffectsToPaint(effect);

                    if (isWide || Character.isHighSurrogate(c)) {
                        // Wide or surrogate pair: draw via String
                        int len = 1;
                        charBuf[0] = c;
                        if (Character.isHighSurrogate(c) && col + 1 < columns) {
                            charBuf[1] = lineRow.getChar(col + 1);
                            len = 2;
                        }
                        canvas.drawText(charBuf, 0, len, xPixel, textBaseline, mTextPaint);
                    } else {
                        charBuf[0] = c;
                        canvas.drawText(charBuf, 0, 1, xPixel, textBaseline, mTextPaint);
                    }

                    resetPaintEffects();
                }

                col += charCols;
            }
        }

        // --- Draw cursor -------------------------------------------------------
        if (cursorVisible && cursorRow >= topRow && cursorRow < topRow + rows) {
            drawCursor(canvas, colors, cursorCol, cursorRow - topRow);
        }
    }

    // ---------------------------------------------------------------------------
    // Cursor
    // ---------------------------------------------------------------------------

    /**
     * Draw a block cursor at the given visible row/column.
     *
     * @param canvas     canvas
     * @param colors     terminal colour palette
     * @param col        column
     * @param visibleRow row relative to the visible area (0-based)
     */
    private void drawCursor(Canvas canvas, TerminalColors colors, int col, int visibleRow) {
        final float x = col * mFontWidth;
        final float y = visibleRow * mFontLineSpacing;

        mTextPaint.setColor(colors.mCurrentColors[TerminalColors.COLOR_INDEX_CURSOR]);
        mTextPaint.setAlpha(160);
        canvas.drawRect(x, y, x + mFontWidth, y + mFontLineSpacing, mTextPaint);
        mTextPaint.setAlpha(255);
    }

    // ---------------------------------------------------------------------------
    // Text effects helper
    // ---------------------------------------------------------------------------

    /** Apply bold / italic / underline / strikethrough to the shared paint. */
    private void applyEffectsToPaint(int effect) {
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0) {
            mTextPaint.setFakeBoldText(true);
        }
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_ITALIC) != 0) {
            mTextPaint.setTextSkewX(-0.25f);
        }
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE) != 0) {
            mTextPaint.setUnderlineText(true);
        }
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH) != 0) {
            mTextPaint.setStrikeThruText(true);
        }
    }

    /** Reset the paint to its default state after drawing a styled character. */
    private void resetPaintEffects() {
        mTextPaint.setFakeBoldText(false);
        mTextPaint.setTextSkewX(0f);
        mTextPaint.setUnderlineText(false);
        mTextPaint.setStrikeThruText(false);
    }

    // ---------------------------------------------------------------------------
    // Colour helpers
    // ---------------------------------------------------------------------------

    /**
     * Resolve a colour index from the style long to an ARGB int.
     *
     * @param colorIndex   decoded colour index from {@link TextStyle}
     * @param defaultColor fallback colour if the index is the "default" sentinel (0)
     * @param colors       the active terminal colour palette
     * @return ARGB colour int
     */
    private static int resolveColor(int colorIndex, int defaultColor, TerminalColors colors) {
        if (colorIndex == 0) {
            return defaultColor;
        }
        if (colorIndex >= 0 && colorIndex < 256) {
            return colors.mCurrentColors[colorIndex];
        }
        // 24-bit direct colour: high byte is 0xFF, remaining 24 bits are RGB.
        return colorIndex | 0xFF000000;
    }

    /**
     * Halve the RGB channels of a colour to produce a "dim" variant.
     *
     * @param color ARGB colour
     * @return dimmed ARGB colour (alpha is preserved as fully opaque)
     */
    private static int dimColor(int color) {
        int r = ((color >> 16) & 0xFF) / 2;
        int g = ((color >> 8) & 0xFF) / 2;
        int b = (color & 0xFF) / 2;
        return 0xFF000000 | (r << 16) | (g << 8) | b;
    }

    // ---------------------------------------------------------------------------
    // Selection helpers
    // ---------------------------------------------------------------------------

    /**
     * Determine whether a given cell is inside the current selection rectangle.
     *
     * @return {@code true} if the cell at ({@code row}, {@code col}) is selected
     */
    private static boolean isInSelection(int row, int col,
                                         int selY1, int selX1,
                                         int selY2, int selX2) {
        if (selY1 < 0) return false;
        if (row < selY1 || row > selY2) return false;
        if (row == selY1 && col < selX1) return false;
        if (row == selY2 && col > selX2) return false;
        return true;
    }

    // ---------------------------------------------------------------------------
    // Wide character detection
    // ---------------------------------------------------------------------------

    /**
     * Return {@code true} if the given code point is a wide (typically CJK)
     * character that occupies two terminal columns.
     *
     * <p>This is a simplified heuristic covering the most common CJK ranges.
     * A production implementation should use a full East Asian Width table.</p>
     */
    private static boolean isWideCharacter(char c) {
        // CJK Unified Ideographs
        if (c >= 0x4E00 && c <= 0x9FFF) return true;
        // CJK Unified Ideographs Extension A
        if (c >= 0x3400 && c <= 0x4DBF) return true;
        // CJK Compatibility Ideographs
        if (c >= 0xF900 && c <= 0xFAFF) return true;
        // Hangul Syllables
        if (c >= 0xAC00 && c <= 0xD7AF) return true;
        // Fullwidth Forms
        if (c >= 0xFF01 && c <= 0xFF60) return true;
        if (c >= 0xFFE0 && c <= 0xFFE6) return true;
        // Katakana / Hiragana / CJK Symbols
        if (c >= 0x2E80 && c <= 0x33FF) return true;
        return false;
    }
}
