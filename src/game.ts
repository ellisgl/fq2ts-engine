// The game: title menu, exploring the world, and the built-in screens.

import { draw } from './text.ts';
import { at } from './assert.ts';
import { statusBar, textInput, prompt, scrollText } from './ui.ts';
import { MAP_WIDTH, MAP_HEIGHT, GRID_WIDTH, GRID_HEIGHT, WILD_TERRAIN, gridPosition, type World } from './world.ts';
import { fight, pickMonster, type Bestiary, type FightResult, type Monster } from './combat.ts';
import { ScriptContext, type Destination, type Script } from './script.ts';
import { SLOTS, type Saves, type SlotInfo } from './saves.ts';
import { restorePlayer, type FlagRecord, type FlagValue, type NumericField, type Player } from './player.ts';
import { gearOf, wear, type ItemCatalogue } from './items.ts';
import { record, string, number, field } from './validate.ts';
import type { Color, Screen } from './screen.ts';
import type { Key, Terminal } from './terminal.ts';

// data/config.json
export interface Config {
    title: string;
    company: string;
    companyShort: string;
    version: string;
    revision: string;
    superhumanFactor: number;
}

export function readConfig(value: unknown, path = 'config.json'): Config {
    const r = record(value, path);
    return {
        title: field(r, 'title', path, string),
        company: field(r, 'company', path, string),
        companyShort: field(r, 'companyShort', path, string),
        version: field(r, 'version', path, string),
        revision: field(r, 'revision', path, string),
        superhumanFactor: field(r, 'superhumanFactor', path, number),
    };
}

// "x,y" on a screen.
export type Coord = `${number},${number}`;

export interface ScreenScripts<F extends FlagRecord> {
    // Runs every time the screen is drawn.
    show?: Script<F>;
    // Runs when the player walks onto or bumps into (x, y), or arrives there
    // from another screen.
    at?: Readonly<Partial<Record<Coord, Script<F>>>>;
}

// Everything that makes a particular game, as opposed to the engine.
export interface Content<F extends FlagRecord> {
    title: {
        art(config: Config): string[];
        menu: {
            // [label, x, y] for each title menu option.
            options: readonly (readonly [string, number, number])[];
            // [foreground, background]
            selectedColor: readonly [Color, Color];
            color: readonly [Color, Color];
        };
    };
    help(config: Config): string[];
    // `frame` is a colour number (1-7) for the shaded border.
    credits(config: Config, frame: number): string[];
    worldMapLegend: readonly string[];
    statusLine(player: Player<F>, config: Config): string;
    // The inventory screen (I). It handles its own keys.
    inventory: Script<F>;
    newGame: Script<F>;
    // The player at the start of a new game.
    start: Player<F>;
    screens: Readonly<Partial<Record<number, ScreenScripts<F>>>>;
    // Scripts that monsters' after-fight hooks (Monster.after) run, by name.
    events?: Readonly<Record<string, Script<F>>>;
    // Brings a loaded save up to date, given the save as it was on disk (for
    // anything restorePlayer can't work out by itself).
    upgradeSave?(saved: unknown, player: Player<F>): void;
}

export interface GameOptions<F extends FlagRecord> {
    term: Terminal;
    world: World;
    config: Config;
    monsters: Bestiary;
    items: ItemCatalogue;
    content: Content<F>;
    saves: Saves;
    debug?: boolean;
    // A game already in progress (otherwise the player starts one from the
    // title menu).
    player?: Player<F>;
}

const MESSAGE_SECONDS = 4;
// How many past messages the back-buffer (B) keeps.
const MESSAGE_LOG = 100;

// The keys while exploring, for ? (the debug ones aren't listed).
const PLAY_HELP = [
    '{white}Arrows {gray}or {white}8 4 6 2  {gray}walk',
    '{white}I {gray}or {white}V        {gray}your stats and inventory',
    '{white}M               {gray}the world map',
    '{white}B               {gray}the last messages (the back-buffer)',
    '{white}R               {gray}redraw the screen',
    '{white}?               {gray}these keys',
    '{white}Esc             {gray}back to the title menu (to save, load or quit)',
];
const SCREENSAVER_SECONDS = 180;
const YELLOW = 14;

type Step = readonly [number, number];

const MOVES: Readonly<Record<Key, Step>> = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    8: [0, -1], 2: [0, 1], 4: [-1, 0], 6: [1, 0],
};

// Typed while exploring. The first letter starts listening for the rest.
const CHEATS = ['HELPME', 'TITANIC', 'QUAKE', 'SDEB'] as const;
type Cheat = (typeof CHEATS)[number];

// World map colours by map kind: [char, fg, bg].
const WORLD_MAP_CELLS: readonly (readonly [string, Color, Color])[] = [
    [' ', 15, 1], [' ', 15, 2], [' ', 15, 1], [' ', 15, 7], ['■', 7, 2],
    [' ', 15, 2], ['■', 7, 2], [' ', 15, 7], [' ', 15, 1],
];

// The fields the debug settings editor asks for, in order.
const SETTINGS: readonly (readonly [string, NumericField])[] = [
    ['Screen #', 'screen'], ['X', 'x'], ['Y', 'y'], ['Experience', 'exp'], ['Hitpoints', 'hp'],
    ['Max Hp', 'maxHp'], ['Strength', 'strength'], ['Defense', 'defense'], ['Gold', 'gold'],
];

export class Game<F extends FlagRecord> {
    public readonly term: Terminal;
    public readonly config: Config;
    public readonly items: ItemCatalogue;
    private readonly screen: Screen;
    private readonly world: World;
    public readonly monsters: Bestiary;
    private readonly content: Content<F>;
    private readonly saves: Saves;
    private readonly debug: boolean;
    private player: Player<F> | null = null;
    private noclip = false;
    private showPosition: boolean;
    private messageText: string | null = null;
    private messageUntil = 0;
    // Messages waiting for the status bar, and every recent one.
    private readonly messageQueue: string[] = [];
    private readonly messageLog: string[] = [];
    // Each key the player presses while exploring starts a new turn.
    // Messages only wait behind others from the same turn.
    private turn = 0;
    private messageTurn = -1;
    private lastInput = Date.now();

    public constructor({ term, world, config, monsters, items, content, saves, debug = false, player }: GameOptions<F>) {
        this.term = term;
        this.screen = term.screen;
        this.world = world;
        this.config = config;
        this.monsters = monsters;

        for (const hook of monsters.hooks()) {
            if (!content.events?.[hook]) {
                throw new Error(`A monster runs the script "${hook}" after a fight, but the content has no such event.`);
            }
        }

        for (const screen of world.screens()) {
            const table = world.encounters(screen);
            if (table !== undefined && !monsters.hasTable(table)) {
                throw new Error(`Screen ${screen} uses the encounter table "${table}", which doesn't exist.`);
            }
        }

        this.items = items;
        // Every item the start player has must exist (get throws if not).
        for (const id of [...Object.keys(content.start.items), content.start.weapon, content.start.armour]) {
            if (id !== null) {
                items.get(id);
            }
        }

        this.content = content;
        this.saves = saves;
        this.debug = debug;
        this.showPosition = debug;
        this.player = player ?? null;
    }

    // The player of the game in progress. Only exploring and scripts use it,
    // and they only run once there is one.
    public get playing(): Player<F> {
        if (!this.player) {
            throw new Error('No game is in progress.');
        }

        return this.player;
    }

    private newPlayer(): Player<F> {
        return structuredClone(this.content.start);
    }

    private script(): ScriptContext<F> {
        return new ScriptContext(this);
    }

    // ---- Title menu

    public async run(): Promise<void> {
        let selected = 0;
        for (;;) {
            const choice = await this.titleMenu(selected);
            selected = choice;
            switch (choice) {
                case 0:
                    await this.newGame();
                    break;
                case 1:
                    await this.saveScreen();
                    break;
                case 2:
                    if (await this.loadScreen()) {
                        await this.play({ arrive: true });
                    }
                    break;
                case 3:
                    await this.help();
                    break;
                case 4:
                    if (this.player) {
                        await this.play();
                    } else {
                        await this.newGame();
                    }
                    break;
                case 5:
                    this.credits();
                    return;
            }
        }
    }

    // Returns the chosen option's index (Escape picks the last one, Leave).
    private async titleMenu(selected: number): Promise<number> {
        const { title } = this.content;
        const { screen } = this;
        const { options, selectedColor, color } = title.menu;
        for (;;) {
            screen.clear();

            for (const line of title.art(this.config)) {
                draw(screen, line);
            }

            if (this.debug) {
                screen.text(1, 25, 'S - Set game settings', 7, 0);
            }

            for (;;) {
                options.forEach(([label, x, y], i) => {
                    const [fg, bg] = i === selected ? selectedColor : color;
                    screen.text(x, y, label, fg, bg);
                });

                const key = await this.term.key();
                if (key === 'enter') {
                    return selected;
                }

                if (key === 'escape') {
                    return options.length - 1;
                }

                if (key === 'up' || key === 'left') {
                    selected = (selected + options.length - 1) % options.length;
                }

                if (key === 'down' || key === 'right') {
                    selected = (selected + 1) % options.length;
                }

                if (this.debug && (key === 's' || key === 'S')) {
                    this.player ??= this.newPlayer();
                    await this.settings();

                    break;
                }
            }
        }
    }

    private async newGame(): Promise<void> {
        this.player = this.newPlayer();
        this.noclip = false;
        this.screen.clear();
        await this.content.newGame(this.script());
        await this.play({ arrive: true });
    }

    private async help(): Promise<void> {
        this.screen.clear();
        for (const line of this.content.help(this.config)) {
            draw(this.screen, line);
        }

        await this.term.key();
    }

    private credits(): void {
        this.screen.clear();
        const frame = Math.floor(Math.random() * 7) + 1;
        for (const line of this.content.credits(this.config, frame)) {
            draw(this.screen, line);
        }
    }

    // ---- Exploring

    private async play({ arrive = false } = {}): Promise<void> {
        this.trackMapScreen();
        await this.redraw();
        this.announce(null);
        if (arrive) {
            await this.arrive();
        }

        let pending: Key | null = null;
        for (;;) {
            const key: Key = pending ?? (await this.waitKey());
            pending = null;
            const upper = key.length === 1 ? key.toUpperCase() : key;

            const step = MOVES[key];
            if (step) {
                await this.move(...step);
                continue;
            }

            if (key === 'escape') {
                return;
            }

            if (upper === 'I' || upper === 'V') {
                await this.inventory();
            } else if (upper === 'M') {
                await this.worldMap();
            } else if (upper === 'B') {
                await this.backBuffer();
            } else if (upper === 'R') {
                this.term.refresh();
            } else if (key === '?') {
                await this.keysHelp();
            } else if (upper === 'S' && this.debug) {
                await this.settingsAndRedraw();
            } else {
                const cheat = CHEATS.find((c) => c.startsWith(upper));
                if (cheat) {
                    pending = await this.cheat(cheat);
                }
            }
        }
    }

    // Waits for a key while keeping the status bar message and the
    // screensaver timers running.
    private async waitKey(): Promise<Key> {
        for (;;) {
            const now = Date.now();
            let timeout = this.lastInput + SCREENSAVER_SECONDS * 1000 - now;
            if (this.messageText) {
                timeout = Math.min(timeout, this.messageUntil - now);
            }

            this.screen.cursor = { x: this.playing.x, y: this.playing.y };
            const key = await this.term.key(timeout);
            this.screen.cursor = null;
            if (key) {
                this.lastInput = Date.now();
                this.newTurn();
                return key;
            }

            if (this.messageText && Date.now() >= this.messageUntil) {
                this.nextMessage();
            }

            if (Date.now() >= this.lastInput + SCREENSAVER_SECONDS * 1000) {
                await this.screensaver();
                this.lastInput = Date.now();
                await this.redraw();
            }
        }
    }

    private async move(dx: number, dy: number): Promise<void> {
        const p = this.playing;
        const x = p.x + dx;
        const y = p.y + dy;
        if (x < 1 || x > MAP_WIDTH || y < 1 || y > MAP_HEIGHT) {
            await this.crossEdge(dx, dy);
        } else {
            const trigger = this.triggerAt(x, y);
            const consumed = trigger ? await this.runScript(trigger) : false;
            if (!consumed && (this.noclip || !this.world.isSolid(p.screen, x, y))) {
                this.placePlayer(x, y);
            }
        }

        await this.encounter();
    }

    private async crossEdge(dx: number, dy: number): Promise<void> {
        const p = this.playing;
        const screen = p.screen + dx + dy * GRID_WIDTH;
        const x = dx < 0 ? MAP_WIDTH : dx > 0 ? 1 : p.x;
        const y = dy < 0 ? MAP_HEIGHT : dy > 0 ? 1 : p.y;
        if (!this.world.has(screen) || (!this.noclip && this.world.isSolid(screen, x, y))) {
            this.message('Something blocks you... choose another way.');
            return;
        }

        await this.travel({ screen, x, y });
    }

    private async travel({ screen, x, y }: Destination): Promise<void> {
        if (!this.world.has(screen)) {
            throw new Error(`Screen ${screen} does not exist.`);
        }

        const from = this.playing.screen;
        Object.assign(this.playing, { screen, x, y });
        this.trackMapScreen();
        await this.redraw();
        this.announce(from);
        await this.arrive();
    }

    // Shows the name of the screen the player is on, unless it's the same as
    // the one they came from.
    private announce(from: number | null): void {
        const name = this.world.name(this.playing.screen);
        if (name && (from === null || this.world.name(from) !== name)) {
            this.message(`{white}${name}`);
        }
    }

    // Arriving on a tile with a trigger runs it.
    private async arrive(): Promise<void> {
        const trigger = this.triggerAt(this.playing.x, this.playing.y);
        if (trigger) {
            await this.runScript(trigger);
        }
    }

    private trackMapScreen(): void {
        const p = this.playing;
        if (this.world.isOutdoors(p.screen)) {
            p.mapScreen = p.screen;
        }
    }

    private triggerAt(x: number, y: number): Script<F> | undefined {
        return this.content.screens[this.playing.screen]?.at?.[`${x},${y}`];
    }

    // Runs a script and deals with what it did. Returns true if the player's
    // step should not go ahead (the script moved them, travelled or used the
    // whole screen).
    private async runScript(script: Script<F>): Promise<boolean> {
        const p = this.playing;
        const before = `${p.screen},${p.x},${p.y}`;
        const g = this.script();
        await script(g);
        if (g.destination) {
            await this.travel(g.destination);
            return true;
        }

        if (g.tookScreen) {
            await this.redraw();
        }

        return g.tookScreen || before !== `${p.screen},${p.x},${p.y}`;
    }

    // A random fight, sometimes, on screens with monsters. Each screen can
    // name its encounter table; the rest use "default".
    private async encounter(): Promise<void> {
        const p = this.playing;
        if (!p.monsters || !this.world.hasMonsters(p.screen)) {
            return;
        }

        if (!WILD_TERRAIN.includes(this.world.terrain(p.screen, p.x, p.y))) {
            return;
        }

        const table = this.monsters.table(this.world.encounters(p.screen) ?? 'default');
        if (Math.floor(Math.random() * table.chance) !== 0) {
            return;
        }

        const monster = pickMonster(table, p.exp);
        const result = await fight(this.term, p, gearOf(p, this.items), monster, { superhumanFactor: this.config.superhumanFactor });
        for (const message of wear(p, this.items)) {
            this.message(message);
        }

        const hook = this.afterFight(monster, result);
        if (hook) {
            await this.runScript(hook);
        }

        if (result === 'lost') {
            await this.redraw();
        } else {
            this.drawStatus();
        }
    }

    // The script a monster runs after a fight that ended this way, if any.
    public afterFight(monster: Monster, result: FightResult): Script<F> | undefined {
        const name = monster.after[result];
        return name === undefined ? undefined : this.content.events?.[name];
    }

    // Listens for the rest of a cheat word. Returns the key that broke it
    // off, if any, so that it isn't lost.
    private async cheat(word: Cheat): Promise<Key | null> {
        for (const letter of word.slice(1)) {
            const key = await this.term.key();
            if (key.length !== 1 || key.toUpperCase() !== letter) {
                return key;
            }
        }

        const p = this.playing;
        switch (word) {
            case 'HELPME':
                p.gold = 0;
                p.maxHp += 25;
                p.hp += 25;
                this.message(`Cheater!!! You got 25 more hitpoints for a total of ${p.hp}.`);
                break;
            case 'TITANIC':
                this.noclip = !this.noclip;
                this.message(`{white}No Clipping Mode ${this.noclip ? 'on' : 'off'}...`);
                break;
            case 'SDEB':
                this.showPosition = !this.showPosition;
                this.message(`{white}Debug Details ${this.showPosition ? 'On' : 'Off'}...`);
                await this.redraw();
                break;
            case 'QUAKE':
                await this.settingsAndRedraw();
                break;
        }

        return null;
    }

    // ---- Drawing the map

    private async redraw(): Promise<void> {
        const { screen } = this;
        screen.clear();
        for (let y = 1; y <= MAP_HEIGHT; y++) {
            for (let x = 1; x <= MAP_WIDTH; x++) {
                this.drawTile(x, y);
            }
        }

        this.drawStatus();
        const show = this.content.screens[this.playing.screen]?.show;
        if (show) {
            await show(this.script());
        }

        this.drawPlayer();
    }

    public drawTile(x: number, y: number): void {
        if (x < 1 || x > MAP_WIDTH || y < 1 || y > MAP_HEIGHT) {
            return;
        }

        const t = this.world.tile(this.playing.screen, x, y);
        this.screen.put(x, y, t.ch, t.fg, t.bg);
    }

    private drawPlayer(): void {
        const p = this.playing;
        this.screen.put(p.x, p.y, '☺', YELLOW, this.screen.cell(p.x, p.y).bg);
        if (this.showPosition) {
            this.screen.text(1, 1, `X:${p.x} Y:${p.y} SCR:${p.screen} ${this.world.terrain(p.screen, p.x, p.y)} `, 7, 0);
        }
    }

    public placePlayer(x: number, y: number): void {
        const p = this.playing;
        this.drawTile(p.x, p.y);
        p.x = x;
        p.y = y;
        this.drawPlayer();
    }

    private drawStatus(): void {
        const text = this.messageText ?? this.content.statusLine(this.playing, this.config);
        statusBar(this.screen, text);
    }

    // Shows a message in the status bar for a few seconds. If another
    // message from this same turn is still showing, this one waits behind
    // it; a message from an earlier turn is simply replaced.
    public message(text: string): void {
        this.messageLog.push(text);
        if (this.messageLog.length > MESSAGE_LOG) {
            this.messageLog.shift();
        }

        if (this.messageText !== null && this.messageTurn === this.turn && Date.now() < this.messageUntil) {
            this.messageQueue.push(text);
            return;
        }

        this.messageQueue.length = 0;
        this.showMessage(text);
    }

    // The player has done something new: from now on, messages replace the
    // ones before them rather than waiting behind them.
    public newTurn(): void {
        this.turn++;
    }

    private showMessage(text: string): void {
        this.messageText = text;
        this.messageTurn = this.turn;
        this.messageUntil = Date.now() + MESSAGE_SECONDS * 1000;
        this.drawStatus();
    }

    // The current message's time is up: show the next, or the status line.
    private nextMessage(): void {
        const next = this.messageQueue.shift();
        if (next === undefined) {
            this.messageText = null;
            this.drawStatus();
        } else {
            this.showMessage(next);
        }
    }

    // ---- Built-in screens

    private async backBuffer(): Promise<void> {
        const lines = this.messageLog.length ? this.messageLog : ['{darkgray}Nothing has happened yet.'];
        await scrollText(this.term, lines, { title: 'Back-buffer: the last messages', from: 'bottom' });
        await this.redraw();
    }

    private async keysHelp(): Promise<void> {
        await scrollText(this.term, PLAY_HELP, { title: 'Keys' });
        await this.redraw();
    }

    private async inventory(): Promise<void> {
        this.screen.clear();
        await this.content.inventory(this.script());
        await this.redraw();
    }

    private async worldMap(): Promise<void> {
        const { screen } = this;
        screen.clear();
        for (let n = 1; n <= GRID_WIDTH * GRID_HEIGHT; n++) {
            const [ch, fg, bg] = at(WORLD_MAP_CELLS, this.world.kind(n) ?? 0);
            const { col, row } = gridPosition(n);
            screen.put(col, row, ch, fg, bg);
        }

        const { col: mx, row: my } = gridPosition(this.playing.mapScreen);
        screen.put(mx, my, '☺', 4, screen.cell(mx, my).bg, true);

        for (const line of this.content.worldMapLegend) {
            draw(screen, line);
        }

        await this.term.key();
        await this.redraw();
    }

    // Shows the save slots under `title` and lets the player pick one that
    // `selectable` allows. Returns null if they press Escape.
    private async pickSlot(title: string, selectable: (slot: SlotInfo) => boolean): Promise<SlotInfo | null> {
        const { screen } = this;
        screen.clear();
        screen.text(30, 9, title, 10, 0);
        screen.text(30, 17, 'Enter a Choice.', 4, 0);
        const slots = this.saves.list();
        let selected = 0;

        for (;;) {
            slots.forEach((s, i) => {
                screen.fillRow(11 + i);
                screen.text(30, 11 + i, `${s.name ?? 'Empty'}...`, i === selected ? 15 : 2, 0);
            });

            const key = await this.term.key();
            if (key === 'escape') {
                return null;
            }

            if (key === 'up') {
                selected = (selected + SLOTS - 1) % SLOTS;
            }
            if (key === 'down') {
                selected = (selected + 1) % SLOTS;
            }

            const slot = at(slots, selected);

            if (key === 'enter' && selectable(slot)) {
                return slot;
            }
        }
    }

    private async saveScreen(): Promise<void> {
        if (!this.player) {
            this.screen.text(25, 24, 'Start or load a game first.', 12, 0);
            await this.term.key();

            return;
        }

        const slot = await this.pickSlot('Save a Game...', () => true);
        if (!slot) {
            return;
        }

        if (slot.name !== null) {
            this.screen.text(1, 1, 'Overwrite Existing Saved Game? Y/N', 2, 0);
            const key = await this.term.key();
            if (key.toUpperCase() !== 'Y') {
                return;
            }

            this.screen.fillRow(1);
        }

        const y = 10 + slot.slot;
        this.screen.fillRow(y);
        // An empty slot suggests the player's name.
        const suggested = slot.name ?? this.player.name.slice(0, 15);
        const name = (await textInput(this.term, { x: 30, y, length: 16, value: suggested, fg: 15, bg: 0 })).trim();
        this.saves.save(slot.slot, name && name !== 'Empty' ? name : 'NoName', this.player);
    }

    private async loadScreen(): Promise<boolean> {
        const slot = await this.pickSlot('Load a Game...', (s) => s.name !== null);
        if (!slot) {
            return false;
        }

        let player;
        try {
            const saved = this.saves.load(slot.slot);
            player = restorePlayer(this.content.start, saved, this.items, `slot${slot.slot}.json`);
            this.content.upgradeSave?.(saved, player);
        } catch (err) {
            this.screen.fillRow(24);
            this.screen.text(1, 24, `That save can't be loaded: ${err instanceof Error ? err.message : String(err)}`, 12, 0);
            await this.term.key();

            return false;
        }

        if (!this.world.has(player.screen)) {
            player.screen = this.content.start.screen;
        }

        this.player = player;
        this.noclip = false;

        return true;
    }

    private async settingsAndRedraw(): Promise<void> {
        await this.settings();
        this.trackMapScreen();
        await this.redraw();
    }

    // The debug settings editor. Blank answers keep the current value.
    private async settings(): Promise<void> {
        const { screen, term } = this;
        const p = this.playing;
        screen.clear();
        screen.text(1, 1, 'Current Settings:', 15, 0);
        SETTINGS.forEach(([label, key], i) => {
            screen.text(1, 3 + i, `${label}:`.padEnd(14) + String(p[key]), 15, 0);
        });
        screen.text(1, 3 + SETTINGS.length, 'Monsters:'.padEnd(14) + (p.monsters ? 'YES' : 'NO'), 15, 0);
        screen.text(1, 13, 'New Settings:', 7, 0);

        let y = 14;
        const ask = async (label: string, valid: (answer: string) => boolean): Promise<string> => {
            for (;;) {
                const answer = await prompt(term, y, `${label}: `);
                if (answer === '' || valid(answer)) {
                    y++;
                    return answer;
                }

                screen.fillRow(y);
            }
        };

        const int = (lo: number, hi: number) => (a: string): boolean => /^\d+$/.test(a) && +a >= lo && +a <= hi;
        const limits: Readonly<Partial<Record<NumericField, (a: string) => boolean>>> = {
            screen: (a) => int(1, 1920)(a) && this.world.has(+a),
            x: int(1, MAP_WIDTH),
            y: int(1, MAP_HEIGHT),
        };

        const answers: [NumericField, string][] = [];
        for (const [label, key] of SETTINGS) {
            answers.push([key, await ask(label, limits[key] ?? int(0, 1e9))]);
        }

        const monsters = await ask('Monsters (Y/N)', (a) => /^[yn]$/i.test(a));
        for (const [key, value] of answers) {
            if (value !== '') {
                p[key] = +value;
            }
        }

        if (monsters) {
            p.monsters = monsters.toUpperCase() === 'Y';
        }

        p.hp = Math.min(p.hp, p.maxHp);

        if ((await ask('Edit flags? (Y/N)', (a) => /^[yn]$/i.test(a))).toUpperCase() === 'Y') {
            const flags: FlagRecord = p.flags;
            for (const [name, value] of Object.entries(flags)) {
                if (y > 23) {
                    screen.clear();
                    y = 1;
                }

                const answer = await prompt(term, y++, `${name} (${JSON.stringify(value)}): `);
                if (answer !== '') {
                    flags[name] = parseFlag(answer, value);
                }
            }
        }
    }

    // Should we actually do a screensaver?
    private async screensaver(): Promise<void> {
        const { screen, term } = this;
        const text = 'Screen Protection System, Press any key to continue...';
        screen.clear();
        for (;;) {
            const y = Math.floor(Math.random() * 25) + 1;
            // Scroll in from the right, then off to the left.
            for (let shown = 1; shown <= MAP_WIDTH; shown++) {
                screen.fillRow(y);
                screen.text(80 - shown, y, text.slice(0, shown), YELLOW, 0);
                if (await term.key(100)) {
                    return;
                }
            }

            for (let cut = 1; cut <= text.length; cut++) {
                screen.fillRow(y);
                screen.text(1, y, text.slice(cut), YELLOW, 0);
                if (await term.key(100)) {
                    return;
                }
            }

            screen.fillRow(y);
        }
    }
}

// An answer in the flag editor, as the same type as the flag's old value.
function parseFlag(answer: string, old: FlagValue): FlagValue {
    if (typeof old === 'boolean') {
        return /^(y|yes|true|1)$/i.test(answer);
    }

    if (typeof old === 'number') {
        return Number(answer) || 0;
    }

    return answer;
}
