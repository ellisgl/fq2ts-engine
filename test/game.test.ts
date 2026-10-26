import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, type Content, type Figure, type GameOptions } from '../src/game.ts';
import type { ScriptContext } from '../src/script.ts';
import { MemoryWorld } from '../src/shared.ts';
import type { Player } from '../src/player.ts';
import { Bestiary, type Monster } from '../src/combat.ts';
import { Saves } from '../src/saves.ts';
import type { Key } from '../src/terminal.ts';
import { caught, monster, makeMap, makeWorld, row, screenText, tempDir, typed, type FakeTerminal, type Step } from '../src/testing.ts';
import { content as testContent, makeGameWith, readFixture, scriptContext, start as START, testWorld, type TestFlags, type TestWorld } from '../src/fixture.ts';

// ---- Test Quest (see fixture.ts for its world and triggers)

const world = testWorld();

const player = (changes: Partial<Player<TestFlags>> = {}): Player<TestFlags> => ({ ...structuredClone(START), ...changes });

const LEAVE: Key[] = ['escape', 'escape']; // back to the title, then Leave
const RESUME: Key[] = ['down', 'down', 'down', 'down', 'enter'];
const keys = (key: Step, n: number): Step[] => Array.from({ length: n }, () => key);

interface Options {
    player?: Player<TestFlags>;
    debug?: boolean;
    saves?: Saves;
    monsters?: Bestiary;
    cheats?: boolean;
    figures?: GameOptions<TestFlags, TestWorld>['figures'];
    moved?: GameOptions<TestFlags, TestWorld>['moved'];
    keys?: GameOptions<TestFlags, TestWorld>['keys'];
    fought?: GameOptions<TestFlags, TestWorld>['fought'];
}

// A bestiary whose "default" table holds just this monster.
function onlyMonster(m: Monster, chance = 1): Bestiary {
    return new Bestiary(new Map([['only', m]]), [{ name: 'default', chance, tiers: [], monsters: [m] }]);
}

function setup(options: Options = {}) {
    return makeGameWith(testContent, { world, monsters: onlyMonster(monster()), ...options });
}

// Runs the game from the title menu, checking every step gets used.
async function run(game: { run(): Promise<void> }, term: FakeTerminal): Promise<void> {
    await game.run();
    expect(term.remaining).toBe(0);
}

// Plays `steps` from the title menu to the end.
async function play(steps: readonly Step[], options: Options = {}) {
    const { game, term } = setup(options);
    term.feed(...steps);
    await run(game, term);
    return { game, term };
}

// Plays `steps` in the game in progress (resuming it from the title menu).
const explore = (steps: readonly Step[], options: Options = {}) =>
    play([...RESUME, ...steps, ...LEAVE], { player: player(), ...options });

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
    for (const m of mocks.splice(0)) {
        m.mockRestore();
    }
});

function mockRandom(value: number): Mock<() => number> {
    const m = spyOn(Math, 'random').mockReturnValue(value);
    mocks.push(m);
    return m;
}

// A clock the test moves forward by hand.
function mockClock(): { advance(ms: number): void } {
    let now = 1_000_000;
    mocks.push(spyOn(Date, 'now').mockImplementation(() => now));
    return {
        advance(ms) {
            now += ms;
        },
    };
}

// ---- Title menu

describe('title menu', () => {
    test('Leave this place shows the credits and ends the game', async () => {
        const { term } = await play(['escape']);
        expect(screenText(term.screen)).toContain('Thank you for playing Test Quest!');
    });

    test('arrows move and wrap around', async () => {
        await play(['up', 'enter']);
        await play(['down', 'left', ...keys('right', 5), 'enter']);
    });

    test('Enter the Realm runs the new game script, then starts exploring', async () => {
        const { game, term } = setup();
        term.feed(
            'enter',
            () => {
                expect(row(term.screen, 1)).toBe('A NEW GAME BEGINS');
                return 'x';
            },
            () => {
                expect(term.screen.cell(10, 10).ch).toBe('☺');
                expect(row(term.screen, 23)).toContain('HP 100/100 Gold 20');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
        expect(game.playing).toMatchObject({ screen: 1, x: 10, y: 10 });
    });

    test('Resume Game with no game in progress starts a new one', async () => {
        const { game } = await play([...RESUME, 'x', ...LEAVE]);
        expect(game.playing.screen).toBe(1);
    });

    test('Resume Game goes back to the game in progress', async () => {
        const { game } = await explore(['right'], { player: player({ x: 30, y: 15 }) });
        expect(game.playing).toMatchObject({ x: 31, y: 15 });
    });

    test('Help shows the help screen until a key is pressed', async () => {
        const { game, term } = setup();
        term.feed('down', 'down', 'down', 'enter', () => {
            expect(row(term.screen, 3)).toContain('KEYS:');
            return 'x';
        }, 'escape');
        await run(game, term);
    });

    test("there's no game to play before one is started", () => {
        const { game } = setup();
        expect(() => game.playing).toThrow('No game is in progress.');
    });
});

// ---- Exploring

describe('moving', () => {
    test('arrow keys and the number pad move the player', async () => {
        const p = player({ x: 30, y: 15 });
        await explore(['right', 'down', '6', '2', '4', 'left', '8', 'up'], { player: p });
        expect(p).toMatchObject({ x: 30, y: 15 });
    });

    test('walls block the way', async () => {
        const { game } = await explore(['up']);
        expect(game.playing).toMatchObject({ x: 10, y: 10 });
    });

    test('walking off an edge goes to the next screen', async () => {
        const { game } = await explore(['right'], { player: player({ x: 79, y: 10 }) });
        expect(game.playing).toMatchObject({ screen: 2, x: 1, y: 10, mapScreen: 2 });
    });

    test('and back again', async () => {
        const { game } = await explore(['left'], { player: player({ screen: 2, x: 1, y: 10 }) });
        expect(game.playing).toMatchObject({ screen: 1, x: 79, y: 10 });
    });

    test('a missing screen or a wall over the edge blocks the way', async () => {
        const { game, term } = setup({ player: player({ x: 50, y: 22 }) });
        term.feed(...RESUME, 'down', () => {
            expect(row(term.screen, 23)).toContain('Something blocks you');
            return 'escape';
        }, 'escape');
        await run(game, term);
        expect(game.playing).toMatchObject({ screen: 1, x: 50, y: 22 });

        const walled = await explore(['right'], { player: player({ x: 79, y: 5 }) });
        expect(walled.game.playing).toMatchObject({ screen: 1, x: 79, y: 5 });
    });

    test('going up off the top and left off the left edge', async () => {
        const top = await explore(['up'], { player: player({ screen: 82, x: 5, y: 1 }) });
        expect(top.game.playing).toMatchObject({ screen: 2, x: 5, y: 22 });
        const { game } = await explore(['left'], { player: player({ screen: 2, x: 1, y: 6 }) });
        expect(game.playing).toMatchObject({ screen: 1, x: 79, y: 6 });
    });

    test("interiors don't change the world map position", async () => {
        const { game } = await explore(['down']);
        expect(game.playing).toMatchObject({ screen: 3, mapScreen: 1 });
    });
});

describe('triggers', () => {
    test('stepping on a trigger runs it, and the step goes ahead', async () => {
        const { game, term } = setup({ player: player({ x: 11, y: 10 }) });
        term.feed(...RESUME, 'right', () => {
            expect(row(term.screen, 23)).toContain('You step on a creaky board.');
            return 'escape';
        }, 'escape');
        await run(game, term);
        expect(game.playing).toMatchObject({ x: 12, flags: { visits: 1 } });
    });

    test('a script that takes over the screen stops the step and redraws', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            'left',
            () => {
                expect(row(term.screen, 1)).toBe('A SIGN');
                return 'x';
            },
            () => {
                expect(row(term.screen, 1)).toBe('');
                expect(term.screen.cell(10, 10).ch).toBe('☺');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
        expect(game.playing.x).toBe(10);
    });

    test('a script that moves the player stops the step', async () => {
        const { game } = await explore(['right'], { player: { ...player(), flags: { visits: 1, met: false, name: '' } } });
        expect(game.playing).toMatchObject({ x: 20, y: 20 });
    });

    test('goto travels and runs the trigger where the player arrives', async () => {
        const { game } = await explore(['down']);
        expect(game.playing).toMatchObject({ screen: 3, x: 5, y: 5, flags: { met: true } });
    });

    test("a screen's show script runs whenever it's drawn", async () => {
        const { game, term } = setup({ player: { ...player(), flags: { visits: 0, met: true, name: '' } } });
        term.feed(...RESUME, () => {
            expect(row(term.screen, 2)).toContain('MET');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('loading a game runs the trigger the player is standing on', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Door', player({ x: 10, y: 11 }));
        const { game } = await play(['down', 'down', 'enter', 'enter', ...LEAVE], { saves });
        expect(game.playing).toMatchObject({ screen: 3, x: 5, y: 5 });
    });

    test('going to a missing screen is an error', async () => {
        const broken: Content<TestFlags> = { ...testContent, screens: { 1: { at: { '11,10': (g) => g.goto(99, 1, 1) } } } };
        const { game, term } = makeGameWith(broken, { world, monsters: onlyMonster(monster()), player: player(), steps: [...RESUME, 'right'] });
        expect(await caught(game.run())).toEqual(new Error('Screen 99 does not exist.'));
        expect(term.remaining).toBe(0);
    });
});

describe('encounters', () => {
    const blob = onlyMonster(monster({ name: 'Blob', says: 'Bloop', hp: 1, attack: 0, gold: 7, exp: 3 }));
    const ogre = onlyMonster(monster({ name: 'Ogre', says: 'Rrr', hp: 1000, attack: 5000, gold: 0, exp: 0 }));

    test('only happen on monster screens with monsters turned on', async () => {
        mockRandom(0);
        const off = await explore(['right'], { player: player({ screen: 2, x: 10, y: 10 }), monsters: blob });
        expect(off.game.playing.gold).toBe(20);
        const land = await explore(['right'], { player: player({ x: 30, y: 15, monsters: true }), monsters: blob });
        expect(land.game.playing.gold).toBe(20);
    });

    test('winning a fight goes back to exploring', async () => {
    // The monster strikes first (Enter), then one blow kills it.
        mockRandom(0);
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        await explore(['right', 'enter', 'enter', 'x', 'x'], { player: p, monsters: blob });
        expect(p).toMatchObject({ x: 11, gold: 27, exp: 3 });
    });

    test('losing one redraws the map', async () => {
        mockRandom(0);
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        await explore(['right', 'enter', 'x'], { player: p, monsters: ogre });
        expect(p).toMatchObject({ hp: 10, gold: 0 });
    });

    test('gear can break in a random fight', async () => {
        mockRandom(0);
        const p = player({ screen: 2, x: 10, y: 10, monsters: true, items: { stick: 1 }, weapon: 'stick' });
        await explore(['right', 'enter', 'enter', 'x', 'x'], { player: p, monsters: blob });
        expect(p.items).toEqual({});
        expect(p.weapon).toBeNull();
    });

    test("most steps don't start one", async () => {
        mockRandom(0.99);
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        await explore(['right'], { player: p, monsters: onlyMonster(monster({ gold: 7 }), 30) });
        expect(p.gold).toBe(20);
    });

    test('a screen can name its own encounter table', async () => {
        mockRandom(0);
        const rich = monster({ name: 'Rich Blob', hp: 1, attack: 0, gold: 500 });
        const poor = monster({ name: 'Blob', hp: 1, attack: 0, gold: 1 });
        const bestiary = new Bestiary(new Map([['rich', rich], ['poor', poor]]), [
            { name: 'default', chance: 1, tiers: [], monsters: [poor] },
            { name: 'vault', chance: 1, tiers: [], monsters: [rich] },
        ]);
        const vaultWorld = makeWorld(makeMap(1, 1, ['10,9']), makeMap(2, 5), makeMap(3, 2));
        vaultWorld.setEncounters(2, 'vault');
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        const { game, term } = makeGameWith(testContent, { world: vaultWorld, player: p, monsters: bestiary, steps: [...RESUME, 'right', 'enter', 'enter', 'x', 'x', ...LEAVE] });
        await run(game, term);
        expect(p.gold).toBe(520);
    });

    test("a monster's after-fight hook runs the content's event", async () => {
        mockRandom(0);
        const looter = onlyMonster(monster({ hp: 1, attack: 0, after: { won: 'loot' } }));
        const looting: Content<TestFlags> = { ...testContent, events: { loot: (g) => g.give('wildberries', 2) } };
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        const { game, term } = makeGameWith(looting, { world, player: p, monsters: looter, steps: [...RESUME, 'right', 'enter', 'enter', 'x', 'x', ...LEAVE] });
        await run(game, term);
        expect(p.items).toEqual({ wildberries: 2 });
    });

    test("hooks for other endings don't run", async () => {
        mockRandom(0);
        const looter = onlyMonster(monster({ hp: 1, attack: 0, after: { lost: 'loot' } }));
        const looting: Content<TestFlags> = { ...testContent, events: { loot: (g) => g.give('wildberries', 2) } };
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        const { game, term } = makeGameWith(looting, { world, player: p, monsters: looter, steps: [...RESUME, 'right', 'enter', 'enter', 'x', 'x', ...LEAVE] });
        await run(game, term);
        expect(p.items).toEqual({});
    });
});

describe('checks when the game starts', () => {
    test('every monster hook needs a content event', () => {
        const hooked = onlyMonster(monster({ after: { won: 'missing' } }));
        expect(() => makeGameWith(testContent, { world, monsters: hooked })).toThrow('A monster runs the script "missing" after a fight, but the content has no such event.');
    });

    test("every screen's encounter table must exist", () => {
        const odd = makeWorld(makeMap(1));
        odd.setEncounters(1, 'swamp');
        expect(() => makeGameWith(testContent, { world: odd, monsters: onlyMonster(monster()) })).toThrow('Screen 1 uses the encounter table "swamp", which doesn\'t exist.');
    });
});

describe('built-in screens', () => {
    test('I shows the inventory until a key is pressed', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(...RESUME, 'i', () => {
            expect(row(term.screen, 2)).toContain('INVENTORY gold=20');
            return 'x';
        }, () => {
            expect(row(term.screen, 2)).toBe('');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('M shows the world map with the player on it', async () => {
        const { game, term } = setup({ player: player({ screen: 2, mapScreen: 2 }) });
        term.feed(...RESUME, 'M', () => {
            expect(term.screen.cell(2, 1)).toMatchObject({ ch: '☺', fg: 4, blink: true });
            expect(term.screen.cell(1, 1).bg).toBe(2);
            expect(term.screen.cell(3, 1).bg).toBe(1);
            expect(screenText(term.screen)).toContain('represents a large town');
            return 'x';
        }, 'escape', 'escape');
        await run(game, term);
    });
});

describe('the status bar message', () => {
    test('goes away after a few seconds', async () => {
        const clock = mockClock();
        const { game, term } = setup({ player: player({ x: 11, y: 10 }) });
        term.feed(
            ...RESUME,
            'right',
            () => {
                clock.advance(5000);
                return null;
            },
            () => {
                expect(row(term.screen, 23)).toContain('HP 100/100 Gold 20');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test("stays while there's time left", async () => {
        mockClock();
        const { game, term } = setup({ player: player({ x: 11, y: 10 }) });
        term.feed(...RESUME, 'right', null, () => {
            expect(row(term.screen, 23)).toContain('creaky board');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });
});

describe('the screensaver', () => {
    test('starts after three idle minutes and stops on a key', async () => {
        const clock = mockClock();
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            () => {
                clock.advance(181_000);
                return null;
            },
            // The message scrolls in from the right, one step per tenth of a second.
            ...keys(null, 53),
            () => {
                expect(screenText(term.screen)).toContain('Screen Protection System');
                return 'x';
            },
            () => {
                expect(term.screen.cell(10, 10).ch).toBe('☺');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('scrolls the whole message across and starts again', async () => {
        const clock = mockClock();
        const text = 'Screen Protection System, Press any key to continue...';
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            () => {
                clock.advance(181_000);
                return null;
            },
        );
        // In from the right (79 steps), off to the left, then round again.
        for (let i = 0; i < 79 + text.length + 1; i++) {
            term.feed(null);
        }
        term.feed('x', ...LEAVE);
        await run(game, term);
    });
});

describe('cheats', () => {
    const typeWord = (word: string): Key[] => [...word];

    test('HELPME trades all gold for 25 hitpoints', async () => {
        const { game } = await explore(typeWord('helpme'));
        expect(game.playing).toMatchObject({ gold: 0, maxHp: 125, hp: 125 });
    });

    test('TITANIC turns walls off and on', async () => {
        const through = await explore([...typeWord('TITANIC'), 'up']);
        expect(through.game.playing.y).toBe(9);
        const again = await explore([...typeWord('TITANIC'), ...typeWord('TITANIC'), 'up']);
        expect(again.game.playing.y).toBe(10);
    });

    test('TITANIC also lets the player through walls over the edge', async () => {
        const { game } = await explore([...typeWord('TITANIC'), 'right'], { player: player({ x: 79, y: 5 }) });
        expect(game.playing.screen).toBe(2);
    });

    test("SDEB shows the player's position", async () => {
        const { game, term } = setup({ player: player() });
        term.feed(...RESUME, ...typeWord('SDEB'), () => {
            expect(row(term.screen, 1)).toBe('X:10 Y:10 SCR:1 grass');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('QUAKE opens the settings editor', async () => {
        const { game } = await explore([...typeWord('QUAKE'), ...keys('enter', 9), ...typed('n'), ...typed('n')]);
        expect(game.playing.x).toBe(10);
    });

    test('a wrong letter breaks off, and that key still counts', async () => {
        const { game } = await explore(['h', 'e', 'right']);
        expect(game.playing.x).toBe(11);
    });

    test('other keys do nothing', async () => {
        const { game } = await explore(['z', 'enter', 'S']);
        expect(game.playing.x).toBe(10);
    });
});

// ---- Saving and loading

describe('saving', () => {
    test('needs a game in progress', async () => {
        const { game, term } = setup();
        term.feed('down', 'enter', () => {
            expect(row(term.screen, 24)).toContain('Start or load a game first.');
            return 'x';
        }, 'escape');
        await run(game, term);
    });

    test('saves the game under a name', async () => {
        const saves = new Saves(tempDir());
        await play(['down', 'enter', 'enter', ...typed('Hero'), 'escape'], { saves, player: player({ gold: 99 }) });
        expect(saves.list()[0]).toEqual({ slot: 1, name: 'Hero' });
        expect(saves.load(1)).toMatchObject({ gold: 99 });
    });

    test('an empty slot suggests the player\'s name', async () => {
        const saves = new Saves(tempDir());
        await play(['down', 'enter', 'enter', 'enter', 'escape'], { saves, player: player({ name: 'Ellis' }) });
        expect(saves.list()[0]?.name).toBe('Ellis');
    });

    test('a blank name is saved as NoName', async () => {
        const saves = new Saves(tempDir());
        await play(['down', 'enter', 'down', 'enter', ...typed(''), 'escape'], { saves, player: player() });
        expect(saves.list()[1]?.name).toBe('NoName');
    });

    test('asks before overwriting, and N keeps the old save', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Old', player());
        await play(['down', 'enter', 'enter', 'n', 'escape'], { saves, player: player() });
        expect(saves.list()[0]?.name).toBe('Old');
    });

    test('Y overwrites, starting from the old name', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Old', player());
        await play(['down', 'enter', 'enter', 'y', ...typed('er'), 'escape'], { saves, player: player({ gold: 1 }) });
        expect(saves.list()[0]?.name).toBe('Older');
        expect(saves.load(1)).toMatchObject({ gold: 1 });
    });

    test('Escape leaves the slot list', async () => {
        const saves = new Saves(tempDir());
        await play(['down', 'enter', 'up', 'down', 'escape', 'escape'], { saves, player: player() });
        expect(saves.list().every((s) => s.name === null)).toBe(true);
    });
});

describe('loading', () => {
    const LOAD: Key[] = ['down', 'down', 'enter'];

    test('loads a saved game and plays it', async () => {
        const saves = new Saves(tempDir());
        saves.save(2, 'Two', player({ x: 40, y: 12, gold: 3 }));
        const { game } = await play([...LOAD, 'down', 'enter', 'right', ...LEAVE], { saves });
        expect(game.playing).toMatchObject({ x: 41, y: 12, gold: 3 });
    });

    test("empty slots can't be picked", async () => {
        const saves = new Saves(tempDir());
        await play([...LOAD, 'enter', 'escape', 'escape'], { saves });
    });

    test('a damaged save says why and goes back to the menu', async () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'slot1.json'), JSON.stringify({ name: 'Bad', state: { gold: 'lots' } }));
        const { game, term } = setup({ saves: new Saves(dir) });
        term.feed(...LOAD, 'enter', () => {
            expect(row(term.screen, 24)).toBe("That save can't be loaded: slot1.json.gold: expected a whole number");
            return 'x';
        }, 'escape');
        await run(game, term);
        expect(() => game.playing).toThrow();
    });

    test("the content's upgradeSave sees the save as it was on disk", async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Old', { ...player(), flags: { visits: 2, met: false, name: '', legacy: 7 } });
        const seen: unknown[] = [];
        const upgrading: Content<TestFlags> = {
            ...testContent,
            upgradeSave: (saved, p) => {
                seen.push(saved);
                p.gold = 1234;
            },
        };
        const { game, term } = makeGameWith(upgrading, { world, monsters: onlyMonster(monster()), saves, steps: ['down', 'down', 'enter', 'enter', ...LEAVE] });
        await run(game, term);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ flags: { legacy: 7 } });
        expect(game.playing.gold).toBe(1234);
    });

    test('a save on a screen that no longer exists starts at the start screen', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Lost', player({ screen: 999 }));
        const { game } = await play([...LOAD, 'enter', ...LEAVE], { saves });
        expect(game.playing.screen).toBe(1);
    });
});

// ---- The debug settings editor

describe('settings editor', () => {
    test('S on the title screen only works in debug mode', async () => {
        await play(['s', 'escape']);
    });

    test("edits the player's numbers, monsters and flags", async () => {
        const { game, term } = setup({ debug: true });
        term.feed(
            () => {
                expect(row(term.screen, 25)).toBe('S - Set game settings');
                return 'S';
            },
            ...typed('2'), // screen
            ...typed('5'), // x
            ...typed('80'), // y: too big
            ...typed('6'), // y
            ...typed(''), // experience: unchanged
            ...typed('abc'), // hitpoints: not a number
            ...typed('500'), // hitpoints
            ...typed('300'), // max hp
            ...typed(''), // strength
            ...typed(''), // defense
            ...typed('77'), // gold
            ...typed('maybe'), // monsters: not Y or N
            ...typed('y'), // monsters
            ...typed('y'), // edit flags
            ...typed('4'), // visits
            ...typed('yes'), // met
            ...typed('Bob'), // name
            'escape',
        );
        await run(game, term);
        expect(game.playing).toMatchObject({
            screen: 2,
            x: 5,
            y: 6,
            hp: 300,
            maxHp: 300,
            gold: 77,
            strength: 10,
            monsters: true,
            flags: { visits: 4, met: true, name: 'Bob' },
        });
    });

    test("screens that don't exist are refused", async () => {
        const { game } = await play(['S', ...typed('99'), ...typed('3'), ...keys('enter', 8), ...typed('n'), ...typed('n'), 'escape'], { debug: true });
        expect(game.playing.screen).toBe(3);
    });

    test("hp can't end up above max hp, and flags accept any answer", async () => {
        const p = player({ hp: 100 });
        p.flags.visits = 3;
        await play(['S', ...keys('enter', 5), ...typed('50'), ...keys('enter', 3), ...typed('n'), ...typed('y'), ...typed('x'), ...typed('no'), ...typed(''), 'escape'], {
            debug: true,
            player: p,
        });
        expect(p).toMatchObject({ hp: 50, maxHp: 50, monsters: false, flags: { visits: 0, met: false, name: '' } });
    });

    test('S while exploring opens it in debug mode', async () => {
        const { game } = await play([...RESUME, 's', ...typed('3'), ...keys('enter', 9), ...typed('n'), ...LEAVE], { debug: true, player: player() });
        expect(game.playing).toMatchObject({ screen: 3, mapScreen: 1 });
    });

    test('starts the flags on a fresh page when the screen fills up', async () => {
        const many = { ...START, flags: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`flag${i}`, i])) };
        const { title, help, credits, worldMapLegend } = testContent;
        const content: Content<Record<string, number>> = { title, help, credits, worldMapLegend, start: many, world: {}, screens: {}, inventory: () => undefined, newGame: () => undefined, statusLine: () => '' };
        const { game, term } = makeGameWith(content, { world, monsters: onlyMonster(monster()), debug: true });
        term.feed('S', ...keys('enter', 10), 'y', () => {
            expect(row(term.screen, 24)).toContain('Edit flags? (Y/N): y');
            return 'enter';
        }, () => {
            expect(row(term.screen, 1)).toBe('flag0 (0):');
            expect(row(term.screen, 2)).toBe('');
            return 'enter';
        }, ...keys('enter', 11), 'escape');
        await run(game, term);
    });
});

test('readConfig reads config.json and rejects bad data', () => {
    expect(readConfig(readFixture('config.json'))).toMatchObject({ title: 'Test Quest', superhumanFactor: 3 });
    expect(() => readConfig({ title: 'x' })).toThrow('config.json.company: expected a string');
});

test("a start player with an item the catalogue doesn't have is refused", () => {
    const broken: Content<TestFlags> = { ...testContent, start: { ...START, items: { bazooka: 1 } } };
    expect(() => makeGameWith(broken, { world, monsters: onlyMonster(monster()) })).toThrow('There\'s no item "bazooka".');
});

describe('screen names and terrain', () => {
    // Screen 1 is named; 2 shares the name; 3 has another.
    const named = makeWorld(makeMap(1, 1, ['10,9']), makeMap(2, 5, ['1,5']), makeMap(3, 2), makeMap(82, 1));
    named.setName(1, 'Meadow');
    named.setName(2, 'Meadow');
    named.setName(3, 'Cottage');

    const namedGame = (p: Player<TestFlags>) => makeGameWith(testContent, { world: named, monsters: onlyMonster(monster()), player: p });

    test('arriving on a named screen shows its name', async () => {
        const { game, term } = namedGame(player());
        term.feed(
            ...RESUME,
            () => {
                expect(row(term.screen, 23)).toContain('Meadow');
                return 'down';
            },
            () => {
                expect(row(term.screen, 23)).toContain('Cottage');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test("walking to another screen with the same name doesn't show it again", async () => {
        const clock = mockClock();
        const { game, term } = namedGame(player({ x: 79, y: 10 }));
        term.feed(
            ...RESUME,
            () => {
                clock.advance(5000);
                return null;
            },
            'right',
            () => {
                expect(game.playing.screen).toBe(2);
                expect(row(term.screen, 23)).toContain('HP 100/100');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('monsters only attack on wild terrain', async () => {
        mockRandom(0);
        const roads = makeWorld(makeMap(1, 1, ['10,9']), makeMap(2, 5, ['1,5']), makeMap(3, 2));
        roads.setCell(2, 11, 10, { ch: ' ', fg: 15, bg: 6, solid: false, terrain: 'road' });
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        const blobs = onlyMonster(monster({ hp: 1, attack: 0, gold: 7 }));
        const { game, term } = makeGameWith(testContent, { world: roads, player: p, monsters: blobs, steps: [...RESUME, 'right', ...LEAVE] });
        await run(game, term);
        expect(p.gold).toBe(20);
    });
});

describe('messages, the back-buffer and the other keys', () => {
    test('messages from one step show in turn', async () => {
        const clock = mockClock();
        const { game, term } = setup({ player: player({ x: 14, y: 12 }) });
        term.feed(
            ...RESUME,
            'right',
            () => {
                expect(row(term.screen, 23)).toContain('First news.');
                clock.advance(4000);
                return null;
            },
            () => {
                expect(row(term.screen, 23)).toContain('Second news.');
                clock.advance(4000);
                return null;
            },
            () => {
                expect(row(term.screen, 23)).toContain('HP 100/100');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('with more waiting behind it, a message shows for less time', async () => {
        const clock = mockClock();
        const { game, term } = setup({ player: player({ x: 14, y: 12 }) });
        term.feed(
            ...RESUME,
            'right',
            () => {
                expect(row(term.screen, 23)).toContain('First news.');
                clock.advance(1500);
                return null;
            },
            () => {
                // The last one gets its full time.
                expect(row(term.screen, 23)).toContain('Second news.');
                clock.advance(3000);
                return null;
            },
            () => {
                expect(row(term.screen, 23)).toContain('Second news.');
                clock.advance(1000);
                return null;
            },
            () => {
                expect(row(term.screen, 23)).toContain('HP 100/100');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test("the next step's message replaces what's left", async () => {
        mockClock();
        const { game, term } = setup({ player: player({ x: 14, y: 12 }) });
        term.feed(
            ...RESUME,
            'right',
            'left',
            'right',
            () => {
                expect(row(term.screen, 23)).toContain('First news.');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('B shows past messages, newest at the bottom', async () => {
        const { game, term } = setup({ player: player({ x: 11, y: 10 }) });
        term.feed(
            ...RESUME,
            'b',
            () => {
                expect(screenText(term.screen)).toContain('Nothing has happened yet.');
                return 'escape';
            },
            'right',
            'B',
            () => {
                expect(row(term.screen, 1).trim()).toBe('Back-buffer: the last messages');
                expect(row(term.screen, 3).trim()).toBe('You step on a creaky board.');
                return 'escape';
            },
            () => {
                expect(term.screen.cell(12, 10).ch).toBe('☺');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('the back-buffer keeps the last 100 messages', async () => {
        const { game, term } = setup({ player: player() });
        for (let i = 1; i <= 105; i++) {
            game.message(`news ${i}`);
        }
        term.feed(
            ...RESUME,
            'b',
            'home',
            () => {
                expect(row(term.screen, 3).trim()).toBe('news 6');
                return 'escape';
            },
            'escape',
            'escape',
        );
        await run(game, term);
    });

    test('R redraws the whole screen', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            () => {
                term.out.written = '';
                return 'r';
            },
            () => {
                expect(term.out.written.startsWith('\x1b[0m\x1b[2J')).toBe(true);
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('? lists the keys', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            '?',
            () => {
                expect(screenText(term.screen)).toContain('the last messages (the back-buffer)');
                return 'escape';
            },
            ...LEAVE,
        );
        await run(game, term);
    });

    test('V opens the inventory, like I', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            'v',
            () => {
                expect(row(term.screen, 2)).toContain('INVENTORY gold=20');
                return 'x';
            },
            ...LEAVE,
        );
        await run(game, term);
    });
});

describe('fixes from the code review', () => {
    const blobs = (): Bestiary => onlyMonster(monster({ hp: 1, attack: 0, gold: 7 }));

    test('no fight from bumping into a wall', async () => {
        mockRandom(0);
        const walled = makeWorld(makeMap(1, 1, ['10,9']), makeMap(2, 5, ['11,10']), makeMap(3, 2));
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        const { game, term } = makeGameWith(testContent, { world: walled, player: p, monsters: blobs(), steps: [...RESUME, 'right', 'right', ...LEAVE] });
        await run(game, term);
        expect(p).toMatchObject({ x: 10, gold: 20 });
    });

    test('no fight from being turned back at the edge of the world', async () => {
        mockRandom(0);
        // Screen 2 is in the top row of the world, so there's nothing above it.
        const p = player({ screen: 2, x: 5, y: 1, monsters: true });
        const { game, term } = makeGameWith(testContent, { world, player: p, monsters: blobs(), steps: [...RESUME, 'up', ...LEAVE] });
        await run(game, term);
        expect(p.gold).toBe(20);
    });

    test('no fight on a tile a script handles', async () => {
        mockRandom(0);
        const scripted: Content<TestFlags> = { ...testContent, screens: { 2: { at: { '11,10': (g) => g.write('A tile.') } } } };
        const p = player({ screen: 2, x: 10, y: 10, monsters: true });
        const { game, term } = makeGameWith(scripted, { world, player: p, monsters: blobs(), steps: [...RESUME, 'right', ...LEAVE] });
        await run(game, term);
        expect(p).toMatchObject({ x: 11, gold: 20 });
    });

    test('a long stay in a menu doesn\'t start the screensaver on the way out', async () => {
        const clock = mockClock();
        const { game, term } = setup({ player: player() });
        term.feed(
            ...RESUME,
            'i',
            () => {
                clock.advance(200_000);
                return 'x';
            },
            null,
            () => {
                expect(screenText(term.screen)).not.toContain('Screen Protection System');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });

    test('a save placed off the map starts where new games do', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Odd', player({ screen: 3, x: 200, y: 5 }));
        const { game } = await play(['down', 'down', 'enter', 'enter', ...LEAVE], { saves });
        expect(game.playing).toMatchObject({ screen: 1, x: 10, y: 10 });
    });
});

describe('presence (for a server)', () => {
    test('with cheats off, the cheat words do nothing', async () => {
        const { game } = await explore([...'helpme'], { cheats: false });
        expect(game.playing).toMatchObject({ gold: 20, maxHp: 100 });
    });

    test('figures are drawn over the map, under the player, on their own background', async () => {
        const figures = (screen: number): Figure[] => (screen === 1 ? [{ x: 15, y: 5, ch: '☻', fg: 11 }, { x: 10, y: 10, ch: 'X', fg: 4 }, { x: 99, y: 99, ch: '!', fg: 4 }] : []);
        const { game, term } = setup({ player: player(), figures });
        term.feed(...RESUME, () => {
            expect(term.screen.cell(15, 5)).toMatchObject({ ch: '☻', fg: 11, bg: 2 });
            // The player is drawn on top of anything on their own cell.
            expect(term.screen.cell(10, 10).ch).toBe('☺');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('moved is told where the player is, each time it changes, once they wait for a key', async () => {
        const places: string[] = [];
        // (On open ground, clear of Test Quest's triggers.)
        await explore(['right', 'left', 'r', 'left'], { player: player({ x: 30, y: 15 }), moved: (p) => places.push(`${p.screen},${p.x},${p.y}`) });
        // (R redraws; the player didn't move, so moved isn't told again.)
        expect(places).toEqual(['1,30,15', '1,31,15', '1,30,15', '1,29,15']);
    });

    test('othersChanged redraws the figures, at the next wait for a key', async () => {
        let others: Figure[] = [];
        const { game, term } = setup({ player: player(), figures: () => others });
        term.feed(...RESUME, () => {
            expect(term.screen.cell(15, 5).ch).toBe(' ');
            others = [{ x: 15, y: 5, ch: '☻', fg: 11 }];
            game.othersChanged();
            // (A key that does nothing, so the game waits again.)
            return 'z';
        }, () => {
            expect(term.screen.cell(15, 5).ch).toBe('☻');
            others = [];
            game.othersChanged();
            return 'z';
        }, () => {
            expect(term.screen.cell(15, 5).ch).toBe(' ');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('waiting is true only while the game waits for a key on the map', async () => {
        const { game, term } = setup({ player: player() });
        const seen: boolean[] = [];
        term.feed(...RESUME, () => {
            seen.push(game.waiting);
            return 'i';
        }, () => {
            // (In the inventory, a scene of its own.)
            seen.push(game.waiting);
            return 'x';
        }, 'escape', 'escape');
        await run(game, term);
        // (A step's function runs as the key is read, before the wait ends.)
        expect(seen).toEqual([true, false]);
        expect(game.waiting).toBe(false);
    });

    test("figures moving redraw only their cells, keeping what the screen's show script drew", async () => {
        let others: Figure[] = [{ x: 30, y: 2, ch: '☻', fg: 11 }];
        // (Screen 1's show script draws MET at (30,2) once the player has met.)
        const { game, term } = setup({ player: player({ flags: { ...START.flags, met: true } }), figures: () => others });
        term.feed(...RESUME, () => {
            expect(term.screen.cell(30, 2).ch).toBe('☻');
            others = [{ x: 40, y: 15, ch: '☻', fg: 11 }];
            game.othersChanged();
            return 'z';
        }, () => {
            // The cell it left is the map's again; the new one has it.
            expect(term.screen.cell(30, 2).ch).toBe('M');
            expect(term.screen.cell(40, 15).ch).toBe('☻');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('refresh redraws the whole screen: the status line, and what the show script draws', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(...RESUME, () => {
            game.playing.gold = 77;
            game.playing.flags.met = true;
            game.refresh();
            return 'z';
        }, () => {
            expect(row(term.screen, 23)).toContain('Gold 77');
            expect(term.screen.cell(30, 2).ch).toBe('M');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('leaving a cell someone else is on leaves them showing', async () => {
        const others: Figure[] = [{ x: 30, y: 15, ch: '☻', fg: 11 }];
        const { game, term } = setup({ player: player({ x: 30, y: 15 }), figures: () => others });
        term.feed(...RESUME, 'right', () => {
            expect(term.screen.cell(30, 15).ch).toBe('☻');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('a flood of notices and messages is capped (the back-buffer keeps the last 100)', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(...RESUME, () => {
            for (let i = 0; i < 500; i++) {
                game.notify(`Notice ${i}.`);
            }
            return 'z';
        }, () => {
            // The oldest went: what's shown is from the last 50.
            expect(screenText(term.screen)).toContain('Notice 4');
            expect(screenText(term.screen)).not.toContain('Notice 0.');
            return 'escape';
        }, 'escape');
        await run(game, term);
    });

    test('notify shows a message on the map, and keeps it in the back-buffer', async () => {
        const { game, term } = setup({ player: player() });
        term.feed(...RESUME, () => {
            game.notify('Bob enters the realm.');
            return 'z';
        }, () => {
            expect(screenText(term.screen)).toContain('Bob enters the realm.');
            return 'b';
        }, () => {
            expect(screenText(term.screen)).toContain('Bob enters the realm.');
            return 'escape';
        }, ...LEAVE);
        await run(game, term);
    });

    test('fought is told how every fight ends, random or scripted', async () => {
        const fights: string[] = [];
        const fought = (p: Player<TestFlags>, m: Monster, result: string): void => {
            fights.push(`${p.screen}: ${m.name} ${result}`);
        };
        // A random fight on screen 2 (it has monsters), lost to a monster
        // that can't be hurt: attack until it's over, then leave.
        mockRandom(0);
        const { game, term } = setup({ player: player({ screen: 2, x: 5, y: 5, monsters: true }), monsters: onlyMonster(monster({ name: 'Wall', hp: 9999, attack: 200 })), fought });
        const untilOver: Step = () => (fights.length ? 'escape' : 'enter');
        term.feed(...RESUME, 'right', ...keys(untilOver, 30));
        await game.run();
        expect(fights).toEqual(['2: Wall lost']);

        const { g } = scriptContext({ fought, steps: ['enter', 'x', 'x'] });
        mockRandom(0.99);
        await g.fight(monster({ name: 'Gnat', hp: 1, attack: 0 }));
        expect(fights.at(-1)).toBe('1: Gnat won');
    });

    test('extra keys run their script, and ? lists them', async () => {
        const keys = {
            P: {
                help: "who's online",
                run: async (g: ScriptContext<TestFlags>) => {
                    g.cls();
                    g.print('ONLINE: you');
                    await g.key();
                },
            },
        };
        const { game, term } = setup({ player: player(), keys });
        term.feed(...RESUME, 'p', () => {
            expect(row(term.screen, 1)).toBe('ONLINE: you');
            return 'x';
        }, () => {
            // Back on the map.
            expect(term.screen.cell(10, 10).ch).toBe('☺');
            return '?';
        }, () => {
            expect(screenText(term.screen)).toContain("who's online");
            return 'escape';
        }, ...LEAVE);
        await run(game, term);
    });
});

describe("the world's state (g.world)", () => {
    // Into the hut (screen 3) and along to the bell at (20,5), which rings.
    const RING = ['down', ...keys('right', 15)];

    test('a script sets it; a save keeps it; a new game starts it again; loading brings it back', async () => {
        const saves = new Saves(tempDir());
        const { game, term } = setup({ saves });
        term.feed(
            // A new game, the bell rung, and saved in slot 1.
            'enter', 'x', ...RING,
            () => {
                expect(screenText(term.screen)).toContain('The bell has rung 1 times.');
                return 'escape';
            },
            'down', 'enter', 'enter', ...typed('Bell'),
            // Another new game (the menu is on Save Game now): the bell
            // hasn't been rung in this one.
            'up', 'enter', 'x',
            () => {
                expect({ ...game.worldState }).toEqual({ rings: 0, ringers: [] });
                return 'escape';
            },
            // Loading slot 1 brings back its world (and, standing on the
            // bell, the player rings it again as they arrive).
            'down', 'down', 'enter', 'enter',
            () => {
                expect({ ...game.worldState }).toEqual({ rings: 2, ringers: [''] });
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
        expect(saves.load(1)).toMatchObject({ world: { rings: 1, ringers: [''] } });
    });

    test('a save from before there was world state loads, with the starting values', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Old', player({ gold: 3 }));
        const { game } = await play(['down', 'down', 'enter', 'enter', ...LEAVE], { saves });
        expect(game.worldState.rings).toBe(0);
        expect(game.playing.gold).toBe(3);
    });

    test('a save with a bad world says why', async () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'Bad', { ...player(), world: { rings: 'lots' } });
        const { game, term } = setup({ saves });
        term.feed('down', 'down', 'enter', 'enter', () => {
            expect(row(term.screen, 24)).toContain('slot1.json.world.rings: expected a number');
            return 'x';
        }, 'escape');
        await run(game, term);
    });

    test('a store from outside (a server) is used, and kept by no save', () => {
        const store = new MemoryWorld();
        store.set('rings', 41);
        const { g } = scriptContext({ worldStore: store });
        expect(g.world.rings).toBe(41);
        g.world.rings++;
        expect(store.get('rings')).toBe(42);
    });

    test('g.news goes to the news option, or nowhere', () => {
        const news: string[] = [];
        scriptContext({ news: (text) => news.push(text) }).g.news('Something happened.');
        expect(news).toEqual(['Something happened.']);
        expect(() => {
            scriptContext().g.news('Nobody hears this.');
        }).not.toThrow();
    });
});

describe("the content's own keys", () => {
    const scene = (text: string) => async (g: ScriptContext<TestFlags, TestWorld>): Promise<void> => {
        g.cls();
        g.print(text);
        await g.key();
    };

    test("run their script, sit beside a server's keys, and are listed by ?", async () => {
        const content = { ...testContent, keys: { F: { help: 'fame and fortune', run: scene('FAME') } } };
        const { game, term } = makeGameWith(content, { world, player: player(), keys: { P: { help: "who's here", run: scene('PLAYERS') } } });
        term.feed(...RESUME, 'f', () => {
            expect(row(term.screen, 1)).toBe('FAME');
            return 'x';
        }, 'p', () => {
            expect(row(term.screen, 1)).toBe('PLAYERS');
            return 'x';
        }, '?', () => {
            const text = screenText(term.screen);
            expect(text).toContain('fame and fortune');
            expect(text).toContain("who's here");
            return 'escape';
        }, ...LEAVE);
        await run(game, term);
    });

    test.each([
        [{ content: { I: 'x' }, server: {} }, 'The content\'s key "I" is already used by the game.'],
        [{ content: { F: 'x' }, server: { F: 'x' } }, 'The server\'s key "F" is already used by the content.'],
        [{ content: { f: 'x' }, server: {} }, 'The content\'s key "f" must be one character (upper case, for a letter).'],
        [{ content: { FF: 'x' }, server: {} }, 'The content\'s key "FF" must be one character'],
    ])('a key can only mean one thing: %p', ({ content: c, server }, message) => {
        const key = (keys: Record<string, string>) => Object.fromEntries(Object.keys(keys).map((k) => [k, { help: k, run: () => undefined }]));
        expect(() => makeGameWith({ ...testContent, keys: key(c) }, { world, keys: key(server) })).toThrow(message);
    });

    test('S is the game\'s in debug mode, and free otherwise', () => {
        const keys = { S: { help: 'stats', run: () => undefined } };
        expect(() => makeGameWith({ ...testContent, keys }, { world, debug: true })).toThrow('The content\'s key "S" is already used by the game.');
        expect(() => makeGameWith({ ...testContent, keys }, { world })).not.toThrow();
    });
});

describe('multiplayer groundwork', () => {
    test('autosave gets the player after a screen change, a script and leaving the map', async () => {
        const saved: { screen: number; x: number; met: boolean }[] = [];
        const autosave = (p: Player<TestFlags>): void => {
            saved.push({ screen: p.screen, x: p.x, met: p.flags.met });
        };
        const { game, term } = makeGameWith(testContent, {
            world,
            monsters: onlyMonster(monster()),
            player: player(),
            autosave,
            steps: [...RESUME, 'down', ...LEAVE],
        });
        await run(game, term);
        expect(saved).toEqual([
            // Through the door to screen 3...
            { screen: 3, x: 5, met: false },
            // ...where the tile's script runs on arrival...
            { screen: 3, x: 5, met: true },
            // ...then back to the title menu.
            { screen: 3, x: 5, met: true },
        ]);
    });

    test('autosave after a script that only changes the player', async () => {
        const saved: number[] = [];
        const { game, term } = makeGameWith(testContent, {
            world,
            monsters: onlyMonster(monster()),
            player: player({ x: 11, y: 10 }),
            autosave: (p) => saved.push(p.flags.visits),
            steps: [...RESUME, 'right', 'escape', 'escape'],
        });
        await run(game, term);
        expect(saved).toEqual([1, 1]);
    });

    test('showingMap is only true while the map is on screen', async () => {
        const { game, term } = setup({ player: player() });
        expect(game.showingMap).toBe(false);
        term.feed(
            ...RESUME,
            () => {
                expect(game.showingMap).toBe(true);
                return 'i';
            },
            () => {
                expect(game.showingMap).toBe(false);
                return 'x';
            },
            () => {
                expect(game.showingMap).toBe(true);
                return 'left';
            },
            () => {
                // The sign's script took the screen.
                expect(game.showingMap).toBe(false);
                return 'x';
            },
            () => {
                expect(game.showingMap).toBe(true);
                return 'escape';
            },
            () => {
                expect(game.showingMap).toBe(false);
                return 'escape';
            },
        );
        await run(game, term);
    });

    test('screen names with braces show as they are', async () => {
        const odd = makeWorld(makeMap(1, 1, ['10,9']), makeMap(2, 5), makeMap(3, 2));
        odd.setName(1, '{red}Trap');
        const { game, term } = makeGameWith(testContent, { world: odd, monsters: onlyMonster(monster()), player: player() });
        term.feed(
            ...RESUME,
            () => {
                expect(row(term.screen, 23)).toContain('{red}Trap');
                return 'escape';
            },
            'escape',
        );
        await run(game, term);
    });
});

describe('playing without the title menu (for a server)', () => {
    test('begin starts a new game with the given player', async () => {
        const { game, term } = setup();
        const p = game.freshPlayer();
        p.gold = 999;
        term.feed('x', 'right', 'escape');
        await game.begin(p);
        expect(game.playing).toMatchObject({ gold: 999, x: 11 });
        expect(term.remaining).toBe(0);
    });

    test('resume carries on, running the arrival trigger unless told not to', async () => {
        const { game, term } = setup();
        term.feed('escape');
        await game.resume(player({ x: 10, y: 11 }));
        expect(game.playing.screen).toBe(3);
        term.feed('escape');
        await game.resume(player({ x: 10, y: 11 }), { arrive: false });
        expect(game.playing.screen).toBe(1);
    });

    test('resume puts a player off the map back at the start', async () => {
        const { game, term } = setup();
        term.feed('escape');
        await game.resume(player({ screen: 99, x: 5, y: 5 }));
        expect(game.playing).toMatchObject({ screen: 1, x: 10, y: 10 });
    });

    test('without the screensaver, an idle player just waits', async () => {
        const clock = mockClock();
        const { game, term } = makeGameWith(testContent, { world, monsters: onlyMonster(monster()), screensaver: false });
        term.feed(
            () => {
                clock.advance(10 * 60_000);
                return null;
            },
            () => {
                expect(screenText(term.screen)).not.toContain('Screen Protection');
                return 'escape';
            },
        );
        await game.resume(player());
    });

    test('a game without save slots says so if asked to save', async () => {
        const { game, term } = makeGameWith(testContent, { world, monsters: onlyMonster(monster()), noSaves: true, player: player() });
        term.feed('down', 'enter');
        expect(await caught(game.run())).toEqual(new Error('This game has no save slots.'));
    });
});
