// Tools for testing games made with the engine: a terminal that plays back
// scripted keys instead of reading the keyboard, ways to read what's on the
// screen, and small ready-made maps, worlds and monsters.

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Disconnected, Terminal, type InputEvent, type Key, type MouseInput, type TerminalInput, type TerminalOutput } from './terminal.ts';
import { DEFAULT_SIZE, type Screen, type ScreenSize } from './screen.ts';
import { MAP_SIZE, World, sizeOf, type GameMap, type MapKind, type MapSize } from './world.ts';
import type { Attack, Monster } from './combat.ts';

// ---- Terminal

export class FakeInput extends EventEmitter implements TerminalInput {
    public isTTY = true;
    public rawMode: boolean | null = null;
    public paused = true;
    public setRawMode(mode: boolean): void {
        this.rawMode = mode;
    }
    public resume(): void {
        this.paused = false;
    }
    public pause(): void {
        this.paused = true;
    }
}

export class FakeOutput extends EventEmitter implements TerminalOutput {
    public isTTY = true;
    public columns: number;
    public rows: number;
    public constructor({ width, height }: ScreenSize = DEFAULT_SIZE) {
        super();
        this.columns = width;
        this.rows = height;
    }
    public written = '';
    public write(data: string): void {
        this.written += data;
    }
}

// One scripted step: a key press or mouse input, a timeout running out
// (null), or a function that runs at that moment and then returns one of
// those.
export type Step = InputEvent | null | (() => InputEvent | null);

// A terminal that plays back a list of steps instead of reading the
// keyboard. Sleeps return at once. Running out of steps is an error
// (unless there is a fallback key), so a test can't hang waiting for input.
export class FakeTerminal extends Terminal {
    // What the terminal has written.
    public readonly out: FakeOutput;
    private readonly steps: Step[];
    private readonly fallback: Key | undefined;

    // `size` is the game's screen (Config.screen; by default 80x25).
    public constructor(steps: readonly Step[] = [], { fallback, size = DEFAULT_SIZE }: { fallback?: Key; size?: ScreenSize } = {}) {
        const output = new FakeOutput(size);
        super({ input: new FakeInput(), output, size });
        this.out = output;
        this.steps = [...steps];
        this.fallback = fallback;
    }

    public get remaining(): number {
        return this.steps.length;
    }

    public feed(...steps: Step[]): void {
        this.steps.push(...steps);
    }

    public override event(): Promise<InputEvent>;
    public override event(timeout: number): Promise<InputEvent | null>;
    public override event(): Promise<InputEvent | null> {
        if (this.disconnected) {
            return Promise.reject(new Disconnected());
        }

        const step = this.steps.shift();
        if (step === undefined) {
            if (this.fallback !== undefined) {
                return Promise.resolve(this.fallback);
            }
            return Promise.reject(new Error('The test ran out of keys.'));
        }
        const event = typeof step === 'function' ? step() : step;
        if (event !== null) {
            this.noteInput();
        }

        return Promise.resolve(event);
    }

    // Keys are scripted, so there is no typing ahead to throw away.
    public override drain(): void {}

    public override sleep(): Promise<void> {
        return Promise.resolve();
    }
}

// The keys that type `text` and press Enter.
export const typed = (text: string): Key[] => [...text, 'enter'];

// ---- Reading the screen

export function row(screen: Screen, y: number): string {
    let line = '';
    for (let x = 1; x <= screen.width; x++) {
        line += screen.cell(x, y).ch;
    }
    return line.trimEnd();
}

export function screenText(screen: Screen): string {
    return Array.from({ length: screen.height }, (_, i) => row(screen, i + 1)).join('\n');
}

// ---- Files and worlds

export function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'fq2-test-'));
}

// A plain screen (79x22 unless told): blank grass, white on green, nothing
// solid except the listed "x,y" cells.
export function makeMap(screen: number, kind: MapKind = 1, solid: readonly string[] = [], { width, height }: MapSize = MAP_SIZE): GameMap {
    const rows = <T>(cell: (x: number, y: number) => T): T[][] =>
        Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => cell(x + 1, y + 1)));
    return {
        screen,
        name: '',
        kind,
        tiles: rows(() => ' '),
        fg: rows(() => 15),
        bg: rows(() => 2),
        solid: rows((x, y) => solid.includes(`${x},${y}`)),
        terrain: rows(() => 'grass'),
    };
}

// A world of these screens, the size of the first (79x22 with none).
export function makeWorld(...maps: GameMap[]): World {
    return new World(new Map(maps.map((m) => [m.screen, m])), maps[0] ? sizeOf(maps[0]) : MAP_SIZE);
}

// The keys that pick option `i` in a choice list.
export const pick = (i: number): Key[] => [...Array.from({ length: i }, () => 'down'), 'enter'];

// Mouse input at (x, y): a left press unless told otherwise.
export function mouse(x: number, y: number, changes: Partial<MouseInput> = {}): MouseInput {
    return { type: 'mouse', action: 'press', button: 'left', x, y, shift: false, alt: false, ctrl: false, ...changes };
}

// A monster for tests: one attack, no defence, unless told otherwise.
export function monster(changes: Partial<Monster> & { attack?: number } = {}): Monster {
    const { attack, ...rest } = changes;
    const attacks: Attack[] = [{ text: 'hits you', power: attack ?? 15 }];

    return { name: 'Frog', says: 'Ribbit!', pronoun: 'it', hp: 15, defense: 0, gold: 15, exp: 11, attacks, kill: '', after: {}, ...rest };
}

// The error a promise fails with, once it has (undefined if it doesn't fail).
export async function caught(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }

    return undefined;
}
