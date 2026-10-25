// The API that content scripts get as `g`.
//
// A script is `async (g) => { ... }`. It can read and change the player
// (g.hp, g.gold, g.weapon, g.flags ...), talk to the player (write, print,
// choice, input, key) and move them (moveTo, goto).
//
// After a script finishes, the game redraws the map if the script took over
// the screen (cls/print), and travels if it called goto().

import { draw } from "./text.ts";
import { at } from "./assert.ts";
import { choose, textInput } from "./ui.ts";
import { fight, type FightResult, type Monster } from "./combat.ts";
import { HEIGHT, type Screen } from "./screen.ts";
import type { Key, Terminal } from "./terminal.ts";
import type { FlagRecord, Item, Player } from "./player.ts";
import type { Game } from "./game.ts";

export type Script<F extends FlagRecord> = (g: ScriptContext<F>) => void | Promise<void>;

export interface Destination {
  screen: number;
  x: number;
  y: number;
}

export type Path = readonly (readonly [number, number])[];

const clampStat = (value: number): number => Math.max(0, Math.trunc(value));

export class ScriptContext<F extends FlagRecord> {
  private readonly game: Game<F>;
  private readonly term: Terminal;
  private readonly screen: Screen;
  private printRow = 1;
  tookScreen = false;
  destination: Destination | null = null;

  constructor(game: Game<F>) {
    this.game = game;
    this.term = game.term;
    this.screen = game.term.screen;
  }

  private get player(): Player<F> {
    return this.game.playing;
  }

  get version(): string {
    return `${this.game.config.version} ${this.game.config.revision}`;
  }

  get hp(): number {
    return this.player.hp;
  }
  set hp(value: number) {
    this.player.hp = Math.max(0, Math.min(Math.trunc(value), this.player.maxHp));
  }
  get maxHp(): number {
    return this.player.maxHp;
  }
  set maxHp(value: number) {
    this.player.maxHp = Math.max(1, Math.trunc(value));
  }
  get gold(): number {
    return this.player.gold;
  }
  set gold(value: number) {
    this.player.gold = clampStat(value);
  }
  get strength(): number {
    return this.player.strength;
  }
  set strength(value: number) {
    this.player.strength = clampStat(value);
  }
  get defense(): number {
    return this.player.defense;
  }
  set defense(value: number) {
    this.player.defense = clampStat(value);
  }
  get exp(): number {
    return this.player.exp;
  }
  set exp(value: number) {
    this.player.exp = clampStat(value);
  }
  get weapon(): Item {
    return this.player.weapon;
  }
  set weapon(value: Item) {
    this.player.weapon = value;
  }
  get armour(): Item {
    return this.player.armour;
  }
  set armour(value: Item) {
    this.player.armour = value;
  }
  get flags(): F {
    return this.player.flags;
  }
  get x(): number {
    return this.player.x;
  }
  get y(): number {
    return this.player.y;
  }
  get screenNumber(): number {
    return this.player.screen;
  }

  // ---- Talking to the player

  // A message in the status bar for a few seconds.
  write(text: string): void {
    this.game.message(text);
  }

  cls(): void {
    this.screen.clear();
    this.printRow = 1;
    this.tookScreen = true;
  }

  // Prints lines of markup from the current print row downwards.
  print(...lines: string[]): void {
    this.tookScreen = true;
    for (const line of lines) {
      const end = draw(this.screen, line, { y: this.printRow });
      this.printRow = Math.min(end.y + 1, HEIGHT);
    }
  }

  // Draws markup over the map without taking over the screen. The text is
  // expected to position itself with {x} and {y}.
  overlay(text: string): void {
    draw(this.screen, text);
  }

  async key(): Promise<Key> {
    this.term.drain();
    return this.term.key();
  }

  // Lets the player pick one of `options` (shown below the printed text).
  // Returns the index, or -1 if they pressed Escape.
  async choice(options: readonly string[]): Promise<number> {
    this.tookScreen = true;
    const y = this.printRow;
    this.printRow = Math.min(y + options.length, HEIGHT);
    return choose(this.term, options, { y });
  }

  async input({ x, y, length }: { x: number; y: number; length: number }): Promise<string> {
    return textInput(this.term, { x, y, length });
  }

  // Asks for a whole number (anything else counts as 0).
  async number(where: { x: number; y: number; length: number }): Promise<number> {
    return Math.trunc(Number(await this.input(where))) || 0;
  }

  sleep(seconds: number): Promise<void> {
    return this.term.sleep(seconds);
  }

  // ---- Moving the player

  // Puts the player somewhere else on this screen.
  moveTo(x: number, y: number): void {
    this.game.placePlayer(x, y);
  }

  // Sends the player to another screen once the script is done.
  goto(screen: number, x: number, y: number): void {
    this.destination = { screen, x, y };
  }

  // ---- Game rules

  // A whole number from 1 to n.
  random(n: number): number {
    return Math.floor(Math.random() * n) + 1;
  }

  healFull(): void {
    this.player.hp = this.player.maxHp;
  }

  // Takes gold if the player has enough; otherwise says so and returns false.
  async spend(amount: number): Promise<boolean> {
    if (this.player.gold >= amount) {
      this.player.gold -= amount;
      return true;
    }
    this.cls();
    this.print(
      "{green}Your funds aren't exactly what they used to be...",
      "{green}You decide to pass up this glorious opportunity to spend money...",
      "",
      "{red}Press a key...",
    );
    await this.key();
    return false;
  }

  async fight(monster: Monster): Promise<FightResult> {
    return fight(this.term, this.player, monster, { superhumanFactor: this.game.config.superhumanFactor });
  }

  // Moves whatever is drawn at path[0] along the path, pausing `delay`
  // seconds before each step. The map is restored behind it.
  async animate(delay: number, path: Path): Promise<void> {
    let [x, y] = at(path, 0);
    const sprite = this.screen.cell(x, y);
    for (const [nx, ny] of path.slice(1)) {
      await this.sleep(delay);
      this.game.drawTile(x, y);
      this.screen.put(nx, ny, sprite.ch, sprite.fg, sprite.bg, sprite.blink);
      [x, y] = [nx, ny];
    }
  }
}
