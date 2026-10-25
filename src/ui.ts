// Reusable screen widgets: the status bar, menus and text entry.

import { draw, width } from "./text.ts";
import { at } from "./assert.ts";
import { WIDTH, type Color, type Screen } from "./screen.ts";
import { isMouse, type Terminal } from "./terminal.ts";

const BLUE = 1;
const WHITE = 15;

// The bar on row 23: shaded ends and centred white-on-blue text.
export function statusBar(screen: Screen, text: string): void {
  const y = 23;
  for (let x = 1; x <= 79; x++) screen.put(x, y, " ", WHITE, BLUE);
  screen.text(1, y, "░▒", BLUE, 0);
  screen.text(78, y, "▒░", BLUE, 0);
  draw(screen, `{center}${text}`, { y, fg: WHITE, bg: BLUE });
}

// A vertical list of options starting at row `y`. Returns the chosen index,
// or -1 when Escape is pressed. With the mouse on, clicking an option picks
// it and the wheel moves the highlight.
export async function choose(
  term: Terminal,
  options: readonly string[],
  { y, x = 1, selected = 0 }: { y: number; x?: number; selected?: number },
): Promise<number> {
  const { screen } = term;
  const plain = (i: number): string => at(options, i).replace(/\{[^}]*\}/g, "");
  for (;;) {
    options.forEach((option, i) => {
      draw(screen, option, { x, y: y + i, fg: WHITE, bg: i === selected ? BLUE : 0 });
    });
    screen.cursor = { x: x + [...plain(selected)].length, y: y + selected };
    const key = await term.event();
    screen.cursor = null;
    if (isMouse(key)) {
      const i = key.y - y;
      const option = options[i];
      if (key.action === "press" && key.button === "left" && option !== undefined && key.x >= x && key.x < x + Math.max(1, width(option))) return i;
      if (key.action === "wheel") selected = (selected + (key.button === "up" ? options.length - 1 : 1)) % options.length;
      continue;
    }
    if (key === "enter") return selected;
    if (key === "escape") return -1;
    if (key === "up" || key === "left") selected = (selected + options.length - 1) % options.length;
    if (key === "down" || key === "right") selected = (selected + 1) % options.length;
  }
}

export interface TextInputOptions {
  x: number;
  y: number;
  length: number;
  value?: string;
  fg?: Color;
  bg?: Color;
  filter?: (ch: string) => boolean;
}

// A one-line text box. `length` includes the cursor cell, as in the
// original. Escape and Enter both finish.
export async function textInput(
  term: Terminal,
  { x, y, length, value = "", fg = WHITE, bg = BLUE, filter = () => true }: TextInputOptions,
): Promise<string> {
  const { screen } = term;
  const max = Math.max(0, length - 1);
  for (;;) {
    screen.text(x, y, value.padEnd(length).slice(0, Math.max(length, value.length)), fg, bg);
    screen.cursor = { x: Math.min(x + value.length, WIDTH), y };
    const key = await term.key();
    if (key === "enter" || key === "escape") break;
    if (key === "backspace") value = value.slice(0, -1);
    else if (key.length === 1 && value.length < max && filter(key)) value += key;
  }
  screen.cursor = null;
  return value;
}

// A prompt followed by a line of input, on a plain screen (debug editor).
export async function prompt(term: Terminal, y: number, label: string): Promise<string> {
  const { screen } = term;
  screen.text(1, y, label, 7, 0);
  return (await textInput(term, { x: label.length + 1, y, length: 30, fg: 7, bg: 0 })).trim();
}
