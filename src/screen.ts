// A grid of coloured character cells (80x25 unless a game says otherwise:
// Config.screen), drawn to the terminal by sending only the cells that
// changed since the last flush.
//
// Coordinates count from 1 (x = column 1-80, y = row 1-25 on an 80x25
// screen) to match the game data. Colours are numbers from 0 to 255: the 16 CGA colours, then xterm's
// 256-colour palette. Each screen draws them as well as its terminal can
// (see ColorDepth).

import { at } from './assert.ts';
import { REPLACEMENT, cells, fitsCell } from './chars.ts';

// The usual size, and the smallest a game can have.
export const WIDTH  = 80;
export const HEIGHT = 25;

export interface ScreenSize {
    width: number;
    height: number;
}

export const DEFAULT_SIZE: ScreenSize = { width: WIDTH, height: HEIGHT };

export const COLORS = [
    'black', 'blue', 'green', 'cyan', 'red', 'magenta', 'brown', 'gray',
    'darkgray', 'lightblue', 'lightgreen', 'lightcyan', 'lightred', 'lightmagenta', 'yellow', 'white',
] as const;

export type ColorName = (typeof COLORS)[number];

// A colour, 0-255. 0-15 are the 16 CGA colours (in CGA's order: COLORS);
// 16-255 are xterm's: a 6x6x6 cube of red, green and blue (16 + 36r + 6g
// + b, each 0-5), then 24 greys from dark to light (232-255).
export type Color = number;
export const COLOR_COUNT = 256;

export interface Cell {
    ch:    string;
    fg:    Color;
    bg:    Color;
    blink: boolean;
}

export interface Point {
    x: number;
    y: number;
}

export type Rgb = readonly [number, number, number];

// prettier-ignore
export const RGB: readonly Rgb[] = [
    [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170], [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
    [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255], [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
];

// The red, green and blue of a colour.
export function rgb(c: Color): Rgb {
    if (c < 16) {
        return at(RGB, c);
    }

    if (c < 232) {
        const level = (n: number): number => (n === 0 ? 0 : 55 + 40 * n);
        const i = c - 16;
        return [level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)];
    }

    const grey = 8 + 10 * (c - 232);
    return [grey, grey, grey];
}

// The colour among `choices` that looks most like `c`.
function nearest(c: Color, choices: readonly Color[]): Color {
    const [r, g, b] = rgb(c);
    let best = at(choices, 0);
    let bestDistance = Infinity;
    for (const choice of choices) {
        const [r2, g2, b2] = rgb(choice);
        const distance = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
        if (distance < bestDistance) {
            best = choice;
            bestDistance = distance;
        }
    }

    return best;
}

const range = (from: number, to: number): Color[] => Array.from({ length: to - from }, (_, i) => from + i);

// Each colour as one of the 16, for terminals with no more.
const AS_16 = range(0, COLOR_COUNT).map((c) => (c < 16 ? c : nearest(c, range(0, 16))));
// Each colour as one of xterm's 16-255, for 256-colour terminals. Those
// look the same everywhere, while a terminal's first 16 are its own (its
// "brown" is often yellow), so the CGA colours are drawn with them too.
const AS_256 = range(0, COLOR_COUNT).map((c) => (c < 16 ? nearest(c, range(16, COLOR_COUNT)) : c));

// How many colours a terminal can show: any (24-bit "true colour"), xterm's
// 256, or the 16. Colours it can't show are drawn as the nearest it can.
export type ColorDepth = 'true' | '256' | '16';

// A terminal's colour depth, from its environment: FQ2_COLORS (16, 256 or
// true) if it's set; then COLORTERM, which true-colour terminals set to
// truecolor or 24bit; then TERM, which names 256color if it can do those.
// With no TERM at all (Windows Terminal), true colour.
export function colorDepth(env: Readonly<Record<string, string | undefined>>): ColorDepth {
    const asked = env['FQ2_COLORS'];
    if (asked === '16' || asked === '256' || asked === 'true') {
        return asked;
    }

    const colorterm = env['COLORTERM'] ?? '';
    if (colorterm === 'truecolor' || colorterm === '24bit') {
        return 'true';
    }

    const term = env['TERM'];
    if (term === undefined || term === '') {
        return 'true';
    }

    return term.includes('256color') ? '256' : '16';
}

// CGA colour order is BGR, ANSI is RGB.
const ANSI = [0, 4, 2, 6, 1, 5, 3, 7];

// A cell's colours as one number: fg in bits 0-7, bg in 8-15, blink in 16.
const packAttr = (fg: Color, bg: Color, blink: number): number => fg | (bg << 8) | (blink << 16);

// The escape sequence for each packed attribute, made once for each depth.
const styles: Readonly<Record<ColorDepth, Map<number, string>>> = { true: new Map(), 256: new Map(), 16: new Map() };
function styleOf(attr: number, depth: ColorDepth): string {
    let style = styles[depth].get(attr);
    if (style === undefined) {
        style = sgr(attr & 255, (attr >> 8) & 255, attr >> 16, depth);
        styles[depth].set(attr, style);
    }

    return style;
}

function sgr(fg: Color, bg: Color, blink: number, depth: ColorDepth): string {
    const b = blink ? ';5' : '';
    if (depth === 'true') {
        const [fr, fg2, fb] = rgb(fg);
        const [br, bg2, bb] = rgb(bg);

        return `\x1b[0${b};38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m`;
    }

    if (depth === '256') {
        return `\x1b[0${b};38;5;${at(AS_256, fg)};48;5;${at(AS_256, bg)}m`;
    }

    // The bright eight are 90-97 and 100-107.
    const ansi = (c: Color, base: number): number => {
        const c16 = at(AS_16, c);
        return c16 < 8 ? base + at(ANSI, c16) : base + 60 + at(ANSI, c16 - 8);
    };

    return `\x1b[0${b};${ansi(fg, 30)};${ansi(bg, 40)}m`;
}

export class Screen {
    private readonly chars: string[];
    private readonly fg:    Uint8Array;
    private readonly bg:    Uint8Array;
    private readonly blink: Uint8Array;
    // What the terminal shows now: each cell's character and packed
    // attribute (null and -1 when unknown).
    private readonly shownCh: (string | null)[];
    private readonly shownAttr: Int32Array;
    // Whether anything may differ from what the terminal shows.
    private dirty = true;

    public cursor: Point | null = null; // when the terminal cursor should be visible

    // How many colours the terminal can show.
    public readonly depth: ColorDepth;
    public readonly width: number;
    public readonly height: number;

    public constructor(depth: ColorDepth = 'true', { width, height }: ScreenSize = DEFAULT_SIZE) {
        this.depth = depth;
        this.width = width;
        this.height = height;
        const size = width * height;
        this.chars = new Array<string>(size).fill(' ');
        this.fg    = new Uint8Array(size).fill(7);
        this.bg    = new Uint8Array(size).fill(0);
        this.blink = new Uint8Array(size);
        this.shownCh = new Array<string | null>(size).fill(null);
        this.shownAttr = new Int32Array(size).fill(-1);
    }

    public inside(x: number, y: number): boolean {
        return x >= 1 && x <= this.width && y >= 1 && y <= this.height;
    }

    private index(x: number, y: number): number {
        return (y - 1) * this.width + (x - 1);
    }

    // `ch` should fit a cell (see chars.ts); anything else is drawn as a "?".
    public put(x: number, y: number, ch: string, fg: Color, bg: Color, blink = false): void {
        if (!this.inside(x, y)) {
            return;
        }

        if (!fitsCell(ch)) {
            ch = REPLACEMENT;
        }

        const i       = this.index(x, y);
        const b       = blink ? 1 : 0;
        if (this.chars[i] === ch && this.fg[i] === fg && this.bg[i] === bg && this.blink[i] === b) {
            return;
        }

        this.chars[i] = ch;
        this.fg[i]    = fg;
        this.bg[i]    = bg;
        this.blink[i] = b;
        this.dirty    = true;
    }

    // Writes a plain string in one colour, clipped to the screen.
    public text(x: number, y: number, str: string, fg: Color, bg: Color): void {
        for (const ch of cells(str)) {
            this.put(x++, y, ch, fg, bg);
        }
    }

    public cell(x: number, y: number): Cell {
        const i = this.index(x, y);
        return { ch: at(this.chars, i), fg: at(this.fg, i), bg: at(this.bg, i), blink: !!at(this.blink, i) };
    }

    public fillRow(y: number, bg: Color = 0, fg: Color = 7): void {
        for (let x = 1; x <= this.width; x++) {
            this.put(x, y, ' ', fg, bg);
        }
    }

    public clear(bg: Color = 0): void {
        for (let y = 1; y <= this.height; y++) {
            this.fillRow(y, bg);
        }
    }

    public invalidate(): void {
        this.shownCh.fill(null);
        this.shownAttr.fill(-1);
        this.dirty = true;
    }

    private attr(i: number): number {
        return packAttr(this.fg[i] ?? 0, this.bg[i] ?? 0, this.blink[i] ?? 0);
    }

    private style(i: number): string {
        return styleOf(this.attr(i), this.depth);
    }

    // The escape sequence that brings the terminal up to date.
    public render(): string {
        let out = '';
        let last = '';
        let pos = -1;
        for (let i = 0; this.dirty && i < this.width * this.height; i++) {
            const ch = this.chars[i] ?? ' ';
            const attr = this.attr(i);
            if (this.shownCh[i] === ch && this.shownAttr[i] === attr) {
                continue;
            }

            this.shownCh[i] = ch;
            this.shownAttr[i] = attr;
            if (pos !== i) {
                out += `\x1b[${Math.floor(i / this.width) + 1};${(i % this.width) + 1}H`;
            }

            const style = styleOf(attr, this.depth);
            if (style !== last) {
                out += last = style;
            }
            out += ch;

            // Never rely on the terminal's own wrapping at the right margin.
            pos = (i + 1) % this.width === 0 ? -1 : i + 1;
        }

        this.dirty = false;
        if (out) {
            out += '\x1b[0m';
        }

        out += this.cursor
            ? `\x1b[${this.cursor.y};${this.cursor.x}H\x1b[?25h`
            : '\x1b[?25l';

        return out;
    }

    // The visible part of the screen as coloured text, for leaving the final
    // screen (the credits) in the terminal after the game exits.
    public dump(): string {
        const lines: string[] = [];
        for (let y = 1; y <= this.height; y++) {
            let end = this.width;
            while (
                end > 0 &&
        at(this.chars, this.index(end, y)) === ' ' &&
        at(this.bg, this.index(end, y)) === 0
            ) {
                end--;
            }

            let line = '';
            let last = '';
            for (let x = 1; x <= end; x++) {
                const i = this.index(x, y);
                const style = this.style(i);
                if (style !== last) {
                    line += last = style;
                }

                line += at(this.chars, i);
            }

            lines.push(line + (line ? '\x1b[0m' : ''));
        }

        while (lines.length && !lines.at(-1)) {
            lines.pop();
        }

        return lines.join('\n');
    }
}
