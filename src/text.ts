// Coloured text markup used by all of the game's writing.
//
//   {yellow}        foreground colour (any name in COLORS)
//   {blink red}     blinking foreground
//   {on blue}       background colour (black ... gray)
//   {x 27} {y 5}    move to a column / row
//   {sp 10}         ten spaces in the current colours
//   {center}        start here so that the whole line is centred
//   {{              a literal "{"
//
// Text drawn without an {on ...} keeps the background already on screen.

import { COLORS, WIDTH, HEIGHT, type Color, type Point, type Screen } from './screen.ts';
import { cellCount, cells } from './chars.ts';

type Token =
  | { type: 'text'; text: string }
  | { type: 'fg'; color: Color; blink: boolean }
  | { type: 'bg'; color: Color }
  | { type: 'x' | 'y' | 'sp'; n: number }
  | { type: 'center' };

const COLOR = new Map<string, Color>(COLORS.map((name, i) => [name, i]));

const TAG = /\{\{|\{([a-z]+)(?: ([a-z0-9]+))?\}/g;

function tag(all: string, name: string | undefined, arg: string | undefined): Token | null {
    if (all === '{{') {
        return { type: 'text', text: '{' };
    }

    if (name === undefined) {
        return null;
    }

    const color = COLOR.get(name);
    if (color !== undefined && arg === undefined) {
        return { type: 'fg', color, blink: false };
    }

    const argColor = arg === undefined ? undefined : COLOR.get(arg);
    if (name === 'blink' && argColor !== undefined) {
        return { type: 'fg', color: argColor, blink: true };
    }

    if (name === 'on' && argColor !== undefined && argColor < 8) {
        return { type: 'bg', color: argColor };
    }

    if ((name === 'x' || name === 'y' || name === 'sp') && /^\d+$/.test(arg ?? '')) {
        return { type: name, n: Number(arg) };
    }

    if (name === 'center' && arg === undefined) {
        return { type: 'center' };
    }

    return null;
}

export function parse(text: string): Token[] {
    const tokens: Token[] = [];
    let last = 0;
    const literal = (s: string): void => {
        if (s) {
            tokens.push({ type: 'text', text: s });
        }
    };

    for (const m of text.matchAll(TAG)) {
        literal(text.slice(last, m.index));
        const [all, name, arg] = m;
        last = m.index + all.length;
        tokens.push(tag(all, name, arg) ?? { type: 'text', text: all });
    }

    literal(text.slice(last));
    return tokens;
}

// Number of character cells the text occupies.
export function width(text: string): number {
    let n = 0;
    for (const t of parse(text)) {
        if (t.type === 'text') {
            n += cellCount(t.text);
        } else if (t.type === 'sp') {
            n += t.n;
        }
    }

    return n;
}

// Text from players (names, and later chat and mail) made safe to put in
// markup: its braces are shown as they are instead of changing colours.
export function escapeMarkup(text: string): string {
    return text.replaceAll('{', '{{');
}

export function strip(text: string): string {
    return parse(text)
        .map((t) => (t.type === 'text' ? t.text : t.type === 'sp' ? ' '.repeat(t.n) : ''))
        .join('');
}

export interface DrawOptions {
    x?: number;
    y?: number;
    fg?: Color;
    bg?: Color | null;
    // Whether text past the right edge carries on in the next row (true) or
    // is cut off (false).
    wrap?: boolean;
}

// Draws one line of markup. Returns where the cursor ended up.
export function draw(screen: Screen, text: string, { x = 1, y = 1, fg = 15, bg = null, wrap = true }: DrawOptions = {}): Point {
    let blink = false;
    const put = (ch: string): void => {
        if (x > WIDTH) {
            if (!wrap) {
                return;
            }

            x = 1;
            y++;
        }
        if (y > HEIGHT) {
            return;
        }
        const back = bg ?? (screen.inside(x, y) ? screen.cell(x, y).bg : 0);
        screen.put(x, y, ch, fg, back, blink);
        x++;
    };
    for (const t of parse(text)) {
        switch (t.type) {
            case 'text':
                for (const ch of cells(t.text)) {
                    put(ch);
                }
                break;
            case 'fg':
                fg = t.color;
                blink = t.blink;
                break;
            case 'bg':
                bg = t.color;
                break;
            case 'x':
                x = Math.max(1, t.n);
                break;
            case 'y':
                y = Math.max(1, t.n);
                break;
            case 'sp':
                for (let i = 0; i < t.n; i++) {
                    put(' ');
                }
                break;
            case 'center':
                // (A line too wide to centre starts at the left edge.)
                x = Math.max(1, 40 - Math.floor(width(text) / 2) + 1);
                break;
        }
    }
    return { x, y };
}
