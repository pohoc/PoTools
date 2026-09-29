//! Standard-14 font metrics for the PDF builders (`ofd-to-pdf`,
//! `markdown-to-pdf`): the AFM advance widths pdf-lib ships for Helvetica
//! (regular/bold; the oblique faces share them) and Courier (600 everywhere),
//! plus the WinAnsi encoding pdf-lib applies to standard fonts. Measure and
//! encode through [`StdFace`] so text laid out here matches the TS oracle.

/// The standard faces the TS font pick can land on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StdFace {
    Helvetica,
    HelveticaBold,
    HelveticaOblique,
    HelveticaBoldOblique,
    Courier,
}

impl StdFace {
    /// The `/BaseFont` name (pdf-lib standard font name).
    pub(crate) fn base_font(self) -> &'static str {
        match self {
            StdFace::Helvetica => "Helvetica",
            StdFace::HelveticaBold => "Helvetica-Bold",
            StdFace::HelveticaOblique => "Helvetica-Oblique",
            StdFace::HelveticaBoldOblique => "Helvetica-BoldOblique",
            StdFace::Courier => "Courier",
        }
    }

    fn bold(self) -> bool {
        matches!(self, StdFace::HelveticaBold | StdFace::HelveticaBoldOblique)
    }

    /// Advance width in 1000-unit font space, `None` when the face cannot
    /// encode the character (WinAnsi coverage).
    pub(crate) fn width(self, character: char) -> Option<f64> {
        if matches!(self, StdFace::Courier) {
            return (is_latin1(character)
                || WINANSI_SPECIALS
                    .iter()
                    .any(|(c, _, _, _)| *c == character))
            .then_some(600.0);
        }
        let code = character as u32;
        if (0x20..=0x7e).contains(&code) {
            let table: &[u16; 95] = if self.bold() { &BOLD_WIDTHS } else { &REGULAR_WIDTHS };
            return Some(table[code as usize - 32] as f64);
        }
        if (0xa0..=0xff).contains(&code) {
            return Some(self.latin1_width(code as u8));
        }
        let (_, regular, bold, _) = WINANSI_SPECIALS
            .iter()
            .find(|(c, _, _, _)| *c == character)?;
        Some((if self.bold() { *bold } else { *regular }) as f64)
    }

    /// Latin-1 supplement widths. Accented letters share the base glyph's
    /// advance in the standard AFMs; the specials carry their own values.
    fn latin1_width(self, byte: u8) -> f64 {
        let base = match byte {
            // À Å → A, ß handled below, à ã → a, è ë → e, ì ï → i, ò õ → o,
            // ù ü → u, ý/ÿ → y, ç → c, ñ → n, ð → d, æ/Æ → AE, ø/Ø → O, þ/Þ → T(horn)
            0xc0..=0xc5 => 'A',
            0xc7 => 'C',
            0xc8..=0xcb => 'E',
            0xcc..=0xcf => 'I',
            0xd1 => 'N',
            0xd2..=0xd6 => 'O',
            0xd8 => 'O',
            0xd9..=0xdc => 'U',
            0xdd => 'Y',
            0xdf => 'S', // germandbls
            0xe0..=0xe5 => 'a',
            0xe7 => 'c',
            0xe8..=0xeb => 'e',
            0xec..=0xef => 'i',
            0xf1 => 'n',
            0xf2..=0xf6 => 'o',
            0xf8 => 'o',
            0xf9..=0xfc => 'u',
            0xfd => 'y',
            0xff => 'y',
            _ => '\0',
        };
        if base != '\0' {
            return self.ascii_width(base);
        }
        let width: f64 = match byte {
            0xa0 => 278.0,        // nbsp
            0xa1 => 333.0,        // exclamdown
            0xa2..=0xa6 => 556.0, // cent currency sterling yen brokenbar(260/280)
            0xa7 => 556.0,        // section
            0xa8 => 278.0,        // dieresis
            0xa9 => 737.0,        // copyright
            0xaa => 370.0,        // ordfeminine
            0xab => 556.0,        // guillemotleft
            0xac => 584.0,        // logicalnot
            0xad => 333.0,        // softhyphen
            0xae => 737.0,        // registered
            0xaf => 556.0,        // macron
            0xb0 => 400.0,        // degree
            0xb1 => 584.0,        // plusminus
            0xb2 | 0xb3 => 333.0, // twosuperior threesuperior
            0xb4 => 278.0,        // acute
            0xb5 => 556.0,        // mu
            0xb6 => 537.0,        // paragraph
            0xb7 => 278.0,        // periodcentered
            0xb8 => 278.0,        // cedilla
            0xb9 => 333.0,        // onesuperior
            0xba => 365.0,        // ordmasculine
            0xbb => 556.0,        // guillemotright
            0xbc..=0xbe => 834.0, // onequarter onehalf threequarters
            0xbf => 611.0,        // questiondown
            0xc6 => 1000.0,       // AE
            0xd7 => 584.0,        // multiply
            0xe6 => 889.0,        // ae
            0xf7 => 584.0,        // divide
            _ => self.ascii_width('y'), // ydieresis (0xff handled by base above)
        };
        let _ = self.bold();
        width
    }

    fn ascii_width(self, character: char) -> f64 {
        let code = character as usize;
        if !(0x20..=0x7e).contains(&code) {
            return 500.0;
        }
        let table: &[u16; 95] = if self.bold() { &BOLD_WIDTHS } else { &REGULAR_WIDTHS };
        table[code - 32] as f64
    }

    /// WinAnsi byte for the character, `None` when unencodable.
    pub(crate) fn encode(self, character: char) -> Option<u8> {
        let code = character as u32;
        if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
            return Some(code as u8);
        }
        WINANSI_SPECIALS
            .iter()
            .find(|(c, _, _, _)| *c == character)
            .map(|(_, _, _, byte)| *byte)
    }

    /// Whether every character can be drawn with the face (the
    /// `helvetica.encodeText` capability check in the TS oracles).
    pub(crate) fn can_encode(self, text: &str) -> bool {
        text.chars().all(|character| self.encode(character).is_some())
    }
}

fn is_latin1(character: char) -> bool {
    let code = character as u32;
    (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code)
}

/// Helvetica regular AFM widths for code points 0x20..=0x7e.
#[rustfmt::skip]
const REGULAR_WIDTHS: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Helvetica-Bold AFM widths for code points 0x20..=0x7e.
#[rustfmt::skip]
const BOLD_WIDTHS: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/// WinAnsi 0x80..0x9f specials: `(character, Helvetica width, Helvetica-Bold
/// width, WinAnsi byte)`. Shared by `encode` and `width`.
#[rustfmt::skip]
const WINANSI_SPECIALS: [(char, u16, u16, u8); 27] = [
    ('\u{20ac}', 556, 556, 0x80), // € Euro
    ('\u{201a}', 222, 238, 0x82), // ‚ quotesingle
    ('\u{0192}', 556, 556, 0x83), // ƒ florin
    ('\u{201e}', 333, 500, 0x84), // „ quotedblbase
    ('\u{2026}', 1000, 1000, 0x85), // … ellipsis
    ('\u{2020}', 556, 556, 0x86), // † dagger
    ('\u{2021}', 556, 556, 0x87), // ‡ daggerdbl
    ('\u{02c6}', 333, 333, 0x88), // ˆ circumflex
    ('\u{2030}', 1000, 1000, 0x89), // ‰ perthousand
    ('\u{0160}', 667, 667, 0x8a), // Š Scaron
    ('\u{2039}', 222, 333, 0x8b), // ‹ guilsinglleft
    ('\u{0152}', 1000, 1000, 0x8c), // Œ OE
    ('\u{017d}', 611, 611, 0x8e), // Ž Zcaron
    ('\u{2018}', 222, 238, 0x91), // ' quoteleft
    ('\u{2019}', 222, 238, 0x92), // ' quoteright
    ('\u{201c}', 333, 500, 0x93), // " quotedblleft
    ('\u{201d}', 333, 500, 0x94), // " quotedblright
    ('\u{2022}', 350, 350, 0x95), // • bullet
    ('\u{2013}', 556, 556, 0x96), // – endash
    ('\u{2014}', 1000, 1000, 0x97), // — emdash
    ('\u{02dc}', 333, 333, 0x98), // ˜ tilde
    ('\u{2122}', 1000, 1000, 0x99), // ™ trademark
    ('\u{0161}', 500, 556, 0x9a), // š scaron
    ('\u{203a}', 222, 333, 0x9b), // › guilsinglright
    ('\u{0153}', 1000, 1000, 0x9c), // œ oe
    ('\u{017e}', 500, 556, 0x9e), // ž zcaron
    ('\u{0178}', 667, 667, 0x9f), // Ÿ Ydieresis
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_match_afm_samples() {
        assert_eq!(StdFace::Helvetica.width('A'), Some(667.0));
        assert_eq!(StdFace::Helvetica.width('a'), Some(556.0));
        assert_eq!(StdFace::Helvetica.width(' '), Some(278.0));
        assert_eq!(StdFace::HelveticaBold.width('A'), Some(722.0));
        assert_eq!(StdFace::HelveticaBold.width('f'), Some(333.0));
        assert_eq!(StdFace::HelveticaOblique.width('A'), Some(667.0));
        assert_eq!(StdFace::Courier.width('i'), Some(600.0));
        // WinAnsi specials: bold faces take their own AFM column.
        assert_eq!(StdFace::Helvetica.width('\u{201c}'), Some(333.0));
        assert_eq!(StdFace::HelveticaBold.width('\u{2014}'), Some(1000.0));
        // À shares the base A advance; Æ and © carry their own.
        assert_eq!(StdFace::Helvetica.width('\u{c0}'), Some(667.0));
        assert_eq!(StdFace::Helvetica.width('\u{c6}'), Some(1000.0));
        assert_eq!(StdFace::Helvetica.width('\u{a9}'), Some(737.0));
        assert_eq!(StdFace::Helvetica.width('\u{ff}'), Some(500.0));
        assert_eq!(StdFace::Helvetica.width('\u{2014}'), Some(1000.0));
        assert_eq!(StdFace::HelveticaBold.width('\u{201c}'), Some(500.0));
    }

    #[test]
    fn encoding_covers_latin1_and_winansi_specials() {
        assert_eq!(StdFace::Helvetica.encode('A'), Some(0x41));
        assert_eq!(StdFace::Helvetica.encode('\u{e9}'), Some(0xe9));
        assert_eq!(StdFace::Helvetica.encode('\u{2019}'), Some(0x92));
        assert_eq!(StdFace::Helvetica.encode('中'), None);
        assert!(StdFace::Helvetica.can_encode("don’t — ok"));
        assert!(!StdFace::Helvetica.can_encode("don’t 中文"));
    }
}
