import { describe, expect, test } from 'bun:test';
import { crc32 } from 'node:zlib';
import { flatten, layerBox, pictureMarkup, readIcy, tagMarkup, writeIcy, type Icy, type IcyCell, type IcyLayer, type IcyTag } from '../src/icy.ts';
import { Screen } from '../src/screen.ts';
import { draw } from '../src/text.ts';
import { at } from '../src/assert.ts';

const cell = (ch: string, fg: number | null = 7, bg: number | null = 0, blink = false): IcyCell => ({ ch, fg, bg, blink });

const layer = (title: string, rows: (IcyCell | null)[][], more: Partial<IcyLayer> = {}): IcyLayer => ({
    title,
    x: 1,
    y: 1,
    width: rows[0]?.length ?? 0,
    height: rows.length,
    visible: true,
    alpha: false,
    mode: 'normal',
    cells: rows.flat(),
    ...more,
});

const icy = (width: number, height: number, layers: IcyLayer[], tags: IcyTag[] = []): Icy => ({ width, height, background: null, layers, tags });

const tag = (text: string, more: Partial<IcyTag> = {}): IcyTag => ({
    text,
    preview: text,
    x: 1,
    y: 1,
    length: text.length,
    align: 'left',
    fg: 15,
    bg: null,
    blink: false,
    ...more,
});

// ---- Files made record by record

const bytes = (...parts: (number[] | Uint8Array)[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));
const u16 = (n: number): number[] => [n & 0xff, n >> 8];
const u32 = (n: number): number[] => [...u16(n & 0xffff), ...u16(n >>> 16)];
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const string = (s: string): Uint8Array => bytes(u32(text(s).length), text(s));

function chunk(type: string, data: Uint8Array): Uint8Array {
    const body = bytes(text(type), data);
    const out = bytes([0, 0, 0, 0], body, [0, 0, 0, 0]);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    view.setUint32(8 + data.length, crc32(body));
    return out;
}

const record = (keyword: string, data: Uint8Array | number[] = []): Uint8Array =>
    chunk('icYD', bytes([1], u16(keyword.length), text(keyword), u32(data.length), data instanceof Uint8Array ? data : Uint8Array.from(data)));

const header = ({ version = 1, buffer = 1, width = 2, height = 1 } = {}): Uint8Array =>
    record('ICED', bytes(u16(version), [0, 0, 0], u16(buffer), [0, 0], u32(width), u32(height), [8, 16]));

// A visible layer of cells, each [code point, attribute bytes].
const layerRecord = (title: string, width: number, cells: [number, number[]][], flags = 1): Uint8Array =>
    record('LAYER', bytes(string(title), [0, 0, 0, 0, 0], u32(flags), u32(0), u32(0), u32(width), u32(cells.length / width), ...cells.map(([ch, attr]) => bytes(u32(ch), attr))));

const plain = (fg: number, bg: number): number[] => [fg + 1, bg + 1, 0, 0, 0];

const file = (...records: Uint8Array[]): Uint8Array => bytes([137, 80, 78, 71, 13, 10, 26, 10], ...records, record('END'), chunk('IEND', new Uint8Array()));

describe('readIcy', () => {
    test('reads back what writeIcy writes, compressed or not', () => {
        const picture = icy(3, 2, [
            layer('Background', [[cell('A', 14, 1), cell('█', 4, 0), cell('░', 15, 0, true)], [cell(' ', 0, 7), cell('☺', 200, 16), cell('╔', 11, 9)]]),
            layer('Over', [[null, cell('x', 2, null)]], { x: 2, y: 2, alpha: true, mode: 'chars' }),
        ], [tag('@TITLE@', { preview: 'A Game', x: 2, y: 1, length: 6, align: 'center', bg: 1, blink: true })]);
        expect(readIcy(writeIcy(picture))).toEqual(picture);
        expect(readIcy(writeIcy(picture, { compress: false }))).toEqual(picture);
    });

    test('characters outside CP437 make a Unicode document', () => {
        const picture = icy(2, 1, [layer('Background', [[cell('Ж'), cell('█')]])]);
        expect(readIcy(writeIcy(picture)).layers[0]?.cells.map((c) => c?.ch)).toEqual(['Ж', '█']);
    });

    test('CP437 documents keep CP437 bytes, Unicode ones code points', () => {
        const cells: [number, number[]][] = [[219, plain(7, 0)], [0x263a, plain(7, 0)]];
        expect(readIcy(file(header(), layerRecord('L', 2, cells))).layers[0]?.cells.map((c) => c?.ch)).toEqual(['█', '☺']);
        expect(readIcy(file(header({ buffer: 0 }), layerRecord('L', 2, cells))).layers[0]?.cells.map((c) => c?.ch)).toEqual(['Û', '☺']);
    });

    test('every CP437 byte is its own character, and written back the same', () => {
        const cells = Array.from({ length: 256 }, (_, i): [number, number[]] => [i, plain(7, 0)]);
        const chars = readIcy(file(header({ width: 256 }), layerRecord('L', 256, cells))).layers[0]?.cells.map((c) => c?.ch) ?? [];
        expect(new Set(chars).size).toBe(254); // 0, 32 and 255 are all spaces
        const again = icy(256, 1, [layer('L', [chars.map((ch) => cell(ch ?? ''))])]);
        expect(readIcy(writeIcy(again)).layers[0]?.cells.map((c) => c?.ch)).toEqual(chars);
    });

    test('xterm and RGB colours, and empty cells', () => {
        const cells: [number, number[]][] = [[65, [17, 208, 18, 255, 255, 85, 0, 0, 0]], [65, [0, 0, 0, 0, 0x80]]];
        const [rgb, empty] = readIcy(file(header(), layerRecord('L', 2, cells))).layers[0]?.cells ?? [];
        expect(rgb).toEqual({ ch: 'A', fg: 208, bg: 14, blink: false });
        expect(empty).toBeNull();
    });

    test('letters with accents, from the GRAPHEME record', () => {
        const picture = file(header({ version: 6, buffer: 0 }), layerRecord('L', 2, [[0x65, plain(7, 0)], [0x41, plain(7, 0)]]), record('GRAPHEME', bytes([1], text('{"0":{"0":{"text":"é","width":1}}}'))));
        expect(readIcy(picture).layers[0]?.cells.map((c) => c?.ch)).toEqual(['é', 'A']);
    });

    test('a layer in a hidden group is hidden, and group markers are left out', () => {
        const group = (parent: number, id: number): Uint8Array => record('GROUP', bytes([1], u32(parent), u32(0), u32(id), u32(0), [0]));
        const one: [number, number[]][] = [[65, plain(7, 0)]];
        const picture = readIcy(file(
            header({ width: 1 }),
            layerRecord('In', 1, one), group(9, 0),
            layerRecord('Group', 1, one, 0), group(0, 9),
            layerRecord('Out', 1, one), group(0, 0),
        ));
        expect(picture.layers.map((l) => [l.title, l.visible])).toEqual([['In', false], ['Out', true]]);
    });

    test('compressed records, but not images, which are left out', () => {
        const zstd = (keyword: string, data: Uint8Array): Uint8Array => record(keyword, Bun.zstdCompressSync(data));
        const one = bytes(string('L'), [0, 0, 0, 0, 0], u32(1), u32(0), u32(0), u32(1), u32(1), u32(65), plain(7, 0));
        const image = record('SIXEL', bytes(string('Picture'), new Array<number>(40).fill(0)));
        const group = (parent: number, id: number): Uint8Array => zstd('GROUP', bytes([1], u32(parent), u32(0), u32(id), u32(0), [0]));
        const picture = readIcy(file(
            record('ICED', bytes(u16(5), [2, 0, 0], u16(1), [0, 0], u32(1), u32(1), [8, 16])),
            zstd('LAYER', one), group(0, 0),
            image, group(9, 0),
            zstd('LAYER', one), group(0, 9),
        ));
        expect(picture.layers.map((l) => [l.title, l.visible])).toEqual([['L', true]]);
        expect(picture.layers[0]?.cells).toEqual([cell('A')]);
    });

    test('skips what a terminal cannot show', () => {
        const picture = file(header(), record('FONT', [0, 0, 0, 0, 0]), record('SIXEL', bytes(string('Picture'), new Array<number>(40).fill(0))), layerRecord('L', 2, [[65, plain(7, 0)], [66, plain(7, 0)]]), record('LIVETEXT', [1]));
        expect(readIcy(picture).layers).toHaveLength(1);
    });

    test('a screen background', () => {
        const picture = readIcy(file(header(), record('SCREEN', bytes(u16(1), u16(3), u16(4), u32(1)))));
        expect(picture.background).toBe(1);
        expect(flatten(picture).cells).toEqual([{ ch: ' ', fg: 7, bg: 1, blink: false }, { ch: ' ', fg: 7, bg: 1, blink: false }]);
    });

    test('refuses what it cannot read or draw', () => {
        const one: [number, number[]][] = [[65, plain(7, 0)]];
        expect(() => readIcy(text('not a png'))).toThrow('not an .icy file');
        expect(() => readIcy(bytes([137, 80, 78, 71, 13, 10, 26, 10], chunk('zTXt', text('ICED\0\0x')), chunk('IEND', new Uint8Array())))).toThrow('open it and save it again');
        expect(() => readIcy(file(layerRecord('L', 1, one)))).toThrow('no header');
        expect(() => readIcy(file(header({ version: 7 })))).toThrow('version 7');
        expect(() => readIcy(file(header({ buffer: 2 })))).toThrow('only CP437 and Unicode');
        expect(() => readIcy(file(header(), layerRecord('L', 1, one), record('EFFECTS', [1, 0])))).toThrow('layer "L" has effects');
        expect(() => readIcy(file(header(), layerRecord('L', 1, [[65, [19, 40, 1, 0, 0]]])))).toThrow('custom palette');
        expect(() => readIcy(file(header(), record('LAYER', bytes(string('L'), [0, 0, 0, 0, 0], u32(1), u32(0), u32(0), u32(1), u32(2), u32(65), plain(7, 0)))))).toThrow('LAYER is cut short');
        const wide = file(header({ version: 6, buffer: 0 }), layerRecord('L', 2, [[0x754c, plain(7, 0)], [32, plain(7, 0)]]), record('GRAPHEME', bytes([1], text('{"0":{"0":{"text":"界","width":2}}}'))));
        expect(() => readIcy(wide)).toThrow('two cells wide');
    });
});

describe('flatten', () => {
    const ground = layer('Background', [[cell('a', 7, 1), cell('▀', 4, 2), cell('█', 5, 0)]]);

    test('a layer with an alpha channel shows the one below through its empty cells and transparent colours', () => {
        const over = layer('Over', [[null, cell('x', 15, null), cell('y', null, 3)]], { alpha: true });
        expect(flatten(icy(3, 1, [ground, over])).cells).toEqual([
            { ch: 'a', fg: 7, bg: 1, blink: false },
            { ch: 'x', fg: 15, bg: 2, blink: false }, // the bottom half of ▀
            { ch: 'y', fg: 5, bg: 3, blink: false }, // the colour of █
        ]);
    });

    test('a layer without one is solid where nothing is below: its empty cells and transparent colours are black', () => {
        const over = layer('Over', [[null, cell('x', 15, null), cell('y', null, 3)]]);
        expect(flatten(icy(3, 1, [over])).cells).toEqual([
            { ch: ' ', fg: 0, bg: 0, blink: false },
            { ch: 'x', fg: 15, bg: 0, blink: false },
            { ch: 'y', fg: 0, bg: 3, blink: false },
        ]);
        expect(flatten(icy(3, 1, [ground, over])).cells[0]).toEqual({ ch: 'a', fg: 7, bg: 1, blink: false });
    });

    test('with nothing below, empty cells and blank ones with no background are left empty', () => {
        const only = layer('Only', [[null, cell(' ', 7, null), cell('x', null, null), cell(' ', 7, 4)]], { alpha: true });
        expect(flatten(icy(4, 1, [only])).cells).toEqual([null, null, { ch: 'x', fg: 0, bg: null, blink: false }, { ch: ' ', fg: 7, bg: 4, blink: false }]);
    });

    test('character and colour layers change only those', () => {
        const chars = layer('Chars', [[cell('z', 9, 9), cell('q', 1, 2), null]], { mode: 'chars' });
        const colours = layer('Colours', [[null, null, cell('?', 12, 6, true)]], { mode: 'attributes' });
        expect(flatten(icy(3, 1, [ground, chars, colours])).cells).toEqual([
            { ch: 'a', fg: 7, bg: 1, blink: false }, // z on z is blank
            { ch: 'q', fg: 4, bg: 2, blink: false },
            { ch: '█', fg: 12, bg: 6, blink: true },
        ]);
    });

    test('hidden layers and what lies outside a layer are not drawn', () => {
        const hidden = layer('Hidden', [[cell('h')]], { visible: false });
        const moved = layer('Moved', [[cell('m', 2, 3)]], { x: 3, y: 1 });
        expect(flatten(icy(3, 1, [ground, hidden, moved])).cells.map((c) => c?.ch)).toEqual(['a', '▀', 'm']);
    });

    test('draws through markup, leaving empty cells and the background alone', () => {
        const screen = new Screen();
        screen.put(1, 1, '1', 2, 3);
        screen.put(2, 1, '2', 2, 3);
        screen.put(3, 1, '3', 2, 3);
        const over = layer('Over', [[null, cell('x', 14, null), cell('y', 14, 1)]], { alpha: true });
        for (const line of pictureMarkup(flatten(icy(3, 1, [over])))) {
            draw(screen, line);
        }
        expect([1, 2, 3].map((x) => screen.cell(x, 1))).toEqual([
            { ch: '1', fg: 2, bg: 3, blink: false },
            { ch: 'x', fg: 14, bg: 3, blink: false },
            { ch: 'y', fg: 14, bg: 1, blink: false },
        ]);
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
        const paint = { fg: 14, bg: 1, blink: false };
        expect(pictureMarkup({ width: 3, height: 1, cells: [{ ...paint, ch: 'a' }, { ...paint, ch: 'b' }, { ...paint, ch: 'c', fg: 200 }] }))
            .toEqual(['{y 1}{x 1}{yellow}{on blue}ab{color 200}c']);
    });
});

describe('layerBox', () => {
    test('the box around a layer\'s cells', () => {
        const picture = icy(10, 10, [layer('Menu', [[null, null, null], [null, cell(' '), cell(' ')], [null, cell(' '), null]], { x: 4, y: 5 })]);
        expect(layerBox(picture, 'Menu')).toEqual({ x: 5, y: 6, width: 2, height: 2 });
        expect(layerBox(picture, 'Nothing')).toBeNull();
        expect(layerBox(icy(1, 1, [layer('Empty', [[null]])]), 'Empty')).toBeNull();
    });
});

describe('tagMarkup', () => {
    const values = { TITLE: 'Quest', VERSION: 'V1' };

    test('fills in each @NAME@ and lines the text up in the tag', () => {
        const picture = icy(80, 25, [], [
            tag('@TITLE@ @VERSION@', { x: 5, y: 2, length: 20 }),
            tag('@TITLE@', { x: 5, y: 3, length: 20, align: 'right', bg: 1 }),
            tag('@VERSION@!', { x: 5, y: 4, length: 20, align: 'center', blink: true, fg: 4 }),
        ]);
        expect(tagMarkup(picture, values)).toEqual([
            '{y 2}{x 5}{color 15}Quest V1',
            '{y 3}{x 20}{color 15}{on 1}Quest',
            '{y 4}{x 14}{blink 4}V1!',
        ]);
    });

    test('centres as {center} does in a tag across the screen', () => {
        for (const value of ['ab', 'abc']) {
            const a = new Screen();
            const b = new Screen();
            draw(a, `{y 1}{center}${value}`);
            for (const line of tagMarkup(icy(80, 1, [], [tag('@V@', { length: 80, align: 'center' })]), { V: value })) {
                draw(b, line);
            }
            expect(b.dump()).toBe(a.dump());
        }
    });

    test('cuts what is too long, and keeps braces as they are', () => {
        expect(tagMarkup(icy(80, 25, [], [tag('{@TITLE@}', { length: 4 })]), values)).toEqual(['{y 1}{x 1}{color 15}{{Que']);
    });

    test('a name with no value is an error', () => {
        expect(() => tagMarkup(icy(80, 25, [], [tag('@NAME@')]), values)).toThrow('no value for @NAME@');
    });
});
