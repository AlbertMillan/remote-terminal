/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink. Default color scheme: Tokyo Night.
 */
package com.termux.terminal;

/**
 * Indexed color palette for the terminal emulator.
 * <p>
 * Indices 0-7 are standard ANSI colors, 8-15 are bright variants,
 * 16-231 form a 6x6x6 color cube, 232-255 are a 24-step grayscale ramp.
 * Three extra slots hold the default foreground, background, and cursor colors.
 */
public final class TerminalColors {

    /** Index for the default foreground color. */
    public static final int COLOR_INDEX_FOREGROUND = 256;

    /** Index for the default background color. */
    public static final int COLOR_INDEX_BACKGROUND = 257;

    /** Index for the cursor color. */
    public static final int COLOR_INDEX_CURSOR = 258;

    /** Total number of indexed color slots. */
    public static final int NUM_INDEXED_COLORS = 259;

    /** The mutable current color values used by the emulator. */
    public final int[] mCurrentColors = new int[NUM_INDEXED_COLORS];

    /** The immutable default color scheme (Tokyo Night). */
    public static final int[] DEFAULT_COLORSCHEME = new int[NUM_INDEXED_COLORS];

    static {
        // ---- Standard colors (0-7) - Tokyo Night ----
        DEFAULT_COLORSCHEME[0]  = 0xff15161e; // black
        DEFAULT_COLORSCHEME[1]  = 0xfff7768e; // red
        DEFAULT_COLORSCHEME[2]  = 0xff9ece6a; // green
        DEFAULT_COLORSCHEME[3]  = 0xffe0af68; // yellow
        DEFAULT_COLORSCHEME[4]  = 0xff7aa2f7; // blue
        DEFAULT_COLORSCHEME[5]  = 0xffbb9af7; // magenta
        DEFAULT_COLORSCHEME[6]  = 0xff7dcfff; // cyan
        DEFAULT_COLORSCHEME[7]  = 0xffa9b1d6; // white

        // ---- Bright colors (8-15) ----
        DEFAULT_COLORSCHEME[8]  = 0xff414868;
        DEFAULT_COLORSCHEME[9]  = 0xfff7768e;
        DEFAULT_COLORSCHEME[10] = 0xff9ece6a;
        DEFAULT_COLORSCHEME[11] = 0xffe0af68;
        DEFAULT_COLORSCHEME[12] = 0xff7aa2f7;
        DEFAULT_COLORSCHEME[13] = 0xffbb9af7;
        DEFAULT_COLORSCHEME[14] = 0xff7dcfff;
        DEFAULT_COLORSCHEME[15] = 0xffc0caf5;

        // ---- 216 color cube (16-231) ----
        for (int i = 16; i < 232; i++) {
            int j = i - 16;
            int r = j / 36;
            int g = (j / 6) % 6;
            int b = j % 6;
            r = r == 0 ? 0 : 55 + r * 40;
            g = g == 0 ? 0 : 55 + g * 40;
            b = b == 0 ? 0 : 55 + b * 40;
            DEFAULT_COLORSCHEME[i] = 0xff000000 | (r << 16) | (g << 8) | b;
        }

        // ---- 24-step grayscale ramp (232-255) ----
        for (int i = 232; i < 256; i++) {
            int v = 8 + (i - 232) * 10;
            DEFAULT_COLORSCHEME[i] = 0xff000000 | (v << 16) | (v << 8) | v;
        }

        // ---- Special indices ----
        DEFAULT_COLORSCHEME[COLOR_INDEX_FOREGROUND] = 0xffc0caf5;
        DEFAULT_COLORSCHEME[COLOR_INDEX_BACKGROUND] = 0xff16161e;
        DEFAULT_COLORSCHEME[COLOR_INDEX_CURSOR]     = 0xffc0caf5;
    }

    public TerminalColors() {
        reset();
    }

    /** Reset all colors to the default Tokyo Night scheme. */
    public void reset() {
        System.arraycopy(DEFAULT_COLORSCHEME, 0, mCurrentColors, 0, NUM_INDEXED_COLORS);
    }
}
