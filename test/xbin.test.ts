import { describe, expect, test } from 'bun:test';
import { pictureMarkup, readXBin, writeXBin, type Picture } from '../src/xbin.ts';
import { Screen } from '../src/screen.ts';
import { draw } from '../src/text.ts';
import { at } from '../src/assert.ts';

const header = (width: number, height: number, flags: number): number[] => [
    ...[...'XBIN\x1a'].map((c) => c.charCodeAt(0)), width, 0, height, 0, 16, flags,
];

describe('readXBin', () => {
    test('uncompressed cells, CP437 characters and attributes', () => {
        const pic = readXBin(new Uint8Array([...header(3, 1, 0), 0x41, 0x1e, 0xdb, 0x04, 0xb0, 0x8f]));
        expect(pic).toEqual({
            width: 3,
            height: 1,
            cells: [
                { ch: 'A', fg: 14, bg: 1, blink: false },
                { ch: '█', fg: 4, bg: 0, blink: false },
                { ch: '░', fg: 15, bg: 0, blink: true },
            ],
        });
    });

    test('bright backgrounds instead of blink', () => {
        const pic = readXBin(new Uint8Array([...header(1, 1, 8), 0x20, 0xf0]));
        expect(pic.cells).toEqual([{ ch: ' ', fg: 0, bg: 15, blink: false }]);
    });

    test('skips the palette and font, and anything after the cells', () => {
        const palette = new Array<number>(48).fill(9);
        const font = new Array<number>(8 * 256).fill(9);
        const bytes = [...header(1, 1, 3), ...palette, ...font, 0x41, 0x07, ...'SAUCE'.split('').map((c) => c.charCodeAt(0))];
        bytes[9] = 8;
        expect(readXBin(new Uint8Array(bytes)).cells).toEqual([{ ch: 'A', fg: 7, bg: 0, blink: false }]);
    });

    test('compressed runs', () => {
        const pic = readXBin(new Uint8Array([
            ...header(9, 1, 4),
            0x01, 0x41, 0x07, 0x42, 0x07, // two cells as they are
            0x41, 0x43, 0x01, 0x02, // the character repeated
            0x81, 0x1e, 0x44, 0x45, // the attribute repeated
            0xc2, 0x46, 0x0c, // both, three times
        ]));
        expect(pic.cells.map((c) => `${c.ch}${c.fg},${c.bg}`).join(' ')).toBe('A7,0 B7,0 C1,0 C2,0 D14,1 E14,1 F12,0 F12,0 F12,0');
    });

    test('rejects other files and short ones', () => {
        expect(() => readXBin(new TextEncoder().encode('not an xbin'))).toThrow('not an XBin file');
        expect(() => readXBin(new Uint8Array([...header(2, 1, 0), 0x41, 0x07]))).toThrow('ends after 1 of 2 cells');
    });
});

describe('writeXBin', () => {
    test('reads back the same', () => {
        const pic: Picture = {
            width: 2,
            height: 2,
            cells: [
                { ch: '╔', fg: 15, bg: 1, blink: false },
                { ch: '☺', fg: 14, bg: 0, blink: true },
                { ch: '{', fg: 0, bg: 7, blink: false },
                { ch: '■', fg: 2, bg: 4, blink: false },
            ],
        };
        expect(readXBin(writeXBin(pic))).toEqual(pic);
        const bright = { ...pic, cells: pic.cells.map((c) => ({ ...c, bg: c.bg + 8, blink: false })) };
        expect(readXBin(writeXBin(bright))).toEqual(bright);
    });

    test('characters without a CP437 byte become "?"', () => {
        const pic = readXBin(writeXBin({ width: 1, height: 1, cells: [{ ch: 'é́', fg: 7, bg: 0, blink: false }] }));
        expect(pic.cells[0]?.ch).toBe('?');
    });

    test('refuses what XBin can not hold', () => {
        const one = (c: Partial<Picture['cells'][number]>): Picture => ({ width: 1, height: 1, cells: [{ ch: ' ', fg: 7, bg: 0, blink: false, ...c }] });
        expect(() => writeXBin(one({ fg: 208 }))).toThrow("cell 1,1 can't be saved");
        expect(() => writeXBin({ width: 2, height: 1, cells: [...one({ bg: 9 }).cells, ...one({ blink: true }).cells] })).toThrow("cell 2,1 can't be saved");
    });

    test('every CP437 byte has its own character', () => {
        const cells = Array.from({ length: 256 }, () => ({ ch: ' ', fg: 7, bg: 0, blink: false }));
        const bytes = writeXBin({ width: 256, height: 1, cells });
        for (let i = 0; i < 256; i++) {
            bytes[11 + i * 2] = i;
        }
        const chars = readXBin(bytes).cells.map((c) => c.ch);
        expect(new Set(chars).size).toBe(254); // 0, 32 and 255 are all spaces
        expect(readXBin(writeXBin({ width: 256, height: 1, cells: readXBin(bytes).cells })).cells.map((c) => c.ch)).toEqual(chars);
    });
});

describe('pictureMarkup', () => {
    test('draws the picture cell for cell', () => {
        const cells = Array.from({ length: 82 * 26 }, (_, n) => ({
            ch: n % 7 ? '{' : 'x',
            fg: n % 16,
            bg: (n >> 2) % 8,
            blink: n % 5 === 0,
        }));
        const screen = new Screen();
        const lines = pictureMarkup({ width: 82, height: 26, cells });
        expect(lines).toHaveLength(25);
        for (const line of lines) {
            draw(screen, line);
        }
        for (let y = 1; y <= 25; y++) {
            for (let x = 1; x <= 80; x++) {
                expect(screen.cell(x, y)).toEqual(at(cells, (y - 1) * 82 + x - 1));
            }
        }
    });

    test('only changes colour when it needs to', () => {
        const cell = { fg: 14, bg: 1, blink: false };
        expect(pictureMarkup({ width: 3, height: 1, cells: [{ ...cell, ch: 'a' }, { ...cell, ch: 'b' }, { ...cell, ch: 'c', fg: 200 }] }))
            .toEqual(['{y 1}{x 1}{yellow}{on blue}ab{color 200}c']);
    });
});
