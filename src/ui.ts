// Reusable screen widgets: the status bar, menus and text entry.

import { draw, width } from './text.ts';
import { cellCount, fitsCell, graphemes } from './chars.ts';
import { at } from './assert.ts';
import { WIDTH, type Color, type Screen } from './screen.ts';
import { isMouse, type Terminal } from './terminal.ts';

const BLUE = 1;
const WHITE = 15;

// The bar on row 23: shaded ends and centred white-on-blue text. Text too
// long for the bar is cut off under the shaded ends.
// The row of the status bar, under the map.
export const STATUS_ROW = 23;

export function statusBar(screen: Screen, text: string): void {
    const y = STATUS_ROW;
    for (let x = 1; x <= 79; x++) {
        screen.put(x, y, ' ', WHITE, BLUE);
    }
    draw(screen, `{center}${text}`, { y, fg: WHITE, bg: BLUE, wrap: false });
    screen.text(1, y, '░▒', BLUE, 0);
    screen.text(78, y, '▒░', BLUE, 0);
    screen.put(80, y, ' ', 7, 0);
}

// A vertical list of options starting at row `y`. Returns the chosen index,
// or -1 when Escape is pressed. With the mouse on, clicking an option picks
// it and the wheel moves the highlight.
export async function choose(
    term: Terminal,
    options: readonly string[],
    {
        y,
        x = 1,
        selected = 0,
        colors = { normal: [WHITE, 0], selected: [WHITE, BLUE] },
    }: {
        y: number;
        x?: number;
        selected?: number;
        // [foreground, background] for the options and the highlighted one.
        colors?: { normal: readonly [Color, Color]; selected: readonly [Color, Color] };
    },
): Promise<number> {
    // With nothing to pick, there's nothing to wait for.
    if (!options.length) {
        return -1;
    }

    const { screen } = term;
    const plain = (i: number): string => at(options, i).replace(/\{[^}]*\}/g, '');
    for (;;) {
        options.forEach((option, i) => {
            const [fg, bg] = i === selected ? colors.selected : colors.normal;
            draw(screen, option, { x, y: y + i, fg, bg });
        });
        screen.cursor = { x: x + cellCount(plain(selected)), y: y + selected };
        const key = await term.event();
        screen.cursor = null;
        if (isMouse(key)) {
            const i = key.y - y;
            const option = options[i];
            if (key.action === 'press' && key.button === 'left' && option !== undefined && key.x >= x && key.x < x + Math.max(1, width(option))) {
                return i;
            }
            if (key.action === 'wheel') {
                selected = (selected + (key.button === 'up' ? options.length - 1 : 1)) % options.length;
            }
            continue;
        }
        if (key === 'enter') {
            return selected;
        }
        if (key === 'escape') {
            return -1;
        }
        if (key === 'up' || key === 'left') {
            selected = (selected + options.length - 1) % options.length;
        }
        if (key === 'down' || key === 'right') {
            selected = (selected + 1) % options.length;
        }
    }
}

export interface TextInputOptions {
    x: number;
    y: number;
    length: number;
    value?: string;
    fg?: Color;
    bg?: Color;
    filter?(ch: string): boolean;
    // Shown in place of each character typed (for passwords).
    mask?: string;
    // The most characters that can be typed (default: as many as fit). Past
    // what fits, the box shows the end of what's been typed.
    max?: number;
}

// A one-line text box. `length` includes the cursor cell, as in the
// original. Escape and Enter both finish.
export async function textInput(term: Terminal, options: TextInputOptions): Promise<string> {
    return (await editText(term, options)).value;
}

// Like textInput, but Escape cancels: the result is then null.
export async function askText(term: Terminal, options: TextInputOptions): Promise<string | null> {
    const { value, escaped } = await editText(term, options);
    return escaped ? null : value;
}

async function editText(
    term: Terminal,
    { x, y, length, value = '', fg = WHITE, bg = BLUE, filter = () => true, mask, max = length - 1 }: TextInputOptions,
): Promise<{ value: string; escaped: boolean }> {
    const { screen } = term;
    const fits = Math.max(0, length - 1);
    for (;;) {
        const typed = cellCount(value);
        const visible = typed > fits ? graphemes(value).slice(typed - fits) : graphemes(value);
        const shown = mask === undefined ? visible.join('') : mask.repeat(visible.length);
        screen.text(x, y, shown + ' '.repeat(Math.max(0, length - visible.length)), fg, bg);
        screen.cursor = { x: Math.min(x + visible.length, WIDTH), y };
        const key = await term.key();
        if (key === 'enter' || key === 'escape') {
            screen.cursor = null;
            return { value, escaped: key === 'escape' };
        }
        if (key === 'backspace') {
            value = graphemes(value).slice(0, -1).join('');
        } else if (cellCount(key) === 1 && fitsCell(key) && typed < max && filter(key)) {
            value += key;
        }
    }
}

// A prompt followed by a line of input, on a plain screen (debug editor).
export async function prompt(term: Terminal, y: number, label: string): Promise<string> {
    const { screen } = term;
    screen.text(1, y, label, 7, 0);
    return (await textInput(term, { x: cellCount(label) + 1, y, length: 30, fg: 7, bg: 0 })).trim();
}

// Rows of text shown at once by scrollText (rows 3 to 23).
export const SCROLL_PAGE = 21;

// A full-screen window of text that scrolls: arrows and the mouse wheel by a
// line, Page Up/Down (or Space) by a page, Home/End to the ends. Enter,
// Escape or Q closes it.
export async function scrollText(term: Terminal, lines: readonly string[], { title = '', from = 'top' }: { title?: string; from?: 'top' | 'bottom' } = {}): Promise<void> {
    const { screen } = term;
    const last = Math.max(0, lines.length - SCROLL_PAGE);
    let top = from === 'bottom' ? last : 0;
    for (;;) {
        screen.clear();
        screen.fillRow(1, BLUE);
        draw(screen, `{center}{yellow}${title}`, { y: 1, bg: BLUE, wrap: false });
        lines.slice(top, top + SCROLL_PAGE).forEach((line, i) => draw(screen, line, { x: 2, y: 3 + i, fg: 7 }));
        const shown = lines.length ? `${top + 1}-${Math.min(lines.length, top + SCROLL_PAGE)} of ${lines.length}` : 'empty';
        draw(screen, `{darkgray}Arrows, PgUp/PgDn, Home/End scroll.  Enter or Esc closes.{x 66}{gray}${shown}`, { y: 25, bg: 0 });
        const event = await term.event();
        if (isMouse(event)) {
            if (event.action === 'wheel') {
                top += event.button === 'up' ? -3 : 3;
            }
        } else {
            const key = event.toLowerCase();
            if (key === 'enter' || key === 'escape' || key === 'q') {
                return;
            }
            if (key === 'up') {
                top--;
            } else if (key === 'down') {
                top++;
            } else if (key === 'pageup') {
                top -= SCROLL_PAGE;
            } else if (key === 'pagedown' || key === ' ') {
                top += SCROLL_PAGE;
            } else if (key === 'home') {
                top = 0;
            } else if (key === 'end') {
                top = last;
            }
        }
        top = Math.max(0, Math.min(last, top));
    }
}
