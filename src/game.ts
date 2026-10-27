// The game: title menu, exploring the world, and the built-in screens.

import { draw, escapeMarkup } from './text.ts';
import { at } from './assert.ts';
import { statusBar, textInput, prompt, scrollText } from './ui.ts';
import { MAP_WIDTH, MAP_HEIGHT, GRID_WIDTH, GRID_HEIGHT, WILD_TERRAIN, gridPosition, isTriggerCode, type World } from './world.ts';
import { fight, pickMonster, type Bestiary, type FightResult, type Monster } from './combat.ts';
import { ScriptContext, type Destination, type Script } from './script.ts';
import { SLOTS, type Saves, type SlotInfo } from './saves.ts';
import { restorePlayer, type FlagRecord, type FlagValue, type NumericField, type Player } from './player.ts';
import { gearOf, wear, type ItemCatalogue } from './items.ts';
import { record, string, number, field } from './validate.ts';
import type { Cell, Color, Screen } from './screen.ts';
import type { Key, Terminal } from './terminal.ts';
import { MemoryWorld, restoreWorld, worldView, type WorldRecord, type WorldStore } from './shared.ts';

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

export interface ScreenScripts<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    // Runs every time the screen is drawn.
    show?: Script<F, W>;
    // Runs when the player walks onto or bumps into (x, y), or arrives there
    // from another screen.
    at?: Readonly<Partial<Record<Coord, Script<F, W>>>>;
    // The same, for every tile the screen's map marks with the character
    // (see GameMap's `triggers`): the map says where, this says what.
    triggers?: Readonly<Record<string, Script<F, W>>>;
}

// The screens' scripts with each one's `triggers` put on the tiles its map
// marks, as `at`. Throws if a map marks a tile with a character that has no
// trigger, a trigger is on no tile, or a tile would have two.
export function placeTriggers<F extends FlagRecord, W extends WorldRecord>(screens: Content<F, W>['screens'], world: World): Content<F, W>['screens'] {
    const placed: Partial<Record<number, ScreenScripts<F, W>>> = { ...screens };
    for (const [key, scripts] of Object.entries(screens)) {
        const triggers = Object.keys(scripts?.triggers ?? {});
        const bad = triggers.find((ch) => !isTriggerCode(ch));
        if (bad !== undefined) {
            throw new Error(`Screen ${key} has a trigger "${bad}": triggers are one character you can type, other than ".".`);
        }
        if (triggers.length && !world.has(Number(key))) {
            throw new Error(`Screen ${key} has triggers, but there's no such screen.`);
        }
    }

    for (const screen of world.screens()) {
        const scripts = screens[screen];
        const at: Partial<Record<Coord, Script<F, W>>> = { ...scripts?.at };
        const unused = new Set(Object.keys(scripts?.triggers ?? {}));
        for (let y = 1; y <= MAP_HEIGHT; y++) {
            for (let x = 1; x <= MAP_WIDTH; x++) {
                const ch = world.trigger(screen, x, y);
                if (ch === null) {
                    continue;
                }
                const script = scripts?.triggers?.[ch];
                if (!script) {
                    throw new Error(`Screen ${screen}'s map has "${ch}" at ${x},${y}, but the screen has no trigger "${ch}".`);
                }
                if (at[`${x},${y}`]) {
                    throw new Error(`Screen ${screen} has two triggers at ${x},${y}: "${ch}" on its map, and one in its \`at\`.`);
                }
                at[`${x},${y}`] = script;
                unused.delete(ch);
            }
        }
        const [missing] = unused;
        if (missing !== undefined) {
            throw new Error(`Screen ${screen} has a trigger "${missing}", but its map doesn't put it on any tile.`);
        }
        if (scripts?.triggers) {
            placed[screen] = { ...scripts, at };
        }
    }
    return placed;
}

// Everything that makes a particular game, as opposed to the engine.
export interface Content<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    title: {
        art(config: Config): string[];
        menu: {
            // [label, x, y] for each title menu option.
            options: readonly (readonly [string, number, number])[];
            // [foreground, background]
            selectedColor: readonly [Color, Color];
            color: readonly [Color, Color];
            // The inside of the art's menu box (columns x to x + width - 1,
            // rows y to y + height - 1), where a server puts its own menus
            // and questions.
            box?: { x: number; y: number; width: number; height: number };
        };
    };
    help(config: Config): string[];
    // `frame` is a colour number (1-7) for the shaded border.
    credits(config: Config, frame: number): string[];
    worldMapLegend: readonly string[];
    statusLine(player: Player<F>, config: Config): string;
    // The inventory screen (I). It handles its own keys.
    inventory: Script<F, W>;
    newGame: Script<F, W>;
    // The player at the start of a new game.
    start: Player<F>;
    // Flags that go back to their start values each new day: on a server,
    // at midnight (FQ2's one drink a day). Single-player has no days.
    daily?: readonly (keyof F & string)[];
    // What belongs to the world rather than any player, with its starting
    // values (scripts use it as g.world). In single-player it's saved with
    // the game; on a server, everyone playing shares it. {} for none.
    world: W;
    screens: Readonly<Partial<Record<number, ScreenScripts<F, W>>>>;
    // The game's own keys while exploring, by key (one character, upper
    // case for letters), each a script: its own screens of information, say.
    // They're listed by ?, with their help, beside any a server adds.
    keys?: Readonly<Record<string, ExtraKey<F, W>>>;
    // Scripts that monsters' after-fight hooks (Monster.after) run, by name.
    events?: Readonly<Record<string, Script<F, W>>>;
    // Brings a loaded save up to date, given the save as it was on disk (for
    // anything restorePlayer can't work out by itself).
    upgradeSave?(saved: unknown, player: Player<F>): void;
}

export interface GameOptions<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    term: Terminal;
    world: World;
    config: Config;
    monsters: Bestiary;
    items: ItemCatalogue;
    content: Content<F, W>;
    // Save slots for the title menu (single-player). A server keeps players
    // itself, through autosave, and has none.
    saves?: Saves;
    debug?: boolean;
    // A game already in progress (otherwise the player starts one from the
    // title menu).
    player?: Player<F>;
    // Called whenever the player's state should be kept: after a screen
    // change, a script or a fight, and on leaving the map. (Single-player
    // saves by slot instead; a server saves here.)
    autosave?(player: Player<F>): void;
    // Whether an idle player gets the screensaver (a server disconnects
    // them instead). On by default.
    screensaver?: boolean;
    // Whether the cheat words (HELPME, TITANIC, QUAKE, SDEB) work. On by
    // default; a server turns them off.
    cheats?: boolean;
    // Things drawn over the map of a screen, after its show script: other
    // players, on a server.
    figures?(screen: number): readonly Figure[];
    // Called when the player is somewhere new (a step, another screen, a
    // script moving them), once the game is waiting for the next key.
    moved?(player: Player<F>): void;
    // Where the world's state (Content.world) is kept: a server shares one
    // among its games. Without one, the game keeps it, and saves it with
    // the player.
    worldStore?: WorldStore;
    // A line for the news (g.news): a server's daily news. Without one,
    // scripts' news goes nowhere.
    news?(text: string): void;
    // Called when a fight ends, either way (a random one or a script's): a
    // server's news.
    fought?(player: Player<F>, monster: Monster, result: FightResult): void;
    // More keys while exploring (a server's P, L...), by key, each a script.
    // They're listed by ?, with their help.
    keys?: Readonly<Record<string, ExtraKey<F, W>>>;
}

// The keys the game itself uses while exploring (S only in debug mode).
const BUILT_IN_KEYS = ['I', 'V', 'M', 'B', 'R', '?', '8', '4', '6', '2'];

// The content's keys and a server's together. A key may only mean one thing:
// one a key the game already uses, or both of them use, is an error.
function mergeKeys<F extends FlagRecord, W extends WorldRecord>(content: Readonly<Record<string, ExtraKey<F, W>>>, server: Readonly<Record<string, ExtraKey<F, W>>>, debug: boolean): Readonly<Record<string, ExtraKey<F, W>>> {
    const taken = new Set(debug ? [...BUILT_IN_KEYS, 'S'] : BUILT_IN_KEYS);
    for (const [key, from] of [...Object.keys(content).map((k) => [k, 'content'] as const), ...Object.keys(server).map((k) => [k, 'server'] as const)]) {
        if ([...key].length !== 1 || key !== key.toUpperCase()) {
            throw new Error(`The ${from}'s key "${key}" must be one character (upper case, for a letter).`);
        }
        if (taken.has(key)) {
            throw new Error(`The ${from}'s key "${key}" is already used${from === 'server' && key in content ? ' by the content' : ' by the game'}.`);
        }
        taken.add(key);
    }
    return { ...content, ...server };
}

// Something drawn on a cell of the map.
export interface Figure {
    x: number;
    y: number;
    ch: string;
    fg: Color;
}

export interface ExtraKey<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    // For the list of keys (?), e.g. "who's online".
    help: string;
    run: Script<F, W>;
}

const MESSAGE_SECONDS = 4;
// The most notices from outside kept until the game can show them, and
// messages waiting to be shown (the back-buffer keeps them all): a busy
// realm can't fill memory while a player sits in a menu.
const NOTICES_KEPT = 50;
const MESSAGES_WAITING = 20;
// How long a message shows when there are more waiting behind it.
const BUSY_MESSAGE_SECONDS = 1.5;
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

export class Game<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    public readonly term: Terminal;
    public readonly config: Config;
    public readonly items: ItemCatalogue;
    private readonly screen: Screen;
    private readonly world: World;
    public readonly monsters: Bestiary;
    private readonly content: Content<F, W>;
    private readonly saves: Saves | null;
    private readonly useScreensaver: boolean;
    private readonly debug: boolean;
    private player: Player<F> | null = null;
    private noclip = false;
    private showPosition: boolean;
    private messageText: string | null = null;
    private messageUntil = 0;
    private messageShownAt = 0;
    // Messages waiting for the status bar, and every recent one.
    private readonly messageQueue: string[] = [];
    private readonly messageLog: string[] = [];
    // Each key the player presses while exploring starts a new turn.
    // Messages only wait behind others from the same turn.
    private turn = 0;
    private messageTurn = -1;
    // Whether the map is on screen (not a script's or menu's screen).
    private mapShown = false;
    private readonly autosave: ((player: Player<F>) => void) | undefined;
    private readonly cheats: boolean;
    // The world's state, as scripts see it, and (single-player) the game's
    // own store, which saves keep.
    public readonly worldState: W;
    private readonly ownWorld: MemoryWorld | null;
    // Where g.news goes.
    public readonly news: (text: string) => void;
    private readonly figures: ((screen: number) => readonly Figure[]) | undefined;
    private readonly moved: ((player: Player<F>) => void) | undefined;
    private readonly keys: Readonly<Record<string, ExtraKey<F, W>>>;
    private readonly fought: ((player: Player<F>, monster: Monster, result: FightResult) => void) | undefined;
    // Told from outside, for when the game is next waiting for a key: the
    // figures have moved, and notices to show.
    private figuresChanged = false;
    private redrawWanted = false;
    private readonly notices: string[] = [];
    // Whether the game is on the map waiting for a key (the only time it's
    // safe for outside things to change the player).
    private waitingForKey = false;
    // The map as drawn before the figures and the player (after the show
    // script), to put cells back from when figures move; and where the
    // figures are drawn.
    private mapCells: Cell[] = [];
    private drawnFigures: readonly Figure[] = [];
    // Where the player was when `moved` was last told.
    private lastPlace = '';

    public constructor({ term, world, config, monsters, items, content, saves, debug = false, player, autosave, screensaver = true, cheats = true, figures, moved, keys = {}, fought, worldStore, news = () => undefined }: GameOptions<F, W>) {
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

        this.content = { ...content, screens: placeTriggers(content.screens, world) };
        this.saves = saves ?? null;
        this.useScreensaver = screensaver;
        this.debug = debug;
        this.showPosition = debug;
        this.player = player ?? null;
        this.autosave = autosave;
        this.cheats = cheats;
        this.news = news;
        this.ownWorld = worldStore ? null : new MemoryWorld();
        this.worldState = worldView(content.world, worldStore ?? this.ownWorld ?? new MemoryWorld());
        this.figures = figures;
        this.moved = moved;
        this.keys = mergeKeys(content.keys ?? {}, keys, debug);
        this.fought = fought;
    }

    // ---- Told from outside (on a server, by other players' sessions)

    // The figures have changed: they're redrawn once the game is waiting for
    // a key on the map (never in the middle of a script).
    public othersChanged(): void {
        this.figuresChanged = true;
        this.term.wake();
    }

    // Something that's drawn has changed (the world's state, the player's
    // gold): the whole screen is drawn again, once the game is waiting for a
    // key on the map.
    public refresh(): void {
        this.redrawWanted = true;
        this.term.wake();
    }

    // A message from outside ("Bob enters the realm."): shown, and kept in
    // the back-buffer, once the game is waiting for a key on the map.
    public notify(text: string): void {
        this.notices.push(text);
        if (this.notices.length > NOTICES_KEPT) {
            this.notices.shift();
        }
        this.term.wake();
    }

    // Whether the game is on the map, waiting for the player's next key:
    // nothing of theirs is in use (no scene, menu or fight).
    public get waiting(): boolean {
        return this.waitingForKey;
    }

    // Whether the map is what's on screen, so things happening on it (other
    // players moving) can be drawn.
    public get showingMap(): boolean {
        return this.mapShown;
    }

    // Something is about to cover the map with a screen of its own.
    public leaveMap(): void {
        this.mapShown = false;
    }

    private clearScreen(): void {
        this.leaveMap();
        this.screen.clear();
    }

    // Hands the player's state to autosave, if there is one.
    private checkpoint(): void {
        if (this.player) {
            this.autosave?.(this.player);
        }
    }

    // Whether a game has begun (or been resumed): there's a player to save.
    public get inProgress(): boolean {
        return this.player !== null;
    }

    // The player of the game in progress. Only exploring and scripts use it,
    // and they only run once there is one.
    public get playing(): Player<F> {
        if (!this.player) {
            throw new Error('No game is in progress.');
        }

        return this.player;
    }

    // A player for a new game, from the content's start.
    public freshPlayer(): Player<F> {
        return structuredClone(this.content.start);
    }

    // Starts a new game with this player: the content's opening scene, then
    // exploring, until the player presses Escape.
    public async begin(player: Player<F>): Promise<void> {
        this.player = player;
        this.noclip = false;
        this.clearScreen();
        await this.content.newGame(this.script());
        await this.play({ arrive: true });
    }

    // Carries on with this player, until they press Escape. `arrive` runs the
    // trigger they're standing on (as after loading a game).
    public async resume(player: Player<F>, { arrive = true } = {}): Promise<void> {
        this.placeSafely(player);
        this.player = player;
        this.noclip = false;
        await this.play({ arrive });
    }

    // A saved player on a screen that's gone, or off the map, starts again
    // where new games do.
    private placeSafely(player: Player<F>): void {
        const onMap = player.x >= 1 && player.x <= MAP_WIDTH && player.y >= 1 && player.y <= MAP_HEIGHT;
        if (!this.world.has(player.screen) || !onMap) {
            const { screen, x, y } = this.content.start;
            Object.assign(player, { screen, x, y });
        }
    }

    // The save slots, which only single-player games have.
    private get slots(): Saves {
        if (!this.saves) {
            throw new Error('This game has no save slots.');
        }

        return this.saves;
    }

    private script(): ScriptContext<F, W> {
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
            this.clearScreen();

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
                    this.player ??= this.freshPlayer();
                    await this.settings();

                    break;
                }
            }
        }
    }

    // (From the title menu: a new single-player game starts a new world.)
    private async newGame(): Promise<void> {
        this.ownWorld?.reset();
        await this.begin(this.freshPlayer());
    }

    private async help(): Promise<void> {
        this.clearScreen();
        for (const line of this.content.help(this.config)) {
            draw(this.screen, line);
        }

        await this.term.key();
    }

    private credits(): void {
        this.clearScreen();
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
                this.leaveMap();
                this.checkpoint();
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
            } else if (this.keys[upper]) {
                await this.runScript(this.keys[upper].run);
            } else if (this.cheats) {
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
            await this.idle();
            const now = Date.now();
            let timeout = this.useScreensaver ? this.term.lastInput + SCREENSAVER_SECONDS * 1000 - now : Infinity;
            if (this.messageText) {
                timeout = Math.min(timeout, this.messageUntil - now);
            }

            this.screen.cursor = { x: this.playing.x, y: this.playing.y };
            this.waitingForKey = true;
            let key;
            try {
                key = await this.term.key(timeout);
            } finally {
                this.waitingForKey = false;
            }
            this.screen.cursor = null;
            if (key) {
                this.newTurn();
                return key;
            }

            if (this.messageText && Date.now() >= this.messageUntil) {
                this.nextMessage();
            }

            if (this.useScreensaver && Date.now() >= this.term.lastInput + SCREENSAVER_SECONDS * 1000) {
                await this.screensaver();
                await this.redraw();
            }
        }
    }

    // What's waited for until the game is on the map waiting for a key: the
    // player's new place to report, figures to redraw, notices to show.
    private async idle(): Promise<void> {
        const p = this.playing;
        const place = `${p.screen},${p.x},${p.y}`;
        if (place !== this.lastPlace) {
            this.lastPlace = place;
            this.moved?.(p);
        }

        if (this.redrawWanted) {
            this.redrawWanted = false;
            this.figuresChanged = false;
            await this.redraw();
        } else if (this.figuresChanged) {
            this.figuresChanged = false;
            this.redrawFigures();
        }

        for (const text of this.notices.splice(0)) {
            this.message(text);
        }
    }

    // One step. Random monsters only turn up after a real step onto a tile
    // with no trigger (as in LORD II): not when the player bumps into
    // something, crosses to another screen, or a script handles the tile.
    private async move(dx: number, dy: number): Promise<void> {
        const p = this.playing;
        const x = p.x + dx;
        const y = p.y + dy;
        if (x < 1 || x > MAP_WIDTH || y < 1 || y > MAP_HEIGHT) {
            await this.crossEdge(dx, dy);
            return;
        }

        const trigger = this.triggerAt(x, y);
        const consumed = trigger ? await this.runScript(trigger) : false;
        if (consumed || (!this.noclip && this.world.isSolid(p.screen, x, y))) {
            return;
        }

        this.placePlayer(x, y);
        if (!trigger) {
            await this.encounter();
        }
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
        this.checkpoint();
        await this.arrive();
    }

    // Shows the name of the screen the player is on, unless it's the same as
    // the one they came from.
    private announce(from: number | null): void {
        const name = this.world.name(this.playing.screen);
        if (name && (from === null || this.world.name(from) !== name)) {
            this.message(`{white}${escapeMarkup(name)}`);
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

    private triggerAt(x: number, y: number): Script<F, W> | undefined {
        return this.content.screens[this.playing.screen]?.at?.[`${x},${y}`];
    }

    // Runs a script and deals with what it did. Returns true if the player's
    // step should not go ahead (the script moved them, travelled or used the
    // whole screen).
    private async runScript(script: Script<F, W>): Promise<boolean> {
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

        this.checkpoint();
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

        this.checkpoint();
    }

    // A fight is over: `fought` is told, and this is the script the monster
    // runs after a fight that ended this way, if any.
    public afterFight(monster: Monster, result: FightResult): Script<F, W> | undefined {
        this.fought?.(this.playing, monster, result);
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

        this.mapCells = [];
        for (let y = 1; y <= MAP_HEIGHT; y++) {
            for (let x = 1; x <= MAP_WIDTH; x++) {
                this.mapCells.push(this.screen.cell(x, y));
            }
        }
        this.drawnFigures = [];
        this.drawFigures();
        this.drawPlayer();
        this.mapShown = true;
    }

    // Draws the figures on this screen (other players), and keeps where.
    private drawFigures(): void {
        this.drawnFigures = (this.figures?.(this.playing.screen) ?? []).filter(({ x, y }) => x >= 1 && x <= MAP_WIDTH && y >= 1 && y <= MAP_HEIGHT);
        for (const { x, y, ch, fg } of this.drawnFigures) {
            this.screen.put(x, y, ch, fg, this.screen.cell(x, y).bg);
        }
    }

    // The figures have moved: only the cells they left and the ones they're
    // on now are drawn again (not the whole map).
    private redrawFigures(): void {
        const left = this.drawnFigures;
        for (const { x, y } of left) {
            this.restoreCell(x, y);
        }
        this.drawFigures();
        this.drawPlayer();
    }

    // A cell of the map as it was drawn, before the figures and the player.
    private restoreCell(x: number, y: number): void {
        const cell = this.mapCells[(y - 1) * MAP_WIDTH + (x - 1)];
        if (cell) {
            this.screen.put(x, y, cell.ch, cell.fg, cell.bg, cell.blink);
        } else {
            this.drawTile(x, y);
        }
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
        // (The cell they leave, with anyone else who's on it.)
        this.restoreCell(p.x, p.y);
        for (const figure of this.drawnFigures) {
            if (figure.x === p.x && figure.y === p.y) {
                this.screen.put(figure.x, figure.y, figure.ch, figure.fg, this.screen.cell(figure.x, figure.y).bg);
            }
        }
        p.x = x;
        p.y = y;
        this.drawPlayer();
    }

    // Puts the status bar back (after something else used its row).
    public showStatus(): void {
        this.drawStatus();
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
            // With more to show, each gets less time (and the oldest waiting
            // go, past MESSAGES_WAITING: they're in the back-buffer).
            this.messageQueue.push(text);
            if (this.messageQueue.length > MESSAGES_WAITING) {
                this.messageQueue.shift();
            }
            this.messageUntil = Math.min(this.messageUntil, this.messageShownAt + BUSY_MESSAGE_SECONDS * 1000);
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
        this.messageShownAt = Date.now();
        this.messageUntil = this.messageShownAt + (this.messageQueue.length ? BUSY_MESSAGE_SECONDS : MESSAGE_SECONDS) * 1000;
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
        this.leaveMap();
        const lines = this.messageLog.length ? this.messageLog : ['{darkgray}Nothing has happened yet.'];
        await scrollText(this.term, lines, { title: 'Back-buffer: the last messages', from: 'bottom' });
        await this.redraw();
    }

    private async keysHelp(): Promise<void> {
        this.leaveMap();
        const extra = Object.entries(this.keys).map(([key, { help }]) => `{white}${key.padEnd(16)}{gray}${escapeMarkup(help)}`);
        await scrollText(this.term, [...PLAY_HELP.slice(0, -1), ...extra, ...PLAY_HELP.slice(-1)], { title: 'Keys' });
        await this.redraw();
    }

    private async inventory(): Promise<void> {
        this.clearScreen();
        await this.content.inventory(this.script());
        await this.redraw();
        this.checkpoint();
    }

    private async worldMap(): Promise<void> {
        const { screen } = this;
        this.clearScreen();
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
        this.clearScreen();
        screen.text(30, 9, title, 10, 0);
        screen.text(30, 17, 'Enter a Choice.', 4, 0);
        const slots = this.slots.list();
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
        this.slots.save(slot.slot, name && name !== 'Empty' ? name : 'NoName', { ...this.player, world: this.ownWorld?.saved() ?? {} });
    }

    private async loadScreen(): Promise<boolean> {
        const slot = await this.pickSlot('Load a Game...', (s) => s.name !== null);
        if (!slot) {
            return false;
        }

        let player;
        let world: WorldRecord;
        try {
            const saved = this.slots.load(slot.slot);
            player = restorePlayer(this.content.start, saved, this.items, `slot${slot.slot}.json`);
            this.content.upgradeSave?.(saved, player);
            // (Saves from before there was world state have none.)
            const savedWorld = typeof saved === 'object' && saved !== null && 'world' in saved ? saved.world : undefined;
            world = restoreWorld(this.content.world, savedWorld, `slot${slot.slot}.json.world`);
        } catch (err) {
            this.screen.fillRow(24);
            this.screen.text(1, 24, `That save can't be loaded: ${err instanceof Error ? err.message : String(err)}`, 12, 0);
            await this.term.key();

            return false;
        }

        this.placeSafely(player);
        this.player = player;
        this.ownWorld?.reset(world);
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
        this.clearScreen();
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
                    this.clearScreen();
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
        this.clearScreen();
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
