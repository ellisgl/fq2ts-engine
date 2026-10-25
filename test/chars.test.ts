import { describe, expect, test } from 'bun:test';
import { REPLACEMENT, cellCount, cells, codePointWidth, fitsCell, graphemes } from '../src/chars.ts';

describe('fitsCell', () => {
    test.each([
        'a', '~', 'é', 'é', 'ñ', 'ж', 'λ', 'Ω', '€', '½',
        '♠', '☺', '☃', '♨', '█', '░', '╬', '─', '■', '◆', '←', '∩', '≡', '⌂',
    ])('%p fits', (ch) => {
        expect(fitsCell(ch)).toBe(true);
    });

    test.each([
        ['😀', 'an emoji'],
        ['☺️', 'a symbol in emoji style'],
        ['⚡', 'a symbol shown as emoji by default'],
        ['中', 'CJK'],
        ['한', 'Hangul'],
        ['Ａ', 'fullwidth'],
        ['‍', 'a joiner'],
        ['​', 'a zero-width space'],
        ['\t', 'a control'],
        ['́', 'a lone accent'],
        ['ab', 'two characters'],
        ['', 'nothing'],
        ['👍🏽', 'an emoji with a skin tone'],
    ])('%p does not (%s)', (ch) => {
        expect(fitsCell(ch)).toBe(false);
    });
});

test('answers stay right after the cache of answers fills and is cleared', () => {
    for (let i = 0; i < 5000; i++) {
        fitsCell(`a${'\u0301'.repeat(i % 50)}${String.fromCodePoint(0x300 + (i % 100))}`);
    }
    expect([fitsCell('é'), fitsCell('中'), fitsCell('x')]).toEqual([true, false, true]);
});

test('codePointWidth', () => {
    expect([codePointWidth('a'), codePointWidth('́'), codePointWidth('中'), codePointWidth('😀'), codePointWidth('\x07')]).toEqual([1, 0, 2, 2, 0]);
});

describe('cells, graphemes and cellCount', () => {
    test('plain ASCII', () => {
        expect(cells('Hi!')).toEqual(['H', 'i', '!']);
        expect(graphemes('Hi!')).toEqual(['H', 'i', '!']);
        expect(cellCount('Hi!')).toBe(3);
        expect(cellCount('')).toBe(0);
    });

    test('accents stay with their letter', () => {
        expect(cells('café')).toEqual(['c', 'a', 'f', 'é']);
        expect(cellCount('café')).toBe(4);
    });

    test('what can\'t fill a cell is replaced in cells, kept in graphemes', () => {
        expect(cells('a😀中b')).toEqual(['a', REPLACEMENT, REPLACEMENT, 'b']);
        expect(graphemes('a😀b')).toEqual(['a', '😀', 'b']);
        expect(cellCount('a😀b')).toBe(3);
    });
});
