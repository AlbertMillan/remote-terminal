/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink.
 */
package com.termux.terminal;

/**
 * Maps Android {@code KeyEvent} key codes (with modifier state) to the
 * corresponding terminal escape sequences.
 * <p>
 * The behaviour depends on terminal modes such as application cursor keys
 * (DECCKM, {@code ?1h}) and application keypad (DECKPAM, {@code =}).
 */
public final class KeyHandler {

    // Modifier flags (matching Android KeyEvent.META_* but simpler).
    public static final int KEYMOD_SHIFT = 1;
    public static final int KEYMOD_ALT   = 2;
    public static final int KEYMOD_CTRL  = 4;

    /**
     * Return the terminal escape sequence for the given Android key code, or
     * {@code null} if this key code is not handled (the caller should fall
     * through to character-based input in that case).
     *
     * @param keyCode    Android {@code KeyEvent.KEYCODE_*} value
     * @param keyMod     bitwise OR of {@code KEYMOD_*} flags
     * @param cursorApp  true if application cursor keys mode is active (DECCKM)
     * @param keypadApp  true if application keypad mode is active (DECKPAM)
     * @return escape sequence string, or null
     */
    public static String getCode(int keyCode, int keyMod, boolean cursorApp, boolean keypadApp) {
        switch (keyCode) {
            // ---- Arrow keys ----
            case 19: // KEYCODE_DPAD_UP
                if (keyMod != 0) return modifiedArrow('A', keyMod);
                return cursorApp ? "\033OA" : "\033[A";
            case 20: // KEYCODE_DPAD_DOWN
                if (keyMod != 0) return modifiedArrow('B', keyMod);
                return cursorApp ? "\033OB" : "\033[B";
            case 21: // KEYCODE_DPAD_LEFT
                if (keyMod != 0) return modifiedArrow('D', keyMod);
                return cursorApp ? "\033OD" : "\033[D";
            case 22: // KEYCODE_DPAD_RIGHT
                if (keyMod != 0) return modifiedArrow('C', keyMod);
                return cursorApp ? "\033OC" : "\033[C";

            // ---- Whitespace / editing ----
            case 61: // KEYCODE_TAB
                if ((keyMod & KEYMOD_SHIFT) != 0) return "\033[Z"; // backtab
                return "\t";
            case 66: // KEYCODE_ENTER
                return "\r";
            case 67: // KEYCODE_DEL (backspace)
                return "\177";
            case 111: // KEYCODE_ESCAPE
                return "\033";
            case 112: // KEYCODE_FORWARD_DEL
                if (keyMod != 0) return modifiedKey("3", keyMod);
                return "\033[3~";

            // ---- Navigation ----
            case 122: // KEYCODE_HOME
                if (keyMod != 0) return modifiedKey("1", keyMod);
                return cursorApp ? "\033OH" : "\033[H";
            case 123: // KEYCODE_END
                if (keyMod != 0) return modifiedKey("4", keyMod);
                return cursorApp ? "\033OF" : "\033[F";
            case 92:  // KEYCODE_PAGE_UP
                if (keyMod != 0) return modifiedKey("5", keyMod);
                return "\033[5~";
            case 93:  // KEYCODE_PAGE_DOWN
                if (keyMod != 0) return modifiedKey("6", keyMod);
                return "\033[6~";
            case 124: // KEYCODE_INSERT
                return "\033[2~";

            // ---- Function keys F1-F12 ----
            case 131: // F1
                if (keyMod != 0) return modifiedFunctionKey(1, keyMod);
                return "\033OP";
            case 132: // F2
                if (keyMod != 0) return modifiedFunctionKey(2, keyMod);
                return "\033OQ";
            case 133: // F3
                if (keyMod != 0) return modifiedFunctionKey(3, keyMod);
                return "\033OR";
            case 134: // F4
                if (keyMod != 0) return modifiedFunctionKey(4, keyMod);
                return "\033OS";
            case 135: // F5
                if (keyMod != 0) return modifiedFunctionKey(5, keyMod);
                return "\033[15~";
            case 136: // F6
                if (keyMod != 0) return modifiedFunctionKey(6, keyMod);
                return "\033[17~";
            case 137: // F7
                if (keyMod != 0) return modifiedFunctionKey(7, keyMod);
                return "\033[18~";
            case 138: // F8
                if (keyMod != 0) return modifiedFunctionKey(8, keyMod);
                return "\033[19~";
            case 139: // F9
                if (keyMod != 0) return modifiedFunctionKey(9, keyMod);
                return "\033[20~";
            case 140: // F10
                if (keyMod != 0) return modifiedFunctionKey(10, keyMod);
                return "\033[21~";
            case 141: // F11
                if (keyMod != 0) return modifiedFunctionKey(11, keyMod);
                return "\033[23~";
            case 142: // F12
                if (keyMod != 0) return modifiedFunctionKey(12, keyMod);
                return "\033[24~";

            // ---- Keypad (application mode) ----
            case 144: // KEYCODE_NUMPAD_0
                return keypadApp ? "\033Op" : "0";
            case 145: // KEYCODE_NUMPAD_1
                return keypadApp ? "\033Oq" : "1";
            case 146: // KEYCODE_NUMPAD_2
                return keypadApp ? "\033Or" : "2";
            case 147: // KEYCODE_NUMPAD_3
                return keypadApp ? "\033Os" : "3";
            case 148: // KEYCODE_NUMPAD_4
                return keypadApp ? "\033Ot" : "4";
            case 149: // KEYCODE_NUMPAD_5
                return keypadApp ? "\033Ou" : "5";
            case 150: // KEYCODE_NUMPAD_6
                return keypadApp ? "\033Ov" : "6";
            case 151: // KEYCODE_NUMPAD_7
                return keypadApp ? "\033Ow" : "7";
            case 152: // KEYCODE_NUMPAD_8
                return keypadApp ? "\033Ox" : "8";
            case 153: // KEYCODE_NUMPAD_9
                return keypadApp ? "\033Oy" : "9";
            case 154: // KEYCODE_NUMPAD_DIVIDE
                return keypadApp ? "\033Oo" : "/";
            case 155: // KEYCODE_NUMPAD_MULTIPLY
                return keypadApp ? "\033Oj" : "*";
            case 156: // KEYCODE_NUMPAD_SUBTRACT
                return keypadApp ? "\033Om" : "-";
            case 157: // KEYCODE_NUMPAD_ADD
                return keypadApp ? "\033Ok" : "+";
            case 158: // KEYCODE_NUMPAD_DOT
                return keypadApp ? "\033On" : ".";
            case 160: // KEYCODE_NUMPAD_ENTER
                return keypadApp ? "\033OM" : "\r";

            default:
                return null;
        }
    }

    /**
     * Build an xterm-style modified cursor key sequence.
     * Format: ESC [ 1 ; {modifier} {letter}
     * where modifier = 1 + bitmask (shift=1, alt=2, ctrl=4).
     */
    private static String modifiedArrow(char letter, int keyMod) {
        int mod = 1 + keyMod;
        return "\033[1;" + mod + letter;
    }

    /**
     * Build an xterm-style modified key sequence.
     * Format: ESC [ {param} ; {modifier} ~
     */
    private static String modifiedKey(String param, int keyMod) {
        int mod = 1 + keyMod;
        return "\033[" + param + ";" + mod + "~";
    }

    /**
     * Build a modified function key sequence.
     */
    private static String modifiedFunctionKey(int fkey, int keyMod) {
        int mod = 1 + keyMod;
        // F1-F4 use SS3 style, F5+ use CSI style
        String param;
        switch (fkey) {
            case 1:  return "\033[1;" + mod + "P";
            case 2:  return "\033[1;" + mod + "Q";
            case 3:  return "\033[1;" + mod + "R";
            case 4:  return "\033[1;" + mod + "S";
            case 5:  param = "15"; break;
            case 6:  param = "17"; break;
            case 7:  param = "18"; break;
            case 8:  param = "19"; break;
            case 9:  param = "20"; break;
            case 10: param = "21"; break;
            case 11: param = "23"; break;
            case 12: param = "24"; break;
            default: return null;
        }
        return "\033[" + param + ";" + mod + "~";
    }

    private KeyHandler() {
        // Non-instantiable utility class.
    }
}
