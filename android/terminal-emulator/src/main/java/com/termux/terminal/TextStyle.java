/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink.
 */
package com.termux.terminal;

/**
 * Packs character attributes (bold, italic, underline, etc.) together with
 * foreground and background color indices into a single {@code long} value.
 *
 * <p>Layout (low to high bits):
 * <pre>
 *   Bits  0-7  : effect flags (bold, italic, underline, blink, inverse, invisible, strikethrough, dim)
 *   Bits  8-16 : foreground color index (0 = default, 1-256 = palette index + 1)
 *   Bits 17-25 : background color index (same encoding)
 * </pre>
 */
public final class TextStyle {

    public static final int CHARACTER_ATTRIBUTE_BOLD          = 1;
    public static final int CHARACTER_ATTRIBUTE_ITALIC        = 1 << 1;
    public static final int CHARACTER_ATTRIBUTE_UNDERLINE     = 1 << 2;
    public static final int CHARACTER_ATTRIBUTE_BLINK         = 1 << 3;
    public static final int CHARACTER_ATTRIBUTE_INVERSE       = 1 << 4;
    public static final int CHARACTER_ATTRIBUTE_INVISIBLE     = 1 << 5;
    public static final int CHARACTER_ATTRIBUTE_STRIKETHROUGH = 1 << 6;
    public static final int CHARACTER_ATTRIBUTE_DIM           = 1 << 7;

    /**
     * Encode foreground color, background color, and effect flags into a
     * single style value.
     *
     * @param foreColor foreground color index (0 = default)
     * @param backColor background color index (0 = default)
     * @param effect    bitwise OR of CHARACTER_ATTRIBUTE_* flags
     * @return packed style value
     */
    public static long encode(int foreColor, int backColor, int effect) {
        return ((long) effect) | (((long) foreColor) << 8) | (((long) backColor) << 17);
    }

    /** Extract the foreground color index from a packed style. */
    public static int decodeForeColor(long style) {
        return (int) ((style >> 8) & 0x1ff);
    }

    /** Extract the background color index from a packed style. */
    public static int decodeBackColor(long style) {
        return (int) ((style >> 17) & 0x1ff);
    }

    /** Extract the effect flags from a packed style. */
    public static int decodeEffect(long style) {
        return (int) (style & 0xff);
    }

    private TextStyle() {
        // Non-instantiable utility class.
    }
}
