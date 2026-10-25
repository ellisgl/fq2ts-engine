// Shared test fixtures: a scripted terminal, ready-made games and worlds,
// and ways to read what ended up on the screen.

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Terminal, type InputEvent, type Key, type MouseInput, type TerminalInput, type TerminalOutput } from "../engine/terminal.ts";
import { HEIGHT, WIDTH, type Screen } from "../engine/screen.ts";
import { World, MAP_WIDTH, MAP_HEIGHT, type GameMap, type MapKind } from "../engine/world.ts";
import { Game, readConfig, type Config, type Content } from "../engine/game.ts";
import { readMonsterTable, type MonsterTable } from "../engine/combat.ts";
import { Saves } from "../engine/saves.ts";
import { ScriptContext } from "../engine/script.ts";
import type { FlagRecord, Player } from "../engine/player.ts";
import content from "../content/index.ts";
import { start, type Flags } from "../content/start.ts";

const ROOT = join(import.meta.dir, "..");

// ---- Terminal

export class FakeInput extends EventEmitter implements TerminalInput {
  isTTY = true;
  rawMode: boolean | null = null;
  paused = true;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
}

export class FakeOutput extends EventEmitter implements TerminalOutput {
  isTTY = true;
  columns = WIDTH;
  rows = HEIGHT;
  written = "";
  write(data: string): void {
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
  readonly out: FakeOutput;
  private readonly steps: Step[];
  private readonly fallback: Key | undefined;

  constructor(steps: readonly Step[] = [], { fallback }: { fallback?: Key } = {}) {
    const output = new FakeOutput();
    super({ input: new FakeInput(), output });
    this.out = output;
    this.steps = [...steps];
    this.fallback = fallback;
  }

  get remaining(): number {
    return this.steps.length;
  }

  feed(...steps: Step[]): void {
    this.steps.push(...steps);
  }

  override event(): Promise<InputEvent>;
  override event(timeout: number): Promise<InputEvent | null>;
  override event(): Promise<InputEvent | null> {
    const step = this.steps.shift();
    if (step === undefined) {
      if (this.fallback !== undefined) return Promise.resolve(this.fallback);
      return Promise.reject(new Error("The test ran out of keys."));
    }
    return Promise.resolve(typeof step === "function" ? step() : step);
  }

  // Keys are scripted, so there is no typing ahead to throw away.
  override drain(): void {}

  override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

// The keys that type `text` and press Enter.
export const typed = (text: string): Key[] => [...text, "enter"];

// ---- Reading the screen

export function row(screen: Screen, y: number): string {
  let line = "";
  for (let x = 1; x <= WIDTH; x++) line += screen.cell(x, y).ch;
  return line.trimEnd();
}

export function screenText(screen: Screen): string {
  return Array.from({ length: HEIGHT }, (_, i) => row(screen, i + 1)).join("\n");
}

// ---- Data

export function readData(file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, "data", file), "utf8"));
}

export const config: Config = readConfig(readData("config.json"));
export const monsterTable: MonsterTable = readMonsterTable(readData("monsters.json"));

let realWorld: World | null = null;
export function gameWorld(): World {
  realWorld ??= World.load(join(ROOT, "data", "maps"));
  return realWorld;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fq2-test-"));
}

// A plain screen: blank tiles, white on green, nothing solid except the
// listed "x,y" cells.
export function makeMap(screen: number, kind: MapKind = 1, solid: readonly string[] = []): GameMap {
  const rows = <T>(cell: (x: number, y: number) => T): T[][] =>
    Array.from({ length: MAP_HEIGHT }, (_, y) => Array.from({ length: MAP_WIDTH }, (_, x) => cell(x + 1, y + 1)));
  return {
    screen,
    kind,
    tiles: rows(() => " "),
    fg: rows(() => 15),
    bg: rows(() => 2),
    solid: rows((x, y) => solid.includes(`${x},${y}`)),
  };
}

export function makeWorld(...maps: GameMap[]): World {
  return new World(new Map(maps.map((m) => [m.screen, m])));
}

// ---- Games

export function newPlayer(changes: Partial<Player<Flags>> = {}, flags: Partial<Flags> = {}): Player<Flags> {
  const player = { ...structuredClone(start), ...changes };
  player.flags = { ...player.flags, ...flags };
  return player;
}

interface GameSetup<F extends FlagRecord> {
  steps?: readonly Step[];
  fallback?: Key;
  player?: Player<F>;
  world?: World;
  saves?: Saves;
  debug?: boolean;
  monsters?: MonsterTable;
}

export function makeGameWith<F extends FlagRecord>(
  gameContent: Content<F>,
  { steps = [], fallback, player, world, saves, debug = false, monsters = monsterTable }: GameSetup<F> = {},
): { game: Game<F>; term: FakeTerminal } {
  const term = new FakeTerminal(steps, fallback === undefined ? {} : { fallback });
  const game = new Game({
    term,
    world: world ?? gameWorld(),
    config,
    monsters,
    content: gameContent,
    saves: saves ?? new Saves(tempDir()),
    debug,
    ...(player ? { player } : {}),
  });
  return { game, term };
}

// The real game, with a player already in it.
export function makeGame(setup: GameSetup<Flags> = {}): { game: Game<Flags>; term: FakeTerminal } {
  return makeGameWith(content, { player: newPlayer(), ...setup });
}

// A script context in the real game: what content scripts get as `g`.
export function scriptContext(setup: GameSetup<Flags> = {}): { g: ScriptContext<Flags>; game: Game<Flags>; term: FakeTerminal } {
  const { game, term } = makeGame(setup);
  return { g: new ScriptContext(game), game, term };
}

// The keys that pick option `i` in a choice list.
export const pick = (i: number): Key[] => [...Array.from({ length: i }, () => "down"), "enter"];

// A trigger in the real game's screens table.
export function trigger(screen: number, x: number, y: number): (g: ScriptContext<Flags>) => void | Promise<void> {
  const script = content.screens[screen]?.at?.[`${x},${y}`];
  if (!script) throw new Error(`No trigger at ${x},${y} on screen ${screen}.`);
  return script;
}

// Mouse input at (x, y): a left press unless told otherwise.
export function mouse(x: number, y: number, changes: Partial<MouseInput> = {}): MouseInput {
  return { type: "mouse", action: "press", button: "left", x, y, shift: false, alt: false, ctrl: false, ...changes };
}
