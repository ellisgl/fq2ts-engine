// Test Quest: a tiny game for testing the engine (and the server and tools
// built on it) without a real game. Its world is four blank screens, its
// scripts are a few triggers that each do one thing, and its data (in
// fixture/) is a frozen copy of a real game's items and monsters.
//
// The world (fixture/maps): screen 1 (land) has a wall north of the start (10,9); its
// triggers are a creaky board (12,10), two messages (15,12), a sign that
// takes over the screen (9,10), a door to screen 3 (10,11) and a warp that
// works once the board has been stepped on (11,10). Screen 2 (east, with
// monsters) has a wall on its west edge. Screen 3 is an interior,
// with a bell at (20,5) that rings for everyone (the world's state). Screen 82
// is south of screen 2; there's nothing south of screen 1.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game, readConfig, type Config, type Content, type GameOptions } from './game.ts';
import { readBestiary, type Bestiary } from './combat.ts';
import { readItems, type ItemCatalogue } from './items.ts';
import { Saves } from './saves.ts';
import { ScriptContext } from './script.ts';
import { World } from './world.ts';
import type { Key } from './terminal.ts';
import type { FlagRecord, Player } from './player.ts';
import { FakeTerminal, tempDir, type Step } from './testing.ts';
import type { WorldRecord } from './shared.ts';

// The fixture's data folder, laid out as a game's is (config.json,
// items.json, monsters.json and maps/), for whatever loads a game from one.
export const FIXTURE_DATA = join(import.meta.dir, 'fixture');

// One of the fixture's data files (config.json, items.json, monsters.json).
export function readFixture(file: string): unknown {
    return JSON.parse(readFileSync(join(FIXTURE_DATA, file), 'utf8'));
}

export const config: Config = readConfig(readFixture('config.json'));
export const bestiary: Bestiary = readBestiary(readFixture('monsters.json'));
export const itemCatalogue: ItemCatalogue = readItems(readFixture('items.json'));

// (Type aliases, not interfaces, so that they fit the engine's FlagRecord
// and WorldRecord.)
export type TestFlags = { visits: number; met: boolean; name: string };
// The world's: a bell anyone can ring, and who has.
export type TestWorld = { rings: number; ringers: readonly string[] };

export const start: Player<TestFlags> = {
    name: '',
    sex: 'male',
    screen: 1,
    x: 10,
    y: 10,
    mapScreen: 1,
    hp: 100,
    maxHp: 100,
    gold: 20,
    strength: 10,
    defense: 10,
    exp: 0,
    items: {},
    weapon: null,
    armour: null,
    monsters: false,
    superhuman: false,
    flags: { visits: 0, met: false, name: '' },
};

// The world (from fixture/maps), new each time, so a test can change it.
export function testWorld(): World {
    return World.load(join(FIXTURE_DATA, 'maps'));
}

export const content: Content<TestFlags, TestWorld> = {
    title: {
        art: ({ title, version, revision }) => [
            `{y 3}{x 30}{white}${title} ${version} ${revision}`,
            '{y 16}{x 32}{on blue}{sp 18}',
        ],
        // In the order the engine's title menu expects.
        menu: {
            options: [
                ['Enter the Realm', 33, 17],
                ['Save Game', 36, 18],
                ['Load Game', 36, 19],
                ['Help', 38, 20],
                ['Resume Game', 35, 21],
                ['Leave this place', 33, 22],
            ],
            selectedColor: [11, 1],
            color: [9, 1],
        },
    },
    help: ({ title, version }) => [`{y 1}{center}{yellow}${title} ${version}`, '{y 3}{x 37}{yellow}KEYS:', '{y 23}{yellow}Press any key...'],
    credits: ({ title }) => [`{y 10}{center}{white}Thank you for playing ${title}!`],
    worldMapLegend: ['{x 28}{y 5}{white}{on blue}A {on gray} {on blue} represents a large town.'],
    statusLine: (p) => `HP ${p.hp}/${p.maxHp} Gold ${p.gold}`,
    inventory: async (g) => {
        g.overlay(`{y 2}{x 2}INVENTORY gold=${g.gold}`);
        await g.key();
    },
    newGame: async (g) => {
        g.cls();
        g.print('A NEW GAME BEGINS');
        await g.key();
    },
    start,
    world: { rings: 0, ringers: [] },
    screens: {
        1: {
            show: (g) => {
                if (g.flags.met) {
                    g.overlay('{x 30}{y 2}MET');
                }
            },
            at: {
                '12,10': (g) => {
                    g.flags.visits++;
                    g.write('You step on a creaky board.');
                },
                '15,12': (g) => {
                    g.write('First news.');
                    g.write('Second news.');
                },
                '9,10': async (g) => {
                    g.cls();
                    g.print('A SIGN');
                    await g.key();
                },
                '10,11': (g) => {
                    g.goto(3, 5, 5);
                },
                '11,10': (g) => {
                    if (g.flags.visits > 0) {
                        g.moveTo(20, 20);
                    }
                },
            },
        },
        3: {
            at: {
                '5,5': (g) => {
                    g.flags.met = true;
                },
                // The bell, shared by everyone.
                '20,5': (g) => {
                    g.world.rings++;
                    if (!g.world.ringers.includes(g.name)) {
                        g.world.ringers = [...g.world.ringers, g.name];
                    }
                    g.write(`The bell has rung ${g.world.rings} times.`);
                },
            },
        },
    },
    events: {
        // The Tree Elf's (in fixture/monsters.json).
        'elf-berries': (g) => {
            g.give('wildberries', 3);
        },
    },
};

// A player of the fixture, starting as a new game does unless told otherwise.
export function newPlayer(changes: Partial<Player<TestFlags>> = {}, flags: Partial<TestFlags> = {}): Player<TestFlags> {
    const player = { ...structuredClone(start), ...changes };
    player.flags = { ...player.flags, ...flags };
    return player;
}

export interface GameSetup<F extends FlagRecord, W extends WorldRecord = WorldRecord> {
    steps?: readonly Step[];
    fallback?: Key;
    player?: Player<F>;
    world?: World;
    config?: Config;
    saves?: Saves;
    debug?: boolean;
    monsters?: Bestiary;
    items?: ItemCatalogue;
    autosave?(player: Player<F>): void;
    screensaver?: boolean;
    // No save slots (like a server's games).
    noSaves?: boolean;
    // A server's: cheats, other players drawn, moves reported, more keys.
    cheats?: boolean;
    figures?: GameOptions<F, W>['figures'];
    moved?: GameOptions<F, W>['moved'];
    keys?: GameOptions<F, W>['keys'];
    fought?: GameOptions<F, W>['fought'];
    ambush?: GameOptions<F, W>['ambush'];
    nearby?: GameOptions<F, W>['nearby'];
    worldStore?: GameOptions<F, W>['worldStore'];
    news?: GameOptions<F, W>['news'];
}

// A game of any content on a scripted terminal; whatever isn't given comes
// from the fixture (its world, config, monsters and items), and saves go to
// a new temporary folder.
export function makeGameWith<F extends FlagRecord, W extends WorldRecord = WorldRecord>(
    gameContent: Content<F, W>,
    { steps = [], fallback, player, world, config: gameConfig = config, saves, debug = false, monsters = bestiary, items = itemCatalogue, autosave, screensaver, noSaves = false, cheats, figures, moved, keys, fought, ambush, nearby, worldStore, news }: GameSetup<F, W> = {},
): { game: Game<F, W>; term: FakeTerminal } {
    const term = new FakeTerminal(steps, fallback === undefined ? {} : { fallback });
    const game = new Game({
        term,
        world: world ?? testWorld(),
        config: gameConfig,
        monsters,
        items,
        content: gameContent,
        ...(noSaves ? {} : { saves: saves ?? new Saves(tempDir()) }),
        ...(screensaver === undefined ? {} : { screensaver }),
        debug,
        ...(player ? { player } : {}),
        ...(autosave ? { autosave } : {}),
        ...(cheats === undefined ? {} : { cheats }),
        ...(figures ? { figures } : {}),
        ...(moved ? { moved } : {}),
        ...(keys ? { keys } : {}),
        ...(fought ? { fought } : {}),
        ...(ambush ? { ambush } : {}),
        ...(nearby ? { nearby } : {}),
        ...(worldStore ? { worldStore } : {}),
        ...(news ? { news } : {}),
    });
    return { game, term };
}

// Test Quest, with a player already in it.
export function makeGame(setup: GameSetup<TestFlags, TestWorld> = {}): { game: Game<TestFlags, TestWorld>; term: FakeTerminal } {
    return makeGameWith(content, { player: newPlayer(), ...setup });
}

// A script context in Test Quest: what content scripts get as `g`.
export function scriptContext(setup: GameSetup<TestFlags, TestWorld> = {}): { g: ScriptContext<TestFlags, TestWorld>; game: Game<TestFlags, TestWorld>; term: FakeTerminal } {
    const { game, term } = makeGame(setup);
    return { g: new ScriptContext(game), game, term };
}
