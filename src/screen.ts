// An 80x25 grid of coloured character cells, drawn to the terminal by
// sending only the cells that changed since the last flush.
//
// Coordinates are 1-based (x = column 1-80, y = row 1-25) to match the game
// data. Colours are the 16 CGA colours; backgrounds use the first 8.

import { at } from "./assert.ts";

export const WIDTH = 80;
export const HEIGHT = 25;

export const COLORS = [
  "black", "blue", "green", "cyan", "red", "magenta", "brown", "gray",
  "darkgray", "lightblue", "lightgreen", "lightcyan", "lightred", "lightmagenta", "yellow", "white",
] as const;

export type ColorName = (typeof COLORS)[number];

// A CGA colour number, 0-15.
export type Color = number;

export interface Cell {
  ch: string;
  fg: Color;
  bg: Color;
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
const trueColor = process.env["FQ2_COLORS"] !== "16";

function sgr(fg: Color, bg: Color, blink: number): string {
  const b = blink ? ";5" : "";
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
  private readonly fg: Uint8Array;
  private readonly bg: Uint8Array;
  private readonly blink: Uint8Array;
  private readonly shown: (string | null)[];
  cursor: Point | null = null; // when the terminal cursor should be visible

  constructor() {
    const size = WIDTH * HEIGHT;
    this.chars = new Array<string>(size).fill(" ");
    this.fg = new Uint8Array(size).fill(7);
    this.bg = new Uint8Array(size).fill(0);
    this.blink = new Uint8Array(size);
    this.shown = new Array<string | null>(size).fill(null);
  }

  inside(x: number, y: number): boolean {
    return x >= 1 && x <= WIDTH && y >= 1 && y <= HEIGHT;
  }

  private index(x: number, y: number): number {
    return (y - 1) * WIDTH + (x - 1);
  }

  put(x: number, y: number, ch: string, fg: Color, bg: Color, blink = false): void {
    if (!this.inside(x, y)) return;
    const i = this.index(x, y);
    this.chars[i] = ch;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.blink[i] = blink ? 1 : 0;
  }

  // Writes a plain string in one colour, clipped to the screen.
  text(x: number, y: number, str: string, fg: Color, bg: Color): void {
    for (const ch of str) this.put(x++, y, ch, fg, bg);
  }

  cell(x: number, y: number): Cell {
    const i = this.index(x, y);
    return { ch: at(this.chars, i), fg: at(this.fg, i), bg: at(this.bg, i), blink: !!at(this.blink, i) };
  }

  fillRow(y: number, bg: Color = 0, fg: Color = 7): void {
    for (let x = 1; x <= WIDTH; x++) this.put(x, y, " ", fg, bg);
  }

  clear(bg: Color = 0): void {
    for (let y = 1; y <= HEIGHT; y++) this.fillRow(y, bg);
  }

  invalidate(): void {
    this.shown.fill(null);
  }

  private style(i: number): string {
    return sgr(at(this.fg, i), at(this.bg, i), at(this.blink, i));
  }

  // The escape sequence that brings the terminal up to date.
  render(): string {
    let out = "";
    let last = "";
    let pos = -1;
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const ch = at(this.chars, i);
      const key = `${ch}${at(this.fg, i)},${at(this.bg, i)},${at(this.blink, i)}`;
      if (this.shown[i] === key) continue;
      this.shown[i] = key;
      if (pos !== i) out += `\x1b[${Math.floor(i / WIDTH) + 1};${(i % WIDTH) + 1}H`;
      const style = this.style(i);
      if (style !== last) out += last = style;
      out += ch;
      // Never rely on the terminal's own wrapping at the right margin.
      pos = (i + 1) % WIDTH === 0 ? -1 : i + 1;
    }
    if (out) out += "\x1b[0m";
    if (this.cursor) out += `\x1b[${this.cursor.y};${this.cursor.x}H\x1b[?25h`;
    else out += "\x1b[?25l";
    return out;
  }

  // The visible part of the screen as coloured text, for leaving the final
  // screen (the credits) in the terminal after the game exits.
  dump(): string {
    const lines: string[] = [];
    for (let y = 1; y <= HEIGHT; y++) {
      let end = WIDTH;
      while (end > 0 && at(this.chars, this.index(end, y)) === " " && at(this.bg, this.index(end, y)) === 0) end--;
      let line = "";
      let last = "";
      for (let x = 1; x <= end; x++) {
        const i = this.index(x, y);
        const style = this.style(i);
        if (style !== last) line += last = style;
        line += at(this.chars, i);
      }
      lines.push(line + (line ? "\x1b[0m" : ""));
    }
    while (lines.length && !lines.at(-1)) lines.pop();
    return lines.join("\n");
  }
}
