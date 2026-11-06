/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink, then for claude-remote: a view over a remote,
 * WebSocket-backed terminal session. claude-remote changes: renders the active
 * screen (the alternate one included), draws a sub-row pixel offset for smooth
 * scrolling, and draws runs of same-style cells in one call.
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
import com.termux.terminal.WcWidth;

/**
 * Renders a {@link TerminalEmulator}'s buffer contents to an Android {@link Canvas}.
 *
 * <p>Cells are drawn in runs: consecutive cells that share a style and whose glyphs
 * advance by exactly one cell are one {@code drawText} call, which is what keeps a
 * fling at the display's frame rate. A glyph whose advance differs (box drawing or
 * symbols from a fallback font) is drawn on its own at its cell, so a run never
 * drifts out of the grid.</p>
 */
public final class TerminalRenderer {

    private static final char WIDE_PLACEHOLDER = '￿';

    private final int mTextSize;
    private final Typeface mTypeface;
    private final Paint mTextPaint = new Paint();
    private final Paint mBgPaint = new Paint();

    /** Measured width of a single monospace character cell in pixels. */
    private final float mFontWidth;

    /** Total line height (ascent + descent + leading) in pixels, rounded up. */
    private final int mFontLineSpacing;

    /** Negative ascent value (distance from baseline to top of tallest glyph). */
    private final int mFontAscent;

    /** Per BMP char: 0 unknown, 1 advances exactly one cell, 2 does not. */
    private final byte[] mFitsCell = new byte[65536];

    private char[] mRunBuf = new char[256];
    private final char[] mOneChar = new char[2];

    /**
     * @param textSize text size in pixels (not dp)
     * @param typeface a monospace {@link Typeface}
     */
    public TerminalRenderer(int textSize, Typeface typeface) {
        mTextSize = textSize;
        mTypeface = typeface;

        mTextPaint.setTypeface(typeface);
        mTextPaint.setAntiAlias(true);
        mTextPaint.setSubpixelText(true);
        mTextPaint.setTextSize(textSize);

        mFontLineSpacing = (int) Math.ceil(mTextPaint.getFontSpacing());
        mFontAscent = (int) Math.ceil(mTextPaint.ascent());
        mFontWidth = mTextPaint.measureText("X");
    }

    public float getFontWidth() {
        return mFontWidth;
    }

    public int getFontLineSpacing() {
        return mFontLineSpacing;
    }

    public int getFontAscent() {
        return mFontAscent;
    }

    public int getTextSize() {
        return mTextSize;
    }

    public Typeface getTypeface() {
        return mTypeface;
    }

    private boolean fitsCell(char c) {
        if (c < 0x7F) return true;
        byte known = mFitsCell[c];
        if (known == 0) {
            mOneChar[0] = c;
            float w = mTextPaint.measureText(mOneChar, 0, 1);
            known = Math.abs(w - mFontWidth) < 0.01f ? (byte) 1 : (byte) 2;
            mFitsCell[c] = known;
        }
        return known == 1;
    }

    /**
     * Render the terminal's active screen.
     *
     * @param topRow   the buffer row drawn at the top (negative values are scrollback)
     * @param offsetPx how far that row is scrolled up out of view, 0 to one line height
     * @param selY1    selection start row, or -1 for no selection
     */
    public void render(TerminalEmulator emulator, Canvas canvas,
                       int topRow, int offsetPx,
                       int selY1, int selX1, int selY2, int selX2,
                       boolean cursorOn) {

        final TerminalBuffer buffer = emulator.getScreen();
        final TerminalColors colors = emulator.getColors();
        final int columns = emulator.getColumns();
        final int rows = emulator.getRows();

        final int defaultFg = colors.mCurrentColors[TerminalColors.COLOR_INDEX_FOREGROUND];
        final int defaultBg = colors.mCurrentColors[TerminalColors.COLOR_INDEX_BACKGROUND];

        if (mRunBuf.length < columns) mRunBuf = new char[columns];

        // One extra row when scrolled part-way, so the bottom edge is never blank.
        final int drawRows = offsetPx > 0 ? rows + 1 : rows;
        for (int visibleRow = 0; visibleRow < drawRows; visibleRow++) {
            final int bufferRow = topRow + visibleRow;
            if (bufferRow >= rows) break;
            final float rowTop = visibleRow * mFontLineSpacing - offsetPx;
            final float textBaseline = rowTop - mFontAscent;
            final TerminalRow lineRow = buffer.allocateFullLineIfNecessary(bufferRow);

            int col = 0;
            while (col < columns) {
                final long style = lineRow.getStyle(col);
                final boolean selected = isInSelection(bufferRow, col, selY1, selX1, selY2, selX2);
                final int effect = TextStyle.decodeEffect(style);
                int fg = TextStyle.decodeForeColor(style);
                int fgColor = resolveColor(fg, defaultFg, colors);
                int bgColor = resolveColor(TextStyle.decodeBackColor(style), defaultBg, colors);
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0 && fg >= 1 && fg <= 8) {
                    fgColor = colors.mCurrentColors[fg - 1 + 8];
                }
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0) {
                    int tmp = fgColor; fgColor = bgColor; bgColor = tmp;
                }
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_DIM) != 0) fgColor = dimColor(fgColor);
                if ((effect & TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE) != 0) fgColor = bgColor;
                if (selected) {
                    int tmp = fgColor; fgColor = bgColor; bgColor = tmp;
                }

                final char first = lineRow.getChar(col);
                final boolean wide = first != WIDE_PLACEHOLDER && WcWidth.width(first) == 2;
                final boolean single = wide || Character.isSurrogate(first) || !fitsCell(first);

                if (single) {
                    // One cell (two for a wide char), drawn at its own position.
                    final int cells = wide ? 2 : 1;
                    final float x = col * mFontWidth;
                    if (bgColor != defaultBg) fillBg(canvas, x, rowTop, cells, bgColor);
                    if (first != ' ' && first != 0 && first != WIDE_PLACEHOLDER) {
                        int len = 1;
                        mOneChar[0] = first;
                        if (Character.isHighSurrogate(first) && col + 1 < columns) {
                            mOneChar[1] = lineRow.getChar(col + 1);
                            len = 2;
                        }
                        prepareText(fgColor, effect);
                        float w = mTextPaint.measureText(mOneChar, 0, len);
                        float room = cells * mFontWidth;
                        if (w > room) mTextPaint.setTextScaleX(room / w);
                        canvas.drawText(mOneChar, 0, len, x, textBaseline, mTextPaint);
                        mTextPaint.setTextScaleX(1f);
                        resetPaintEffects();
                    }
                    col += cells;
                    continue;
                }

                // A run: same style, same selection state, every glyph one cell wide.
                final int start = col;
                int len = 0;
                boolean anyInk = false;
                while (col < columns) {
                    if (col > start) {
                        if (lineRow.getStyle(col) != style) break;
                        if (isInSelection(bufferRow, col, selY1, selX1, selY2, selX2) != selected) break;
                        char c = lineRow.getChar(col);
                        if (c == WIDE_PLACEHOLDER || WcWidth.width(c) == 2 || Character.isSurrogate(c) || !fitsCell(c)) break;
                    }
                    char c = lineRow.getChar(col);
                    if (c == 0) c = ' ';
                    if (c != ' ') anyInk = true;
                    mRunBuf[len++] = c;
                    col++;
                }
                final float x = start * mFontWidth;
                if (bgColor != defaultBg) fillBg(canvas, x, rowTop, len, bgColor);
                if (anyInk) {
                    prepareText(fgColor, effect);
                    canvas.drawText(mRunBuf, 0, len, x, textBaseline, mTextPaint);
                    resetPaintEffects();
                }
            }
        }

        // The cursor, only on the live screen rows in view.
        final int cursorRow = emulator.getCursorRow();
        if (cursorOn && emulator.isCursorVisible() && cursorRow >= topRow && cursorRow < topRow + drawRows) {
            final float x = emulator.getCursorCol() * mFontWidth;
            final float y = (cursorRow - topRow) * mFontLineSpacing - offsetPx;
            mBgPaint.setColor(colors.mCurrentColors[TerminalColors.COLOR_INDEX_CURSOR]);
            mBgPaint.setAlpha(160);
            canvas.drawRect(x, y, x + mFontWidth, y + mFontLineSpacing, mBgPaint);
            mBgPaint.setAlpha(255);
        }
    }

    private void fillBg(Canvas canvas, float x, float top, int cells, int color) {
        mBgPaint.setColor(color);
        canvas.drawRect(x, top, x + cells * mFontWidth, top + mFontLineSpacing, mBgPaint);
    }

    private void prepareText(int color, int effect) {
        mTextPaint.setColor(color);
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0) mTextPaint.setFakeBoldText(true);
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_ITALIC) != 0) mTextPaint.setTextSkewX(-0.25f);
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE) != 0) mTextPaint.setUnderlineText(true);
        if ((effect & TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH) != 0) mTextPaint.setStrikeThruText(true);
    }

    private void resetPaintEffects() {
        mTextPaint.setFakeBoldText(false);
        mTextPaint.setTextSkewX(0f);
        mTextPaint.setUnderlineText(false);
        mTextPaint.setStrikeThruText(false);
    }

    /**
     * Resolve a style's colour (TextStyle: 0 is the default, 1-256 palette index + 1;
     * 24-bit colour arrives mapped to the nearest palette entry).
     */
    private static int resolveColor(int colorIndex, int defaultColor, TerminalColors colors) {
        if (colorIndex <= 0 || colorIndex > 256) return defaultColor;
        return colors.mCurrentColors[colorIndex - 1];
    }

    private static int dimColor(int color) {
        int r = ((color >> 16) & 0xFF) / 2;
        int g = ((color >> 8) & 0xFF) / 2;
        int b = (color & 0xFF) / 2;
        return 0xFF000000 | (r << 16) | (g << 8) | b;
    }

    private static boolean isInSelection(int row, int col, int selY1, int selX1, int selY2, int selX2) {
        if (selY1 < 0) return false;
        if (row < selY1 || row > selY2) return false;
        if (row == selY1 && col < selX1) return false;
        if (row == selY2 && col > selX2) return false;
        return true;
    }
}
