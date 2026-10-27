// XBin (.xb) pictures: screens drawn in an ANSI art editor such as Icy Draw,
// read into cells or markup lines, and cells written back out.
//
// An XBin file is a header, an optional palette and font (both ignored
// here: the game always uses its own), then two bytes per cell: a CP437
// character and a CGA attribute (foreground, background, blink). The cells
// may be run-length compressed. Anything after them (a SAUCE record) is
// ignored.

import { COLORS, HEIGHT, WIDTH, type Cell, type Color } from './screen.ts';
import { escapeMarkup } from './text.ts';

// Each CP437 byte as Unicode. 0 and 255 show as spaces.
export const CP437: readonly string[] = [
    ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼',
    ...Array.from({ length: 0x5f }, (_, i) => String.fromCharCode(0x20 + i)),
    '⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
].flatMap((s) => [...s]);

// Each character's CP437 byte.
export const CP437_BYTE: ReadonlyMap<string, number> = new Map([...CP437.map((ch, i) => [ch, i] as const), [' ', 0x20]]);

const MAGIC = 'XBIN\x1a';
const HEADER = 11;
const PALETTE = 1;
const FONT = 2;
const COMPRESS = 4;
const NONBLINK = 8; // bit 7 of the attribute brightens the background instead
const FONT512 = 16;

export interface Picture {
    width:  number;
    height: number;
    cells:  Cell[]; // row by row
}

export function readXBin(bytes: Uint8Array): Picture {
    if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== MAGIC || bytes.length < HEADER) {
        throw new Error('not an XBin file');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(5, true);
    const height = view.getUint16(7, true);
    const fontHeight = bytes[9] ?? 16;
    const flags = bytes[10] ?? 0;
    let i = HEADER;
    if (flags & PALETTE) {
        i += 48;
    }
    if (flags & FONT) {
        i += fontHeight * (flags & FONT512 ? 512 : 256);
    }

    const cells: Cell[] = [];
    const count = width * height;
    const next = (): number => {
        const b = bytes[i++];
        if (b === undefined) {
            throw new Error(`XBin file ends after ${cells.length} of ${count} cells`);
        }
        return b;
    };
    const cell = (ch: number, attr: number): void => {
        const high = (attr & 0x80) !== 0;
        cells.push({
            ch:    CP437[ch] ?? ' ',
            fg:    attr & 0x0f,
            bg:    ((attr >> 4) & 0x07) + (high && flags & NONBLINK ? 8 : 0),
            blink: high && !(flags & NONBLINK),
        });
    };

    while (cells.length < count) {
        if (!(flags & COMPRESS)) {
            cell(next(), next());
            continue;
        }

        // A run: two bits for what repeats (nothing, the character, the
        // attribute or both), six for its length less one.
        const run = next();
        const repeat = run >> 6;
        const ch = repeat & 1 ? next() : 0;
        const attr = repeat & 2 ? next() : 0;
        for (let n = (run & 0x3f) + 1; n > 0 && cells.length < count; n--) {
            cell(repeat & 1 ? ch : next(), repeat & 2 ? attr : next());
        }
    }

    return { width, height, cells };
}

// An uncompressed XBin file. Characters with no CP437 byte become "?";
// colours must be the 16 CGA ones, and a picture can't have both blinking
// text and bright backgrounds.
export function writeXBin({ width, height, cells }: Picture): Uint8Array {
    const nonblink = cells.some((c) => c.bg > 7);
    const bytes = new Uint8Array(HEADER + width * height * 2);
    bytes.set([...MAGIC].map((c) => c.charCodeAt(0)));
    const view = new DataView(bytes.buffer);
    view.setUint16(5, width, true);
    view.setUint16(7, height, true);
    bytes[9] = 16;
    bytes[10] = nonblink ? NONBLINK : 0;
    cells.forEach(({ ch, fg, bg, blink }, n) => {
        if (fg > 15 || bg > 15 || (blink && nonblink)) {
            throw new Error(`cell ${(n % width) + 1},${Math.floor(n / width) + 1} can't be saved in XBin`);
        }
        bytes[HEADER + n * 2] = CP437_BYTE.get(ch) ?? 0x3f;
        bytes[HEADER + n * 2 + 1] = fg | ((bg & 7) << 4) | (blink || bg > 7 ? 0x80 : 0);
    });
    return bytes;
}

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
// Only what fits on the screen is kept.
export function pictureMarkup({ width, cells }: Painting): string[] {
    const name = (c: number): string => COLORS[c] ?? String(c);
    const lines: string[] = [];
    for (let y = 0; y < Math.min(HEIGHT, cells.length / width); y++) {
        let line = '';
        let last: Paint | null = null;
        const end = (): void => {
            if (line) {
                lines.push(line);
            }
            line = '';
            last = null;
        };
        cells.slice(y * width, y * width + Math.min(width, WIDTH)).forEach((c, x) => {
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
