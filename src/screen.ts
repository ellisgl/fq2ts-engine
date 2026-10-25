// An 80x25 grid of coloured character cells, drawn to the terminal by
// sending only the cells that changed since the last flush.
//
// Coordinates are 1-based (x = column 1-80, y = row 1-25) to match the game
// data. Colours are the 16 CGA colours; backgrounds use the first 8.

import { at } from './assert.ts';
import { REPLACEMENT, cells, fitsCell } from './chars.ts';

export const WIDTH  = 80;
export const HEIGHT = 25;

export const COLORS = [
    'black', 'blue', 'green', 'cyan', 'red', 'magenta', 'brown', 'gray',
    'darkgray', 'lightblue', 'lightgreen', 'lightcyan', 'lightred', 'lightmagenta', 'yellow', 'white',
] as const;

export type ColorName = (typeof COLORS)[number];

// A CGA colour number, 0-15.
export type Color = number;

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

// CGA colour order is BGR, ANSI is RGB.
const ANSI = [0, 4, 2, 6, 1, 5, 3, 7];
const trueColor = process.env['FQ2_COLORS'] !== '16';

// A cell's colours as one number: fg in bits 0-3, bg in 4-7, blink in 8.
const packAttr = (fg: Color, bg: Color, blink: number): number => fg | (bg << 4) | (blink << 8);

// The escape sequence for each packed attribute, made once.
const styles = new Map<number, string>();
function styleOf(attr: number): string {
    let style = styles.get(attr);
    if (style === undefined) {
        style = sgr(attr & 15, (attr >> 4) & 15, attr >> 8);
        styles.set(attr, style);
    }

    return style;
}

function sgr(fg: Color, bg: Color, blink: number): string {
    const b = blink ? ';5' : '';
    if (trueColor) {
        const [fr, fg2, fb] = at(RGB, fg);
        const [br, bg2, bb] = at(RGB, bg);

        return `\x1b[0${b};38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m`;
    }

    const f = fg < 8 ? 30 + at(ANSI, fg) : 90 + at(ANSI, fg - 8);

    return `\x1b[0${b};${f};${40 + at(ANSI, bg)}m`;
}

export class Screen {
    private readonly chars: string[];
    private readonly fg:    Uint8Array;
    private readonly bg:    Uint8Array;
    private readonly blink: Uint8Array;
    // What the terminal shows now: each cell's character and packed
    // attribute (null and -1 when unknown).
    private readonly shownCh: (string | null)[];
    private readonly shownAttr: Int16Array;
    // Whether anything may differ from what the terminal shows.
    private dirty = true;

    public cursor: Point | null = null; // when the terminal cursor should be visible

    public constructor() {
        const size = WIDTH * HEIGHT;
        this.chars = new Array<string>(size).fill(' ');
        this.fg    = new Uint8Array(size).fill(7);
        this.bg    = new Uint8Array(size).fill(0);
        this.blink = new Uint8Array(size);
        this.shownCh = new Array<string | null>(size).fill(null);
        this.shownAttr = new Int16Array(size).fill(-1);
    }

    public inside(x: number, y: number): boolean {
        return x >= 1 && x <= WIDTH && y >= 1 && y <= HEIGHT;
    }

    private index(x: number, y: number): number {
        return (y - 1) * WIDTH + (x - 1);
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
        for (let x = 1; x <= WIDTH; x++) {
            this.put(x, y, ' ', fg, bg);
        }
    }

    public clear(bg: Color = 0): void {
        for (let y = 1; y <= HEIGHT; y++) {
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
        return styleOf(this.attr(i));
    }

    // The escape sequence that brings the terminal up to date.
    public render(): string {
        let out = '';
        let last = '';
        let pos = -1;
        for (let i = 0; this.dirty && i < WIDTH * HEIGHT; i++) {
            const ch = this.chars[i] ?? ' ';
            const attr = this.attr(i);
            if (this.shownCh[i] === ch && this.shownAttr[i] === attr) {
                continue;
            }

            this.shownCh[i] = ch;
            this.shownAttr[i] = attr;
            if (pos !== i) {
                out += `\x1b[${Math.floor(i / WIDTH) + 1};${(i % WIDTH) + 1}H`;
            }

            const style = styleOf(attr);
            if (style !== last) {
                out += last = style;
            }
            out += ch;

            // Never rely on the terminal's own wrapping at the right margin.
            pos = (i + 1) % WIDTH === 0 ? -1 : i + 1;
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
        for (let y = 1; y <= HEIGHT; y++) {
            let end = WIDTH;
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
