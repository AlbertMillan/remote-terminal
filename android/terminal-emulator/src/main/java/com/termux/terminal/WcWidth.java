/*
 * Copyright (C) 2014-2024 Termux Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked for Termlink.
 */
package com.termux.terminal;

/**
 * Determines the display width of a Unicode code point in a monospaced
 * terminal:
 * <ul>
 *   <li>{@code -1} for non-printable control characters</li>
 *   <li>{@code 0} for zero-width characters (combining marks, format chars)</li>
 *   <li>{@code 1} for normal characters</li>
 *   <li>{@code 2} for wide / fullwidth characters (CJK, emoji, etc.)</li>
 * </ul>
 * <p>
 * This is a simplified lookup based on common Unicode ranges.  For a fully
 * spec-compliant implementation, see the original Termux wcwidth tables.
 */
public final class WcWidth {

    /**
     * Return the column width of the given Unicode code point.
     *
     * @param codePoint a Unicode code point
     * @return -1, 0, 1, or 2
     */
    public static int width(int codePoint) {
        // Zero-width special cases
        if (codePoint == 0
                || codePoint == 0x034F                                   // combining grapheme joiner
                || (0x200B <= codePoint && codePoint <= 0x200F)          // ZWSP, ZWNJ, ZWJ, LRM, RLM
                || codePoint == 0x2028                                   // line separator
                || codePoint == 0x2029                                   // paragraph separator
                || (0x202A <= codePoint && codePoint <= 0x202E)          // bidi controls
                || (0x2060 <= codePoint && codePoint <= 0x2063)          // word joiner, invisible chars
                || (0xFFF9 <= codePoint && codePoint <= 0xFFFB)) {       // interlinear annotation
            return 0;
        }

        // C0/C1 control characters (non-printable)
        if (codePoint < 32 || (0x7F <= codePoint && codePoint < 0xA0)) {
            return -1;
        }

        // Soft hyphen
        if (codePoint == 0x00AD) {
            return 1;
        }

        // Combining characters (zero-width)
        if (isCombining(codePoint)) {
            return 0;
        }

        // Wide / fullwidth characters
        if (isWide(codePoint)) {
            return 2;
        }

        return 1;
    }

    /** Check whether the code point is a combining character (zero display width). */
    private static boolean isCombining(int cp) {
        // General combining marks
        return (0x0300 <= cp && cp <= 0x036F)     // Combining Diacritical Marks
            || (0x0483 <= cp && cp <= 0x0489)     // Cyrillic combining marks
            || (0x0591 <= cp && cp <= 0x05BD)     // Hebrew accents
            || (cp == 0x05BF)
            || (0x05C1 <= cp && cp <= 0x05C2)
            || (0x05C4 <= cp && cp <= 0x05C5)
            || (cp == 0x05C7)
            || (0x0610 <= cp && cp <= 0x061A)     // Arabic combining marks
            || (0x064B <= cp && cp <= 0x065F)     // Arabic combining marks
            || (cp == 0x0670)                     // Arabic superscript alef
            || (0x06D6 <= cp && cp <= 0x06DC)     // Arabic small marks
            || (0x06DF <= cp && cp <= 0x06E4)
            || (0x06E7 <= cp && cp <= 0x06E8)
            || (0x06EA <= cp && cp <= 0x06ED)
            || (cp == 0x0711)                     // Syriac
            || (0x0730 <= cp && cp <= 0x074A)     // Syriac combining marks
            || (0x07A6 <= cp && cp <= 0x07B0)     // Thaana
            || (0x0816 <= cp && cp <= 0x0819)     // Samaritan
            || (0x081B <= cp && cp <= 0x0823)
            || (0x0825 <= cp && cp <= 0x0827)
            || (0x0829 <= cp && cp <= 0x082D)
            || (0x0859 <= cp && cp <= 0x085B)     // Mandaic
            || (0x08D3 <= cp && cp <= 0x08E1)     // Arabic extended
            || (0x08E3 <= cp && cp <= 0x0902)
            || (0x093A <= cp && cp <= 0x093A)     // Devanagari
            || (cp == 0x093C)
            || (0x0941 <= cp && cp <= 0x0948)
            || (cp == 0x094D)
            || (0x0951 <= cp && cp <= 0x0957)
            || (0x0962 <= cp && cp <= 0x0963)
            || (0x0981 <= cp && cp <= 0x0981)     // Bengali
            || (cp == 0x09BC)
            || (0x09C1 <= cp && cp <= 0x09C4)
            || (cp == 0x09CD)
            || (0x09E2 <= cp && cp <= 0x09E3)
            || (0x0A01 <= cp && cp <= 0x0A02)     // Gurmukhi
            || (cp == 0x0A3C)
            || (0x0A41 <= cp && cp <= 0x0A42)
            || (0x0A47 <= cp && cp <= 0x0A48)
            || (0x0A4B <= cp && cp <= 0x0A4D)
            || (cp == 0x0A51)
            || (0x0A70 <= cp && cp <= 0x0A71)
            || (cp == 0x0A75)
            || (0x0A81 <= cp && cp <= 0x0A82)     // Gujarati
            || (cp == 0x0ABC)
            || (0x0AC1 <= cp && cp <= 0x0AC5)
            || (0x0AC7 <= cp && cp <= 0x0AC8)
            || (cp == 0x0ACD)
            || (0x0AE2 <= cp && cp <= 0x0AE3)
            || (0x0B01 <= cp && cp <= 0x0B01)     // Oriya
            || (cp == 0x0B3C)
            || (cp == 0x0B3F)
            || (0x0B41 <= cp && cp <= 0x0B44)
            || (cp == 0x0B4D)
            || (cp == 0x0B56)
            || (0x0B62 <= cp && cp <= 0x0B63)
            || (cp == 0x0B82)                     // Tamil
            || (cp == 0x0BC0)
            || (cp == 0x0BCD)
            || (cp == 0x0C00)                     // Telugu
            || (cp == 0x0C3E)
            || (0x0C40 <= cp && cp <= 0x0C40)
            || (0x0C46 <= cp && cp <= 0x0C48)
            || (0x0C4A <= cp && cp <= 0x0C4D)
            || (0x0C55 <= cp && cp <= 0x0C56)
            || (0x0C62 <= cp && cp <= 0x0C63)
            || (cp == 0x0C81)                     // Kannada
            || (cp == 0x0CBC)
            || (cp == 0x0CBF)
            || (cp == 0x0CC6)
            || (0x0CCC <= cp && cp <= 0x0CCD)
            || (0x0CE2 <= cp && cp <= 0x0CE3)
            || (cp == 0x0D01)                     // Malayalam
            || (0x0D41 <= cp && cp <= 0x0D44)
            || (cp == 0x0D4D)
            || (0x0D62 <= cp && cp <= 0x0D63)
            || (cp == 0x0DCA)                     // Sinhala
            || (0x0DD2 <= cp && cp <= 0x0DD4)
            || (cp == 0x0DD6)
            || (cp == 0x0E31)                     // Thai
            || (0x0E34 <= cp && cp <= 0x0E3A)
            || (0x0E47 <= cp && cp <= 0x0E4E)
            || (cp == 0x0EB1)                     // Lao
            || (0x0EB4 <= cp && cp <= 0x0EB9)
            || (0x0EBB <= cp && cp <= 0x0EBC)
            || (0x0EC8 <= cp && cp <= 0x0ECD)
            || (0x0F18 <= cp && cp <= 0x0F19)     // Tibetan
            || (cp == 0x0F35)
            || (cp == 0x0F37)
            || (cp == 0x0F39)
            || (0x0F71 <= cp && cp <= 0x0F7E)
            || (0x0F80 <= cp && cp <= 0x0F84)
            || (0x0F86 <= cp && cp <= 0x0F87)
            || (0x0F8D <= cp && cp <= 0x0F97)
            || (0x0F99 <= cp && cp <= 0x0FBC)
            || (cp == 0x0FC6)
            || (0x102D <= cp && cp <= 0x1030)     // Myanmar
            || (0x1032 <= cp && cp <= 0x1037)
            || (0x1039 <= cp && cp <= 0x103A)
            || (0x103D <= cp && cp <= 0x103E)
            || (0x1058 <= cp && cp <= 0x1059)
            || (0x105E <= cp && cp <= 0x1060)
            || (0x1071 <= cp && cp <= 0x1074)
            || (cp == 0x1082)
            || (0x1085 <= cp && cp <= 0x1086)
            || (cp == 0x108D)
            || (cp == 0x109D)
            || (0x1160 <= cp && cp <= 0x11FF)     // Hangul Jungseong / Jongseong
            || (0x135D <= cp && cp <= 0x135F)     // Ethiopic
            || (0x1712 <= cp && cp <= 0x1714)     // Tagalog
            || (0x1732 <= cp && cp <= 0x1734)     // Hanunoo
            || (0x1752 <= cp && cp <= 0x1753)     // Buhid
            || (0x1772 <= cp && cp <= 0x1773)     // Tagbanwa
            || (0x17B4 <= cp && cp <= 0x17B5)     // Khmer
            || (0x17B7 <= cp && cp <= 0x17BD)
            || (cp == 0x17C6)
            || (0x17C9 <= cp && cp <= 0x17D3)
            || (cp == 0x17DD)
            || (0x180B <= cp && cp <= 0x180D)     // Mongolian
            || (0x1885 <= cp && cp <= 0x1886)
            || (cp == 0x18A9)
            || (0x1920 <= cp && cp <= 0x1922)     // Limbu
            || (0x1927 <= cp && cp <= 0x1928)
            || (cp == 0x1932)
            || (0x1939 <= cp && cp <= 0x193B)
            || (0x1A17 <= cp && cp <= 0x1A18)     // Buginese
            || (cp == 0x1A1B)
            || (cp == 0x1A56)                     // Tai Tham
            || (0x1A58 <= cp && cp <= 0x1A5E)
            || (cp == 0x1A60)
            || (cp == 0x1A62)
            || (0x1A65 <= cp && cp <= 0x1A6C)
            || (0x1A73 <= cp && cp <= 0x1A7C)
            || (cp == 0x1A7F)
            || (0x1AB0 <= cp && cp <= 0x1ABE)     // Combining Diacritical Marks Extended
            || (0x1B00 <= cp && cp <= 0x1B03)     // Balinese
            || (cp == 0x1B34)
            || (0x1B36 <= cp && cp <= 0x1B3A)
            || (cp == 0x1B3C)
            || (cp == 0x1B42)
            || (0x1B6B <= cp && cp <= 0x1B73)
            || (0x1B80 <= cp && cp <= 0x1B81)     // Sundanese
            || (0x1BA2 <= cp && cp <= 0x1BA5)
            || (0x1BA8 <= cp && cp <= 0x1BA9)
            || (0x1BAB <= cp && cp <= 0x1BAD)
            || (cp == 0x1BE6)                     // Batak
            || (0x1BE8 <= cp && cp <= 0x1BE9)
            || (cp == 0x1BED)
            || (0x1BEF <= cp && cp <= 0x1BF1)
            || (0x1C2C <= cp && cp <= 0x1C33)     // Lepcha
            || (0x1C36 <= cp && cp <= 0x1C37)
            || (0x1CD0 <= cp && cp <= 0x1CD2)     // Vedic Extensions
            || (0x1CD4 <= cp && cp <= 0x1CE0)
            || (0x1CE2 <= cp && cp <= 0x1CE8)
            || (cp == 0x1CED)
            || (cp == 0x1CF4)
            || (0x1CF8 <= cp && cp <= 0x1CF9)
            || (0x1DC0 <= cp && cp <= 0x1DF9)     // Combining Diacritical Marks Supplement
            || (0x1DFB <= cp && cp <= 0x1DFF)
            || (0x20D0 <= cp && cp <= 0x20F0)     // Combining Diacritical Marks for Symbols
            || (0x2CEF <= cp && cp <= 0x2CF1)     // Coptic
            || (cp == 0x2D7F)                     // Tifinagh
            || (0x2DE0 <= cp && cp <= 0x2DFF)     // Cyrillic Extended-A
            || (0xA66F <= cp && cp <= 0xA672)     // Cyrillic Extended-B
            || (0xA674 <= cp && cp <= 0xA67D)
            || (0xA69E <= cp && cp <= 0xA69F)
            || (0xA6F0 <= cp && cp <= 0xA6F1)     // Bamum
            || (cp == 0xA802)                     // Syloti Nagri
            || (cp == 0xA806)
            || (cp == 0xA80B)
            || (0xA825 <= cp && cp <= 0xA826)
            || (0xA8C4 <= cp && cp <= 0xA8C5)     // Saurashtra
            || (0xA8E0 <= cp && cp <= 0xA8F1)     // Devanagari Extended
            || (0xA926 <= cp && cp <= 0xA92D)     // Kayah Li
            || (0xA947 <= cp && cp <= 0xA951)     // Rejang
            || (0xA980 <= cp && cp <= 0xA982)     // Javanese
            || (cp == 0xA9B3)
            || (0xA9B6 <= cp && cp <= 0xA9B9)
            || (cp == 0xA9BC)
            || (cp == 0xA9E5)                     // Myanmar Extended-B
            || (0xAA29 <= cp && cp <= 0xAA2E)     // Cham
            || (0xAA31 <= cp && cp <= 0xAA32)
            || (0xAA35 <= cp && cp <= 0xAA36)
            || (cp == 0xAA43)
            || (cp == 0xAA4C)
            || (cp == 0xAA7C)
            || (cp == 0xAAB0)                     // Tai Viet
            || (0xAAB2 <= cp && cp <= 0xAAB4)
            || (0xAAB7 <= cp && cp <= 0xAAB8)
            || (0xAABE <= cp && cp <= 0xAABF)
            || (cp == 0xAAC1)
            || (0xAAEC <= cp && cp <= 0xAAED)     // Meetei Mayek Extensions
            || (cp == 0xAAF6)                     // Meetei Mayek
            || (cp == 0xABE5)                     // Meetei Mayek
            || (cp == 0xABE8)
            || (cp == 0xABED)
            || (cp == 0xFB1E)                     // Hebrew point Judeo-Spanish varika
            || (0xFE00 <= cp && cp <= 0xFE0F)     // Variation Selectors
            || (0xFE20 <= cp && cp <= 0xFE2F)     // Combining Half Marks
            || (0x101FD <= cp && cp <= 0x101FD)   // Phaistos Disc
            || (0x102E0 <= cp && cp <= 0x102E0)   // Coptic Epact Numbers
            || (0x10376 <= cp && cp <= 0x1037A)   // Old Permic
            || (0x10A01 <= cp && cp <= 0x10A03)   // Kharoshthi
            || (0x10A05 <= cp && cp <= 0x10A06)
            || (0x10A0C <= cp && cp <= 0x10A0F)
            || (0x10A38 <= cp && cp <= 0x10A3A)
            || (cp == 0x10A3F)
            || (0x10AE5 <= cp && cp <= 0x10AE6)   // Manichaean
            || (0x10D24 <= cp && cp <= 0x10D27)   // Hanifi Rohingya
            || (0x10F46 <= cp && cp <= 0x10F50)   // Sogdian
            || (cp == 0x11001)                     // Brahmi
            || (0x11038 <= cp && cp <= 0x11046)
            || (0x1107F <= cp && cp <= 0x11081)   // Kaithi
            || (0x110B3 <= cp && cp <= 0x110B6)
            || (0x110B9 <= cp && cp <= 0x110BA)
            || (0x11100 <= cp && cp <= 0x11102)   // Chakma
            || (0x11127 <= cp && cp <= 0x1112B)
            || (0x1112D <= cp && cp <= 0x11134)
            || (cp == 0x11173)                     // Mahajani
            || (0x11180 <= cp && cp <= 0x11181)   // Sharada
            || (0x111B6 <= cp && cp <= 0x111BE)
            || (0x111C9 <= cp && cp <= 0x111CC)
            || (0x1122F <= cp && cp <= 0x11231)   // Khojki
            || (cp == 0x11234)
            || (0x11236 <= cp && cp <= 0x11237)
            || (cp == 0x1123E)
            || (cp == 0x112DF)                     // Khudawadi
            || (0x112E3 <= cp && cp <= 0x112EA)
            || (0x11300 <= cp && cp <= 0x11301)   // Grantha
            || (cp == 0x1133C)
            || (cp == 0x11340)
            || (0x11366 <= cp && cp <= 0x1136C)
            || (0x11370 <= cp && cp <= 0x11374)
            || (0x11438 <= cp && cp <= 0x1143F)   // Newa
            || (0x11442 <= cp && cp <= 0x11444)
            || (cp == 0x11446)
            || (cp == 0x1145E)                     // Modi
            || (0x114B3 <= cp && cp <= 0x114B8)   // Tirhuta
            || (cp == 0x114BA)
            || (0x114BF <= cp && cp <= 0x114C0)
            || (0x114C2 <= cp && cp <= 0x114C3)
            || (0x115B2 <= cp && cp <= 0x115B5)   // Siddham
            || (0x115BC <= cp && cp <= 0x115BD)
            || (0x115BF <= cp && cp <= 0x115C0)
            || (0x115DC <= cp && cp <= 0x115DD)
            || (0x11633 <= cp && cp <= 0x1163A)   // Modi
            || (cp == 0x1163D)
            || (0x1163F <= cp && cp <= 0x11640)
            || (cp == 0x116AB)                     // Takri
            || (cp == 0x116AD)
            || (0x116B0 <= cp && cp <= 0x116B5)
            || (cp == 0x116B7)
            || (0x1171D <= cp && cp <= 0x1171F)   // Ahom
            || (0x11722 <= cp && cp <= 0x11725)
            || (0x11727 <= cp && cp <= 0x1172B)
            || (0x1182F <= cp && cp <= 0x11837)   // Dogra
            || (0x11839 <= cp && cp <= 0x1183A)
            || (0x11A01 <= cp && cp <= 0x11A0A)   // Zanabazar Square
            || (0x11A33 <= cp && cp <= 0x11A38)
            || (0x11A3B <= cp && cp <= 0x11A3E)
            || (cp == 0x11A47)
            || (0x11A51 <= cp && cp <= 0x11A56)   // Soyombo
            || (0x11A59 <= cp && cp <= 0x11A5B)
            || (0x11A8A <= cp && cp <= 0x11A96)
            || (0x11A98 <= cp && cp <= 0x11A99)
            || (0x11C30 <= cp && cp <= 0x11C36)   // Bhaiksuki
            || (0x11C38 <= cp && cp <= 0x11C3D)
            || (cp == 0x11C3F)
            || (0x11C92 <= cp && cp <= 0x11CA7)   // Marchen
            || (0x11CAA <= cp && cp <= 0x11CB0)
            || (0x11CB2 <= cp && cp <= 0x11CB3)
            || (0x11CB5 <= cp && cp <= 0x11CB6)
            || (0x11D31 <= cp && cp <= 0x11D36)   // Masaram Gondi
            || (cp == 0x11D3A)
            || (0x11D3C <= cp && cp <= 0x11D3D)
            || (0x11D3F <= cp && cp <= 0x11D45)
            || (cp == 0x11D47)
            || (0x11D90 <= cp && cp <= 0x11D91)   // Gunjala Gondi
            || (cp == 0x11D95)
            || (cp == 0x11D97)
            || (0x11EF3 <= cp && cp <= 0x11EF4)   // Makasar
            || (0x16AF0 <= cp && cp <= 0x16AF4)   // Bassa Vah
            || (0x16B30 <= cp && cp <= 0x16B36)   // Pahawh Hmong
            || (cp == 0x16F4F)                     // Miao
            || (0x16F8F <= cp && cp <= 0x16F92)
            || (0x1BC9D <= cp && cp <= 0x1BC9E)   // Duployan
            || (0x1D167 <= cp && cp <= 0x1D169)   // Musical Symbols
            || (0x1D17B <= cp && cp <= 0x1D182)
            || (0x1D185 <= cp && cp <= 0x1D18B)
            || (0x1D1AA <= cp && cp <= 0x1D1AD)
            || (0x1D242 <= cp && cp <= 0x1D244)   // Combining Greek Musical Notation
            || (0x1DA00 <= cp && cp <= 0x1DA36)   // Signwriting
            || (0x1DA3B <= cp && cp <= 0x1DA6C)
            || (cp == 0x1DA75)
            || (cp == 0x1DA84)
            || (0x1DA9B <= cp && cp <= 0x1DA9F)
            || (0x1DAA1 <= cp && cp <= 0x1DAAF)
            || (0x1E000 <= cp && cp <= 0x1E006)   // Glagolitic Supplement
            || (0x1E008 <= cp && cp <= 0x1E018)
            || (0x1E01B <= cp && cp <= 0x1E021)
            || (0x1E023 <= cp && cp <= 0x1E024)
            || (0x1E026 <= cp && cp <= 0x1E02A)
            || (0x1E8D0 <= cp && cp <= 0x1E8D6)   // Mende Kikakui
            || (0x1E944 <= cp && cp <= 0x1E94A)   // Adlam
            || (0xE0100 <= cp && cp <= 0xE01EF);  // Variation Selectors Supplement
    }

    /**
     * Check whether the code point is a wide (double-width) character that
     * should occupy two terminal columns.
     */
    private static boolean isWide(int cp) {
        return (0x1100  <= cp && cp <= 0x115F)     // Hangul Jamo
            || (0x231A  <= cp && cp <= 0x231B)     // Watch, Hourglass
            || (cp == 0x2329)                      // Left-pointing angle bracket
            || (cp == 0x232A)                      // Right-pointing angle bracket
            || (0x23E9  <= cp && cp <= 0x23EC)     // Double arrows
            || (cp == 0x23F0)                      // Alarm clock
            || (cp == 0x23F3)                      // Hourglass flowing
            || (0x25FD  <= cp && cp <= 0x25FE)     // Square
            || (0x2614  <= cp && cp <= 0x2615)     // Umbrella, Hot beverage
            || (0x2648  <= cp && cp <= 0x2653)     // Zodiac
            || (cp == 0x267F)                      // Wheelchair
            || (cp == 0x2693)                      // Anchor
            || (cp == 0x26A1)                      // High voltage
            || (0x26AA  <= cp && cp <= 0x26AB)     // Circles
            || (0x26BD  <= cp && cp <= 0x26BE)     // Soccer, Baseball
            || (0x26C4  <= cp && cp <= 0x26C5)     // Snowman, Sun behind cloud
            || (cp == 0x26CE)                      // Ophiuchus
            || (cp == 0x26D4)                      // No entry
            || (cp == 0x26EA)                      // Church
            || (0x26F2  <= cp && cp <= 0x26F3)     // Fountain, Golf
            || (cp == 0x26F5)                      // Sailboat
            || (cp == 0x26FA)                      // Tent
            || (cp == 0x26FD)                      // Fuel pump
            || (cp == 0x2702)                      // Scissors
            || (cp == 0x2705)                      // Check mark
            || (0x2708  <= cp && cp <= 0x270D)     // Airplane through writing hand
            || (cp == 0x270F)                      // Pencil
            || (cp == 0x2712)                      // Black nib
            || (cp == 0x2714)                      // Check mark
            || (cp == 0x2716)                      // X mark
            || (cp == 0x271D)                      // Latin cross
            || (cp == 0x2721)                      // Star of David
            || (cp == 0x2728)                      // Sparkles
            || (0x2733  <= cp && cp <= 0x2734)     // Eight spoked asterisk
            || (cp == 0x2744)                      // Snowflake
            || (cp == 0x2747)                      // Sparkle
            || (cp == 0x274C)                      // Cross mark
            || (cp == 0x274E)                      // Cross mark with outline
            || (0x2753  <= cp && cp <= 0x2755)     // Question marks
            || (cp == 0x2757)                      // Exclamation mark
            || (0x2763  <= cp && cp <= 0x2764)     // Heart exclamation, Heavy heart
            || (0x2795  <= cp && cp <= 0x2797)     // Plus, Minus, Divide
            || (cp == 0x27A1)                      // Right arrow
            || (cp == 0x27B0)                      // Curly loop
            || (cp == 0x27BF)                      // Double curly loop
            || (0x2934  <= cp && cp <= 0x2935)     // Arrows
            || (0x2B05  <= cp && cp <= 0x2B07)     // Arrows
            || (0x2B1B  <= cp && cp <= 0x2B1C)     // Squares
            || (cp == 0x2B50)                      // Star
            || (cp == 0x2B55)                      // Circle
            || (0x2E80  <= cp && cp <= 0x2E99)     // CJK Radicals Supplement
            || (0x2E9B  <= cp && cp <= 0x2EF3)
            || (0x2F00  <= cp && cp <= 0x2FD5)     // Kangxi Radicals
            || (0x2FF0  <= cp && cp <= 0x2FFF)     // Ideographic Description Characters
            || (0x3000  <= cp && cp <= 0x303E)     // CJK Symbols and Punctuation
            || (0x3041  <= cp && cp <= 0x3096)     // Hiragana
            || (0x3099  <= cp && cp <= 0x30FF)     // Hiragana/Katakana
            || (0x3105  <= cp && cp <= 0x312F)     // Bopomofo
            || (0x3131  <= cp && cp <= 0x318E)     // Hangul Compatibility Jamo
            || (0x3190  <= cp && cp <= 0x31BA)     // Kanbun
            || (0x31C0  <= cp && cp <= 0x31E3)     // CJK Strokes
            || (0x31F0  <= cp && cp <= 0x321E)     // Katakana Extension / Enclosed CJK
            || (0x3220  <= cp && cp <= 0x3247)
            || (0x3250  <= cp && cp <= 0x32FE)     // Enclosed CJK Letters
            || (0x3300  <= cp && cp <= 0x33BF)     // CJK Compatibility
            || (0x3400  <= cp && cp <= 0x4DBF)     // CJK Unified Ideographs Extension A
            || (0x4E00  <= cp && cp <= 0x9FFF)     // CJK Unified Ideographs
            || (0xA000  <= cp && cp <= 0xA48C)     // Yi Syllables
            || (0xA490  <= cp && cp <= 0xA4C6)     // Yi Radicals
            || (0xA960  <= cp && cp <= 0xA97C)     // Hangul Jamo Extended-A
            || (0xAC00  <= cp && cp <= 0xD7A3)     // Hangul Syllables
            || (0xF900  <= cp && cp <= 0xFAFF)     // CJK Compatibility Ideographs
            || (0xFE10  <= cp && cp <= 0xFE19)     // Vertical Forms
            || (0xFE30  <= cp && cp <= 0xFE6F)     // CJK Compatibility Forms / Small Form Variants
            || (0xFF01  <= cp && cp <= 0xFF60)     // Fullwidth Forms
            || (0xFFE0  <= cp && cp <= 0xFFE6)     // Fullwidth Signs
            || (0x16FE0 <= cp && cp <= 0x16FE3)   // Ideographic Symbols
            || (0x17000 <= cp && cp <= 0x187F7)   // Tangut
            || (0x18800 <= cp && cp <= 0x18AF2)   // Tangut Components
            || (0x1B000 <= cp && cp <= 0x1B11E)   // Kana Supplement / Extended-A
            || (0x1B150 <= cp && cp <= 0x1B152)   // Small Kana Extension
            || (0x1B164 <= cp && cp <= 0x1B167)
            || (0x1B170 <= cp && cp <= 0x1B2FB)   // Nushu
            || (0x1F000 <= cp && cp <= 0x1F02B)   // Mahjong Tiles
            || (0x1F030 <= cp && cp <= 0x1F093)   // Domino Tiles
            || (0x1F0A0 <= cp && cp <= 0x1F0F5)   // Playing Cards
            || (0x1F100 <= cp && cp <= 0x1F10C)   // Enclosed Alphanumeric Supplement
            || (0x1F110 <= cp && cp <= 0x1F16C)
            || (0x1F170 <= cp && cp <= 0x1F1AC)
            || (0x1F1E0 <= cp && cp <= 0x1F1FF)   // Regional Indicator Symbols (flags)
            || (0x1F200 <= cp && cp <= 0x1F202)   // Enclosed Ideographic Supplement
            || (0x1F210 <= cp && cp <= 0x1F23B)
            || (0x1F240 <= cp && cp <= 0x1F248)
            || (0x1F250 <= cp && cp <= 0x1F251)
            || (0x1F260 <= cp && cp <= 0x1F265)
            || (0x1F300 <= cp && cp <= 0x1F6D5)   // Misc Symbols and Pictographs / Emoticons / Transport
            || (0x1F6E0 <= cp && cp <= 0x1F6EC)
            || (0x1F6F0 <= cp && cp <= 0x1F6FA)
            || (0x1F700 <= cp && cp <= 0x1F773)   // Alchemical Symbols
            || (0x1F780 <= cp && cp <= 0x1F7D8)   // Geometric Shapes Extended
            || (0x1F7E0 <= cp && cp <= 0x1F7EB)
            || (0x1F800 <= cp && cp <= 0x1F80B)   // Supplemental Arrows-C
            || (0x1F810 <= cp && cp <= 0x1F847)
            || (0x1F850 <= cp && cp <= 0x1F859)
            || (0x1F860 <= cp && cp <= 0x1F887)
            || (0x1F890 <= cp && cp <= 0x1F8AD)
            || (0x1F900 <= cp && cp <= 0x1F90B)   // Supplemental Symbols and Pictographs
            || (0x1F90D <= cp && cp <= 0x1F971)
            || (0x1F973 <= cp && cp <= 0x1F976)
            || (0x1F97A <= cp && cp <= 0x1F9A2)
            || (0x1F9A5 <= cp && cp <= 0x1F9AA)
            || (0x1F9AE <= cp && cp <= 0x1F9CA)
            || (0x1F9CD <= cp && cp <= 0x1F9FF)
            || (0x1FA00 <= cp && cp <= 0x1FA53)   // Chess Symbols
            || (0x1FA60 <= cp && cp <= 0x1FA6D)
            || (0x1FA70 <= cp && cp <= 0x1FA73)
            || (0x1FA78 <= cp && cp <= 0x1FA7A)
            || (0x1FA80 <= cp && cp <= 0x1FA82)
            || (0x1FA90 <= cp && cp <= 0x1FA95)
            || (0x20000 <= cp && cp <= 0x2A6D6)   // CJK Unified Ideographs Extension B
            || (0x2A700 <= cp && cp <= 0x2B734)   // Extension C
            || (0x2B740 <= cp && cp <= 0x2B81D)   // Extension D
            || (0x2B820 <= cp && cp <= 0x2CEA1)   // Extension E
            || (0x2CEB0 <= cp && cp <= 0x2EBE0)   // Extension F
            || (0x2F800 <= cp && cp <= 0x2FA1D)   // CJK Compatibility Ideographs Supplement
            || (0x30000 <= cp && cp <= 0x3134A);  // Extension G
    }

    private WcWidth() {
        // Non-instantiable utility class.
    }
}
