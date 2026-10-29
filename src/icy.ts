// Icy Draw's own files (.icy): screens drawn in layers, with tags marking
// where text from the game goes.
//
// An .icy file is a PNG whose picture is only a preview; the screen itself
// is in "icYD" chunks, each a record (ICED, the header, first; LAYER for
// each layer, bottom first; TAG; END), all but the first and last usually
// zstd-compressed. What a terminal can't show (fonts, palettes, sixel
// images) is skipped, and what the game can't draw (layer effects, custom
// palettes, wide characters) is refused. Written against Icy Draw 0.6's
// reader, whose own spec (doc/icy_spec.md) is out of date.
//
// Positions here are 1-based screen columns and rows, like the rest of the
// engine.

import { deflateSync, crc32 } from 'node:zlib';
import { cellCount, cells as splitCells } from './chars.ts';
import { rgb, COLORS, COLOR_COUNT, DEFAULT_SIZE, type Color, type ScreenSize } from './screen.ts';
import { escapeMarkup } from './text.ts';

// Each CP437 byte as Unicode. 0 and 255 show as spaces.
const CP437: readonly string[] = [
    ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼',
    ...Array.from({ length: 0x5f }, (_, i) => String.fromCharCode(0x20 + i)),
    '⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
].flatMap((s) => [...s]);

// Each character's CP437 byte.
const CP437_BYTE: ReadonlyMap<string, number> = new Map([...CP437.map((ch, i) => [ch, i] as const), [' ', 0x20]]);

// A cell to draw; with no background it keeps the one on screen.
export interface Paint {
    ch:    string;
    fg:    Color;
    bg:    Color | null;
    blink: boolean;
}

// A picture to draw over what's on screen: cells left empty (null) keep
// what's there.
export interface Painting {
    width:  number;
    height: number;
    cells:  readonly (Paint | null)[]; // row by row
}

// The picture as markup, to draw from the top left corner: a line per row,
// or more where a row has cells left empty (null) or with no background.
// Only what fits on the screen (the game's: Config.screen) is kept.
export function pictureMarkup({ width, cells }: Painting, screen: ScreenSize = DEFAULT_SIZE): string[] {
    const name = (c: number): string => COLORS[c] ?? String(c);
    const lines: string[] = [];
    for (let y = 0; y < Math.min(screen.height, cells.length / width); y++) {
        let line = '';
        let last: Paint | null = null;
        const end = (): void => {
            if (line) {
                lines.push(line);
            }
            line = '';
            last = null;
        };
        cells.slice(y * width, y * width + Math.min(width, screen.width)).forEach((c, x) => {
            // (Once a line has a background it can't go back to none.)
            if (!c || (c.bg === null && last?.bg != null)) {
                end();
            }
            if (!c) {
                return;
            }
            if (!line) {
                line = `{y ${y + 1}}{x ${x + 1}}`;
            }
            if (c.fg !== last?.fg || c.blink !== last.blink) {
                line += c.blink ? `{blink ${name(c.fg)}}` : c.fg < 16 ? `{${name(c.fg)}}` : `{color ${c.fg}}`;
            }
            if (c.bg !== null && c.bg !== last?.bg) {
                line += `{on ${name(c.bg)}}`;
            }
            line += escapeMarkup(c.ch);
            last = c;
        });
        end();
    }
    return lines;
}

// A layer's cell; colours are null where transparent.
export interface IcyCell {
    ch:    string;
    fg:    Color | null;
    bg:    Color | null;
    blink: boolean;
}

export interface IcyLayer {
    title:  string;
    x:      number;
    y:      number;
    width:  number;
    height: number;
    // A layer and the groups it's in must all be shown to be drawn.
    visible: boolean;
    // Without an alpha channel, a layer's empty cells and transparent
    // colours are drawn black.
    alpha: boolean;
    // Normal layers draw whole cells; the others only characters (over
    // whatever colours are below) or only colours.
    mode:  'normal' | 'chars' | 'attributes';
    cells: (IcyCell | null)[]; // row by row; null is an empty cell
}

// Where text goes: `text` (the tag's replacement in Icy Draw), with each
// @NAME@ in it filled in, fitted to `length` cells from (x, y).
export interface IcyTag {
    text:   string;
    // What Icy Draw shows in its place, which sets its length.
    preview: string;
    x:      number;
    y:      number;
    length: number;
    align:  'left' | 'center' | 'right';
    fg:     Color;
    bg:     Color | null; // null keeps the background on screen
    blink:  boolean;
}

export interface Icy {
    width:  number;
    height: number;
    // The colour under every layer, if the file sets one.
    background: Color | null;
    layers: IcyLayer[];
    tags:   IcyTag[];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const OLDEST = 1; // the ICED versions read
const NEWEST = 6;
const ZSTD = 2;
const CP437_BUFFER = 1;
const UNICODE_BUFFER = 0;
const VISIBLE = 1;
const HAS_ALPHA = 8;
const BLINK = 0x0008;
const INVISIBLE = 0x8000;
const MODES = ['normal', 'chars', 'attributes'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;

// Reads little-endian numbers and strings from a record, refusing to go
// past its end.
class Reader {
    private at = 0;
    private readonly view: DataView;
    public constructor(private readonly bytes: Uint8Array, private readonly what: string) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    public get done(): boolean {
        return this.at >= this.bytes.length;
    }
    private take(n: number): number {
        if (this.at + n > this.bytes.length) {
            throw new Error(`.icy file: ${this.what} is cut short`);
        }
        this.at += n;
        return this.at - n;
    }
    public u8(): number {
        return this.view.getUint8(this.take(1));
    }
    public u16(): number {
        return this.view.getUint16(this.take(2), true);
    }
    public u32(): number {
        return this.view.getUint32(this.take(4), true);
    }
    public i32(): number {
        return this.view.getInt32(this.take(4), true);
    }
    public skip(n: number): void {
        this.take(n);
    }
    public string(): string {
        const n = this.u32();
        return new TextDecoder().decode(this.bytes.subarray(this.take(n), this.at));
    }
    public rest(): Uint8Array {
        return this.bytes.subarray(this.take(this.bytes.length - this.at));
    }
}

// The nearest of the 256 colours to an RGB one.
function nearest(r: number, g: number, b: number): Color {
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < COLOR_COUNT; c++) {
        const [r2, g2, b2] = rgb(c);
        const distance = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
        if (distance < bestDistance) {
            best = c;
            bestDistance = distance;
        }
    }
    return best;
}

// One tagged colour: transparent, one of the 16, one of xterm's 256, or RGB.
function color(r: Reader): Color | null {
    const tag = r.u8();
    if (tag === 0) {
        return null;
    }
    if (tag <= 16) {
        return tag - 1;
    }
    if (tag === 17) {
        return r.u8();
    }
    if (tag === 18) {
        return nearest(r.u8(), r.u8(), r.u8());
    }
    if (tag === 19) {
        throw new Error('.icy file: colours from a custom palette are not supported (use the standard 16, or xterm\'s 256)');
    }
    throw new Error(`.icy file: unknown colour type ${tag}`);
}

function attribute(r: Reader): { fg: Color | null; bg: Color | null; blink: boolean; invisible: boolean } {
    const fg = color(r);
    const bg = color(r);
    r.skip(1); // font page
    const flags = r.u16();
    return { fg, bg, blink: (flags & BLINK) !== 0, invisible: (flags & INVISIBLE) !== 0 };
}

// The icYD records in a PNG, each as [keyword, data].
function records(bytes: Uint8Array): [string, Uint8Array][] {
    if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
        throw new Error('not an .icy file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const latin1 = new TextDecoder('latin1');
    const found: [string, Uint8Array][] = [];
    let old = false;
    for (let at = 8; at + 8 <= bytes.length;) {
        const length = view.getUint32(at);
        const type = latin1.decode(bytes.subarray(at + 4, at + 8));
        const data = bytes.subarray(at + 8, at + 8 + length);
        if (type === 'icYD') {
            const r = new Reader(data, 'a record');
            if (r.u8() !== 1) {
                throw new Error('.icy file: unknown record version');
            }
            const keywordLength = r.u16();
            const keyword = new TextDecoder().decode(data.subarray(3, 3 + keywordLength));
            r.skip(keywordLength);
            const size = r.u32();
            found.push([keyword, r.rest().subarray(0, size)]);
        }
        old ||= type === 'zTXt' || type === 'tEXt';
        if (type === 'IEND') {
            break;
        }
        at += 12 + length;
    }
    if (!found.length && old) {
        throw new Error('.icy file from an old Icy Draw: open it and save it again');
    }
    return found;
}

export function readIcy(bytes: Uint8Array): Icy {
    const icy: Icy = { width: 0, height: 0, background: null, layers: [], tags: [] };
    // The groups layers are in: each layer's group (if it's a group's
    // marker) and the group it's in; and which layers are images.
    const groups: { id: bigint; parent: bigint; image?: true }[] = [];
    let compressed = false;
    let unicode = false;
    const all = records(bytes);
    if (all[0]?.[0] !== 'ICED') {
        throw new Error('.icy file: no header');
    }

    for (const [keyword, packed] of all) {
        if (keyword === 'END') {
            break;
        }
        // (Images are PNGs, compressed already.)
        const data: Uint8Array = compressed && keyword !== 'ICED' && keyword !== 'SIXEL' ? Bun.zstdDecompressSync(packed) : packed;
        const r = new Reader(data, keyword);
        const layer = icy.layers.at(-1);
        switch (keyword) {
            case 'ICED': {
                const version = r.u16();
                if (version < OLDEST || version > NEWEST) {
                    throw new Error(`.icy file: version ${version} is not one this reader knows (${OLDEST} to ${NEWEST})`);
                }
                compressed = r.u8() === ZSTD;
                r.skip(2);
                const buffer = r.u16();
                if (buffer !== CP437_BUFFER && buffer !== UNICODE_BUFFER) {
                    throw new Error('.icy file: only CP437 and Unicode documents are supported');
                }
                unicode = buffer === UNICODE_BUFFER;
                r.skip(2);
                icy.width = r.u32();
                icy.height = r.u32();
                break;
            }
            case 'SCREEN': {
                r.u16();
                while (!r.done) {
                    const tag = r.u16();
                    r.u16();
                    const value = r.u32();
                    if (tag === 3 && value < COLOR_COUNT) {
                        icy.background = value;
                    }
                }
                break;
            }
            case 'LAYER': {
                const title = r.string();
                const mode = MODES[r.u8()] ?? 'normal';
                r.skip(4); // the layer's colour in Icy Draw's list
                const flags = r.u32();
                const x = r.i32() + 1;
                const y = r.i32() + 1;
                const width = r.i32();
                const height = r.i32();
                const cells: (IcyCell | null)[] = [];
                for (let n = 0; n < width * height; n++) {
                    const code = r.u32();
                    const { fg, bg, blink, invisible } = attribute(r);
                    const ch = code === 0 ? ' ' : !unicode && code < 256 ? (CP437[code] ?? ' ') : String.fromCodePoint(code);
                    cells.push(invisible ? null : { ch, fg, bg, blink });
                }
                icy.layers.push({ title, x, y, width, height, visible: (flags & VISIBLE) !== 0, alpha: (flags & HAS_ALPHA) !== 0, mode, cells });
                groups.push({ id: 0n, parent: 0n });
                break;
            }
            case 'SIXEL': {
                // An image layer, which isn't drawn; kept until the end so
                // that the records after it go with it.
                icy.layers.push({ title: r.string(), x: 1, y: 1, width: 0, height: 0, visible: false, alpha: true, mode: 'normal', cells: [] });
                groups.push({ id: 0n, parent: 0n, image: true });
                break;
            }
            case 'GROUP': {
                r.u8();
                const parent = new DataView(data.buffer, data.byteOffset + 1, 16);
                groups[groups.length - 1] = { ...groups.at(-1), parent: parent.getBigUint64(0, true), id: parent.getBigUint64(8, true) };
                break;
            }
            case 'GRAPHEME': {
                // Letters with accents and the like, whose first code point
                // is in the layer.
                r.u8();
                const rows = JSON.parse(new TextDecoder().decode(r.rest())) as Record<string, Record<string, { text: string; width: number }>>;
                for (const [row, columns] of Object.entries(rows)) {
                    for (const [column, { text, width }] of Object.entries(columns)) {
                        if (width !== 1) {
                            throw new Error(`.icy file: "${text}" is two cells wide, which the game can't draw`);
                        }
                        const cell = layer?.cells[Number(row) * layer.width + Number(column)];
                        if (cell) {
                            cell.ch = text;
                        }
                    }
                }
                break;
            }
            case 'EFFECTS':
                throw new Error(`.icy file: layer "${layer?.title}" has effects, which are not supported`);
            case 'TAG': {
                for (let n = r.u16(); n > 0; n--) {
                    const preview = r.string();
                    const text = r.string();
                    const x = r.i32() + 1;
                    const y = r.i32() + 1;
                    const length = r.u16();
                    const enabled = r.u8() === 1;
                    const align = ALIGNS[r.u8()] ?? 'left';
                    r.u8(); // placement
                    const role = r.u8();
                    const { fg, bg, blink } = attribute(r);
                    if (enabled && role === 0) {
                        icy.tags.push({ text: text || preview, preview, x, y, length, align, fg: fg ?? 7, bg, blink });
                    }
                }
                break;
            }
            // (Anything else: fonts, palettes, SAUCE, and live text, whose
            // cells are in its layer already.)
        }
    }

    // Leave out group markers and images, and hide what's in hidden groups.
    const marker = new Map(groups.map((g, i) => [g.id, i]));
    const shown = (i: number): boolean => {
        const parent = marker.get(groups[i]?.parent ?? 0n);
        return (icy.layers[i]?.visible ?? false) && (groups[i]?.parent === 0n || (parent !== undefined && shown(parent)));
    };
    icy.layers = icy.layers.flatMap((l, i) => (groups[i]?.id || groups[i]?.image ? [] : [{ ...l, visible: shown(i) }]));
    return icy;
}

// The colours a cell shows at its top and bottom halves (for drawing a
// transparent colour over it), as Icy Draw works them out.
function halves(c: IcyCell): [Color | null, Color | null] {
    switch (c.ch) {
        case ' ':
            return [c.bg, c.bg];
        case '▄':
            return [c.bg, c.fg];
        case '▀':
            return [c.fg, c.bg];
        case '█':
            return [c.fg, c.fg];
        default:
            return c.fg === c.bg ? [c.fg, c.fg] : [0, 0];
    }
}

const blank = (c: IcyCell): boolean => c.ch === ' ' || (c.fg ?? 0) === (c.bg ?? 0);

// The layers drawn together, the way Icy Draw shows them. Cells with
// nothing in them are null, and a background left transparent is null.
export function flatten({ width, height, background, layers }: Icy): Painting {
    const cells: (Paint | null)[] = [];
    for (let y = 1; y <= height; y++) {
        for (let x = 1; x <= width; x++) {
            let found: IcyCell | null = background === null ? null : { ch: ' ', fg: 7, bg: background, blink: false };
            for (const layer of layers) {
                const lx = x - layer.x;
                const ly = y - layer.y;
                if (!layer.visible || lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) {
                    continue;
                }
                const cell = layer.cells[ly * layer.width + lx] ?? null;
                if (layer.mode === 'chars') {
                    if (found && cell && !blank(cell)) {
                        found = { ...found, ch: cell.ch };
                    }
                    continue;
                }
                if (layer.mode === 'attributes') {
                    if (found && cell) {
                        found = { ...found, fg: cell.fg, bg: cell.bg, blink: cell.blink };
                    }
                    continue;
                }
                const under = found ?? { ch: ' ', fg: null, bg: null, blink: false };
                found = cell ? { ...cell } : found;
                if (found && (found.fg === null || found.bg === null)) {
                    const [top, bottom] = halves(under);
                    found.fg ??= found.ch === '▀' ? top : bottom;
                    found.bg ??= found.ch === '▄' ? top : bottom;
                }
                if (!layer.alpha) {
                    found = { ch: ' ', blink: false, ...found, fg: found?.fg ?? 0, bg: found?.bg ?? 0 };
                }
            }
            cells.push(!found || (found.ch === ' ' && found.bg === null) ? null : { ...found, fg: found.fg ?? 0 });
        }
    }
    return { width, height, cells };
}

// Where a layer's cells are: the smallest box around them, or null if the
// layer isn't there or is empty.
export function layerBox(icy: Icy, title: string): { x: number; y: number; width: number; height: number } | null {
    const layer = icy.layers.find((l) => l.title === title);
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    layer?.cells.forEach((cell, n) => {
        if (cell) {
            const x = layer.x + (n % layer.width);
            const y = layer.y + Math.floor(n / layer.width);
            [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
        }
    });
    return left === Infinity ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// The tags' text as markup, with each @NAME@ in it given its value. Text
// too long for its tag is cut; centred text sits as {center} would put it
// in a tag across the screen.
export function tagMarkup({ tags }: Icy, values: Readonly<Record<string, string>>): string[] {
    return tags.map(({ text, x, y, length, align, fg, bg, blink }) => {
        const filled = text.replace(/@([A-Za-z0-9_]+)@/g, (_, name: string) => {
            const value = values[name];
            if (value === undefined) {
                throw new Error(`no value for @${name}@ in a tag`);
            }
            return value;
        });
        const fitted = splitCells(filled).slice(0, length).join('');
        const room = length - cellCount(fitted);
        const start = x + (align === 'left' ? 0 : align === 'right' ? room : Math.ceil(room / 2));
        return `{y ${y}}{x ${start}}{${blink ? 'blink' : 'color'} ${fg}}${bg === null ? '' : `{on ${bg}}`}${escapeMarkup(fitted)}`;
    });
}

// ---- Writing

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

// Little-endian numbers and strings, for records.
class Writer {
    private readonly parts: number[] = [];
    public u8(...n: number[]): this {
        this.parts.push(...n);
        return this;
    }
    public u16(n: number): this {
        return this.u8(n & 0xff, n >> 8);
    }
    public u32(n: number): this {
        return this.u16(n & 0xffff).u16(n >>> 16);
    }
    public bytes(b: Uint8Array): this {
        for (const x of b) {
            this.parts.push(x);
        }
        return this;
    }
    public string(s: string): this {
        const b = new TextEncoder().encode(s);
        return this.u32(b.length).bytes(b);
    }
    public color(c: Color | null): this {
        return c === null ? this.u8(0) : c < 16 ? this.u8(c + 1) : this.u8(17, c);
    }
    public attribute(fg: Color | null, bg: Color | null, flags: number): this {
        return this.color(fg).color(bg).u8(0).u16(flags);
    }
    public done(): Uint8Array {
        return Uint8Array.from(this.parts);
    }
}

// A preview: each cell a block of its background, with a smaller one in
// its foreground if it isn't blank.
function preview({ width, height, cells }: Painting): Uint8Array {
    const [cw, ch] = [8, 16];
    const row = 1 + width * cw * 4;
    const pixels = new Uint8Array(row * height * ch);
    for (let py = 0; py < height * ch; py++) {
        for (let px = 0; px < width * cw; px++) {
            const cell = cells[Math.floor(py / ch) * width + Math.floor(px / cw)];
            const inside = px % cw > 0 && px % cw < 7 && py % ch > 3 && py % ch < 13 && cell?.ch.trim();
            const c = !cell ? null : inside ? cell.fg : cell.bg;
            if (c !== null) {
                pixels.set([...rgb(c), 255], py * row + 1 + px * 4);
            }
        }
    }
    const header = new DataView(new ArrayBuffer(13));
    header.setUint32(0, width * cw);
    header.setUint32(4, height * ch);
    header.setUint8(8, 8);
    header.setUint8(9, 6); // RGBA
    return Uint8Array.from([
        ...SIGNATURE,
        ...chunk('IHDR', new Uint8Array(header.buffer)),
        ...chunk('IDAT', deflateSync(pixels)),
    ]);
}

// An .icy file of these layers and tags, which Icy Draw (0.6 or later) can
// open. Characters outside CP437 make it a Unicode document.
export function writeIcy(icy: Icy, { compress = true } = {}): Uint8Array {
    const unicode = icy.layers.some((l) => l.cells.some((c) => c && !CP437_BYTE.has(c.ch)));
    const record = (keyword: string, data: Uint8Array, pack = compress): Uint8Array => {
        const body = pack ? Bun.zstdCompressSync(data) : data;
        return chunk('icYD', new Writer().u8(1).u16(keyword.length).bytes(new TextEncoder().encode(keyword)).u32(body.length).bytes(body).done());
    };
    const header = new Writer()
        .u16(1)
        .u8(compress ? ZSTD : 0, 0, 0)
        .u16(unicode ? UNICODE_BUFFER : CP437_BUFFER)
        .u8(0, 0) // any colours, the standard font
        .u32(icy.width)
        .u32(icy.height)
        .u8(8, 16);
    const layers = icy.layers.map((l) => {
        const w = new Writer()
            .string(l.title)
            .u8(MODES.indexOf(l.mode), 0, 0, 0, 0)
            .u32((l.visible ? VISIBLE : 0) | (l.alpha ? HAS_ALPHA : 0))
            .u32(l.x - 1)
            .u32(l.y - 1)
            .u32(l.width)
            .u32(l.height);
        for (const c of l.cells) {
            if (!c) {
                w.u32(0x20).attribute(null, null, INVISIBLE);
            } else {
                w.u32(unicode ? (c.ch.codePointAt(0) ?? 0x20) : (CP437_BYTE.get(c.ch) ?? 0x3f)).attribute(c.fg, c.bg, c.blink ? BLINK : 0);
            }
        }
        return record('LAYER', w.done());
    });
    const tags = new Writer().u16(icy.tags.length);
    for (const t of icy.tags) {
        tags.string(t.preview).string(t.text).u32(t.x - 1).u32(t.y - 1).u16(t.length)
            .u8(1, ALIGNS.indexOf(t.align), 1, 0).attribute(t.fg, t.bg, t.blink ? BLINK : 0);
    }
    const image = preview(flatten(icy));
    return Uint8Array.from([
        ...image.subarray(0, 8 + 25), // signature and IHDR
        ...record('ICED', header.done(), false),
        ...layers.flatMap((l) => [...l]),
        ...(icy.tags.length ? record('TAG', tags.done()) : []),
        ...record('END', new Uint8Array(), false),
        ...image.subarray(8 + 25),
        ...chunk('IEND', new Uint8Array()),
    ]);
}
