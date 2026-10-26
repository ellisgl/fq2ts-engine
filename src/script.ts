// The API that content scripts get as `g`.
//
// A script is `async (g) => { ... }`. It can read and change the player
// (g.hp, g.gold, g.flags ...), their items (give, take, equip, use ...),
// talk to the player (write, print, choice, input, key), run shops (buy,
// sell) and move them (moveTo, goto).
//
// After a script finishes, the game redraws the map if the script took over
// the screen (cls/print), and travels if it called goto().

import { draw } from './text.ts';
import { at } from './assert.ts';
import { STATUS_ROW, askText, choose, scrollText, statusBar, textInput } from './ui.ts';
import { cellCount } from './chars.ts';
import { fight, type FightResult, type Monster } from './combat.ts';
import { HEIGHT, type Screen } from './screen.ts';
import type { Key, Terminal } from './terminal.ts';
import { equipped, type FlagRecord, type Player, type Sex, type Slot } from './player.ts';
import { count, effectOf, equip, gearOf, give, take, wear, type ItemDef } from './items.ts';
import { buyMenu, sellMenu, type BuyOptions, type SellOptions } from './shop.ts';
import type { Game } from './game.ts';
import type { WorldRecord } from './shared.ts';

// An option in g.choice: its text, or its text and whether to show it.
export type Choice = string | { text: string; show: boolean };

export type Script<F extends FlagRecord, W extends WorldRecord = WorldRecord> = (g: ScriptContext<F, W>) => void | Promise<void>;

export interface Destination {
    screen: number;
    x: number;
    y: number;
}

export type Path = readonly (readonly [number, number])[];

const clampStat = (value: number): number => Math.max(0, Math.trunc(value));

export class ScriptContext<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    private readonly game: Game<F, W>;
    private readonly term: Terminal;
    private readonly screen: Screen;
    private printRow = 1;
    public tookScreen = false;
    public destination: Destination | null = null;

    public constructor(game: Game<F, W>) {
        this.game = game;
        this.term = game.term;
        this.screen = game.term.screen;
    }

    private get player(): Player<F> {
        return this.game.playing;
    }

    public get name(): string {
        return this.player.name;
    }

    public set name(value: string) {
        this.player.name = value.trim();
    }

    public get sex(): Sex {
        return this.player.sex;
    }

    public set sex(value: Sex) {
        this.player.sex = value;
    }

    // One of two words, by the player's sex: g.bySex('boy', 'girl').
    public bySex(male: string, female: string): string {
        return this.player.sex === 'male' ? male : female;
    }

    public get version(): string {
        return `${this.game.config.version} ${this.game.config.revision}`;
    }

    public get hp(): number {
        return this.player.hp;
    }
    public set hp(value: number) {
        this.player.hp = Math.max(0, Math.min(Math.trunc(value), this.player.maxHp));
    }
    public get maxHp(): number {
        return this.player.maxHp;
    }
    public set maxHp(value: number) {
        this.player.maxHp = Math.max(1, Math.trunc(value));
    }
    public get gold(): number {
        return this.player.gold;
    }
    public set gold(value: number) {
        this.player.gold = clampStat(value);
    }
    public get strength(): number {
        return this.player.strength;
    }
    public set strength(value: number) {
        this.player.strength = clampStat(value);
    }
    public get defense(): number {
        return this.player.defense;
    }
    public set defense(value: number) {
        this.player.defense = clampStat(value);
    }
    public get exp(): number {
        return this.player.exp;
    }
    public set exp(value: number) {
        this.player.exp = clampStat(value);
    }
    // ---- Items

    // The equipped weapon and armour, if any.
    public get weapon(): ItemDef | null {
        return equipped(this.player, 'weapon', this.game.items);
    }
    public get armour(): ItemDef | null {
        return equipped(this.player, 'armour', this.game.items);
    }

    // What the player carries, in catalogue order.
    public get inventory(): { item: ItemDef; count: number }[] {
        return this.game.items
            .all()
            .map((item) => ({ item, count: count(this.player, item.id) }))
            .filter((entry) => entry.count > 0);
    }

    // An item from the catalogue.
    public item(id: string): ItemDef {
        return this.game.items.get(id);
    }

    public count(id: string): number {
        this.item(id);
        return count(this.player, id);
    }

    public has(id: string, n = 1): boolean {
        return this.count(id) >= n;
    }

    public give(id: string, n = 1): void {
        give(this.player, id, n, this.game.items);
    }

    // Takes n of an item if the player has that many; returns whether it did.
    public take(id: string, n = 1): boolean {
        this.item(id);
        return take(this.player, id, n);
    }

    public equip(id: string): void {
        equip(this.player, id, this.game.items);
    }

    public unequip(slot: Slot): void {
        this.player[slot] = null;
    }

    // Uses up one of a usable item and applies its effect. Returns the item's
    // message.
    public use(id: string): string {
        const item = this.item(id);
        if (item.kind !== 'usable') {
            throw new RangeError(`${item.name} can't be used.`);
        }
        if (!this.take(id)) {
            throw new RangeError(`The player doesn't have ${item.name}.`);
        }
        const effect = effectOf(item);
        this.maxHp += effect.maxHp;
        this.hp += effect.heal;
        this.strength += effect.strength;
        this.defense += effect.defense;
        return item.useText;
    }

    // A shop's menu of items to buy. Returns the id of the item bought, if any.
    public buy(ids: readonly string[], options: BuyOptions = {}): Promise<string | null> {
        return buyMenu(this, ids, options);
    }

    // A menu of the player's items to sell. Returns the id sold, if any.
    public sell(options: SellOptions = {}): Promise<string | null> {
        return sellMenu(this, options);
    }
    // What belongs to the world, not the player (see Content.world): on a
    // server, everyone shares it. Lists can't be changed in place; set a
    // new one.
    public get world(): W {
        return this.game.worldState;
    }

    // A line of news, for everyone (a server's daily news, D). It's markup:
    // escape anything a player typed (escapeMarkup). In single-player,
    // there's no news, and it goes nowhere.
    public news(text: string): void {
        this.game.news(text);
    }

    public get flags(): F {
        return this.player.flags;
    }
    public get x(): number {
        return this.player.x;
    }
    public get y(): number {
        return this.player.y;
    }
    public get screenNumber(): number {
        return this.player.screen;
    }

    // The script is drawing a screen of its own over the map.
    private takeScreen(): void {
        this.tookScreen = true;
        this.game.leaveMap();
    }

    // ---- Talking to the player

    // A message in the status bar for a few seconds.
    public write(text: string): void {
        this.game.message(text);
    }

    public cls(): void {
        this.screen.clear();
        this.printRow = 1;
        this.takeScreen();
    }

    // Prints lines of markup from the current print row downwards.
    public print(...lines: string[]): void {
        this.takeScreen();
        for (const line of lines) {
            const end = draw(this.screen, line, { y: this.printRow });
            this.printRow = Math.min(end.y + 1, HEIGHT);
        }
    }

    // Draws markup over the map without taking over the screen. The text is
    // expected to position itself with {x} and {y}.
    public overlay(text: string): void {
        draw(this.screen, text);
    }

    public async key(): Promise<Key> {
        this.term.drain();
        return this.term.key();
    }

    // Lets the player pick one of `options` (shown below the printed text).
    // Options with show: false are left out, but the result is still the
    // picked option's index among all of them (so it doesn't depend on
    // which were shown). Returns -1 if they pressed Escape.
    public async choice(options: readonly Choice[]): Promise<number> {
        const all = options.map((option, i) => (typeof option === 'string' ? { text: option, show: true, i } : { ...option, i }));
        const shown = all.filter((option) => option.show);
        if (!shown.length) {
            return -1;
        }

        this.takeScreen();
        const y = this.printRow;
        this.printRow = Math.min(y + shown.length, HEIGHT);
        const picked = await choose(this.term, shown.map((option) => option.text), { y });
        return shown[picked]?.i ?? -1;
    }

    // Shows lines of text in a full-screen window that scrolls.
    public async scroll(lines: readonly string[], title = ''): Promise<void> {
        this.takeScreen();
        await scrollText(this.term, lines, { title });
    }

    public async input({ x, y, length }: { x: number; y: number; length: number }): Promise<string> {
        return textInput(this.term, { x, y, length });
    }

    // Like input, but Escape cancels it: null.
    public async ask({ x, y, length }: { x: number; y: number; length: number }): Promise<string | null> {
        return askText(this.term, { x, y, length });
    }

    // A question on the status bar, leaving the map as it is (for talking,
    // say): the answer, or null on Escape. The status bar comes back after.
    public async askLine(question: string, length = 60): Promise<string | null> {
        const { screen } = this.term;
        statusBar(screen, '');
        draw(screen, `{white}${question}`, { x: 3, y: STATUS_ROW, bg: 1, wrap: false });
        const x = 3 + cellCount(question) + 1;
        const answer = await askText(this.term, { x, y: STATUS_ROW, length: Math.max(1, Math.min(length + 1, 78 - x)), fg: 15, bg: 1 });
        this.game.showStatus();
        return answer;
    }

    // Asks for a whole number (anything else counts as 0).
    public async number(where: { x: number; y: number; length: number }): Promise<number> {
        return Math.trunc(Number(await this.input(where))) || 0;
    }

    public sleep(seconds: number): Promise<void> {
        return this.term.sleep(seconds);
    }

    // ---- Moving the player

    // Puts the player somewhere else on this screen.
    public moveTo(x: number, y: number): void {
        this.game.placePlayer(x, y);
    }

    // Sends the player to another screen once the script is done.
    public goto(screen: number, x: number, y: number): void {
        this.destination = { screen, x, y };
    }

    // ---- Game rules

    // A whole number from 1 to n.
    public random(n: number): number {
        return Math.floor(Math.random() * n) + 1;
    }

    public healFull(): void {
        this.player.hp = this.player.maxHp;
    }

    // Takes gold if the player has enough; otherwise says so and returns false.
    public async spend(amount: number): Promise<boolean> {
        if (this.player.gold >= amount) {
            this.player.gold -= amount;
            return true;
        }
        this.cls();
        this.print(
            "{green}Your funds aren't exactly what they used to be...",
            '{green}You decide to pass up this glorious opportunity to spend money...',
            '',
            '{red}Press a key...',
        );
        await this.key();
        return false;
    }

    // A monster from data/monsters.json.
    public monster(id: string): Monster {
        return this.game.monsters.monster(id);
    }

    // Fights a monster with the player's gear, which may break. The
    // monster's after-fight hook, if any, runs before this returns.
    public async fight(monster: Monster): Promise<FightResult> {
        const result = await fight(this.term, this.player, gearOf(this.player, this.game.items), monster, { superhumanFactor: this.game.config.superhumanFactor });
        for (const message of wear(this.player, this.game.items)) {
            this.write(message);
        }
        await this.game.afterFight(monster, result)?.(this);
        return result;
    }

    // Moves whatever is drawn at path[0] along the path, pausing `delay`
    // seconds before each step. The map is restored behind it.
    public async animate(delay: number, path: Path): Promise<void> {
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
