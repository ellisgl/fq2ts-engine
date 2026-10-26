// What can go in a screen cell.
//
// The game draws a grid of cells, and each holds one character as the
// player sees it: a grapheme (a letter with any accents on it), which must
// take up exactly one terminal column. That allows any Unicode letter,
// symbol or line-drawing character; it leaves out wide characters (emoji,
// CJK, fullwidth forms), which take two columns, and characters that take
// none (controls, joiners, lone accents), which would put the rest of the
// row out of line.

// What's shown in place of anything that can't fill a cell.
export const REPLACEMENT = '?';

// East Asian wide and fullwidth blocks (the emoji are found by their
// Unicode property instead).
const WIDE: readonly (readonly [number, number])[] = [
    [0x1100, 0x115F], [0x2329, 0x232A], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
    [0xA000, 0xA4CF], [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19], [0xFE30, 0xFE6F],
    [0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x1F300, 0x1F64F], [0x1F900, 0x1F9FF], [0x20000, 0x3FFFD],
];

const EMOJI = /\p{Emoji_Presentation}/u;
// Accents and other marks that sit on the character before them.
const MARK = /^\p{M}$/u;
// Controls, formatting characters (joiners...), unassigned code points,
// surrogates and private use.
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Cn}\p{Cs}\p{Co}\p{Zl}\p{Zp}]$/u;
const EMOJI_STYLE = '️';

// How many columns a single code point takes: 0, 1 or 2.
export function codePointWidth(ch: string): number {
    const code = ch.codePointAt(0);
    if (code === undefined || INVISIBLE.test(ch) || MARK.test(ch)) {
        return 0;
    }

    if (EMOJI.test(ch) || WIDE.some(([from, to]) => code >= from && code <= to)) {
        return 2;
    }

    return 1;
}

// Answers already worked out. Kept small: a client can send endless
// different graphemes (any letter with any stack of accents).
const known = new Map<string, boolean>();
const KNOWN_LIMIT = 4096;

// Whether this can go in a cell: one grapheme, one column wide.
export function fitsCell(grapheme: string): boolean {
    let fits = known.get(grapheme);
    if (fits === undefined) {
        const [base = '', ...marks] = [...grapheme];
        fits = codePointWidth(base) === 1 && marks.every((m) => MARK.test(m) && m !== EMOJI_STYLE);
        if (known.size >= KNOWN_LIMIT) {
            known.clear();
        }

        known.set(grapheme, fits);
    }

    return fits;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Printable ASCII: one character per cell, so there's no need to look for
// graphemes (most text is like this, and it's much quicker).
const PLAIN = /^[\x20-\x7e]*$/;

// Text as the cells it fills: one grapheme each, with anything that can't
// fill a cell replaced.
export function cells(text: string): string[] {
    if (PLAIN.test(text)) {
        return text.split('');
    }

    const out: string[] = [];
    for (const { segment } of segmenter.segment(text)) {
        out.push(fitsCell(segment) ? segment : REPLACEMENT);
    }

    return out;
}

// Text split into graphemes, as they are (whether they fit a cell or not).
export function graphemes(text: string): string[] {
    if (PLAIN.test(text)) {
        return text.split('');
    }

    return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

// How many cells text fills.
export function cellCount(text: string): number {
    if (PLAIN.test(text)) {
        return text.length;
    }

    return Array.from(segmenter.segment(text)).length;
}
