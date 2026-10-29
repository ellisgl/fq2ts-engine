// Games made for a screen other than 80x25 (Config.screen): a 120x37 game,
// whose map is 119x34, with the status bar and fights at the bottom.

import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bestiary, type Monster } from '../src/combat.ts';
import { Game, readConfig, type Content } from '../src/game.ts';
import { MOD_API, applyMods, loadMods, readMod } from '../src/mods.ts';
import { Screen } from '../src/screen.ts';
import { Terminal } from '../src/terminal.ts';
import { draw } from '../src/text.ts';
import { scrollText } from '../src/ui.ts';
import { World, blankMap, mapSize, readMap, writeMap } from '../src/world.ts';
import { FakeInput, FakeOutput, FakeTerminal, caught, makeMap, makeWorld, monster, row, tempDir } from '../src/testing.ts';
import { config, content, itemCatalogue, makeGameWith, newPlayer, type TestFlags, type TestWorld } from '../src/fixture.ts';

const SIZE = { width: 120, height: 37 };
const MAP = { width: 119, height: 34 };
const big = { ...config, screen: SIZE };
// Test Quest's content, with no triggers (its own are on its 79x22 maps).
const bigContent: Content<TestFlags, TestWorld> = { ...content, screens: {} };
// Screen 1 (land) and screen 2 east of it (land with monsters).
const bigWorld = (): World => makeWorld(makeMap(1, 1, [], MAP), makeMap(2, 5, [], MAP));

const LEAVE = ['escape', 'escape'];
const RESUME = ['down', 'down', 'down', 'down', 'enter'];

const mocks: Mock<() => number>[] = [];
afterEach(() => {
    for (const m of mocks.splice(0)) {
        m.mockRestore();
    }
});

function onlyMonster(m: Monster): Bestiary {
    return new Bestiary(new Map([['only', m]]), [{ name: 'default', chance: 1, tiers: [], monsters: [m] }]);
}

describe('config.json', () => {
    test('the screen is 80x25 unless it says otherwise', () => {
        const rest: Record<string, unknown> = { ...big };
        delete rest['screen'];
        expect(readConfig(rest).screen).toEqual({ width: 80, height: 25 });
        expect(readConfig(big).screen).toEqual(SIZE);
    });

    test('a screen smaller than 80x25, or not in whole numbers, is refused', () => {
        expect(() => readConfig({ ...big, screen: { width: 60, height: 37 } })).toThrow('config.json.screen: expected at least 80x25, found 60x37');
        expect(() => readConfig({ ...big, screen: { width: 120.5, height: 37 } })).toThrow('config.json.screen.width');
    });

    test('the map is the screen less the last column and the bottom three rows', () => {
        expect(mapSize(SIZE)).toEqual(MAP);
        expect(mapSize({ width: 80, height: 25 })).toEqual({ width: 79, height: 22 });
    });
});

describe('maps', () => {
    test('are read at the game\'s map size, and the wrong size is refused', () => {
        const json = (map: ReturnType<typeof blankMap>): unknown => JSON.parse(writeMap(map));
        expect(readMap(json(blankMap(7, 1, undefined, MAP)), '0007.json', MAP).tiles).toHaveLength(34);
        expect(() => readMap(json(blankMap(7, 1)), '0007.json', MAP)).toThrow('0007.json.tiles[0]: expected 119 cells, found 79');
    });

    test('a world only takes screens of its size', () => {
        expect(() => new World(new Map([[1, makeMap(1)]]), MAP)).toThrow("Screen 1 is 79x22, but this world's screens are 119x34.");
        const world = bigWorld();
        expect(world.size).toEqual(MAP);
        expect(() => {
            world.put(makeMap(3));
        }).toThrow("Screen 3 is 79x22, but this world's screens are 119x34.");
    });

    test('World.load reads a folder at a size', () => {
        const dir = tempDir();
        writeFileSync(join(dir, '0001.json'), writeMap(blankMap(1, 1, undefined, MAP)));
        expect(World.load(dir, MAP).size).toEqual(MAP);
        expect(() => World.load(dir)).toThrow('0001.json.tiles[0]: expected 79 cells, found 119');
    });
});

describe('the terminal and the game', () => {
    test('a terminal smaller than the game is refused', () => {
        const term = new Terminal({ input: new FakeInput(), output: new FakeOutput(), name: 'Big Quest', size: SIZE });
        expect(term.screen).toMatchObject(SIZE);
        expect(() => {
            term.start();
        }).toThrow('Big Quest needs a terminal of at least 120x37 (this one is 80x25).');
    });

    test('a game is refused a terminal or a world of another size', () => {
        const options = { config: big, monsters: onlyMonster(monster()), items: itemCatalogue, content: bigContent };
        expect(() => new Game({ ...options, term: new FakeTerminal(), world: bigWorld() })).toThrow('Test Quest is made for a 120x37 screen, but its terminal\'s is 80x25');
        expect(() => new Game({ ...options, term: new FakeTerminal([], { size: SIZE }), world: makeWorld(makeMap(1)) })).toThrow("Test Quest's screens should be 119x34 (the map of a 120x37 screen), but its world's are 79x22.");
    });

    test('the status bar is under the map, as wide as it', async () => {
        const { game, term } = makeGameWith(bigContent, { config: big, world: bigWorld(), player: newPlayer({ x: 100, y: 30 }), monsters: onlyMonster(monster()) });
        term.feed(...RESUME, () => {
            expect(term.screen.cell(100, 30).ch).toBe('☺');
            expect(row(term.screen, 35)).toContain('HP 100/100 Gold 20');
            expect(term.screen.cell(118, 35).ch).toBe('▒');
            expect(term.screen.cell(119, 35).ch).toBe('░');
            return 'escape';
        }, 'escape');
        await game.run();
        expect(term.remaining).toBe(0);
    });

    test('the player walks to the far edges, and over them', async () => {
        const right = makeGameWith(bigContent, { config: big, world: bigWorld(), player: newPlayer({ x: 118, y: 34 }), steps: [...RESUME, 'right', 'down', 'right', ...LEAVE] });
        await right.game.run();
        expect(right.game.playing).toMatchObject({ screen: 2, x: 1, y: 34 });
    });

    test('fights are on the bottom three rows', async () => {
        mocks.push(spyOn(Math, 'random').mockReturnValue(0));
        const blob = onlyMonster(monster({ name: 'Blob', says: 'Bloop', hp: 1, attack: 0, gold: 7, exp: 3 }));
        const p = newPlayer({ screen: 2, x: 10, y: 10, monsters: true });
        const { game, term } = makeGameWith(bigContent, { config: big, world: bigWorld(), player: p, monsters: blob });
        term.feed(...RESUME, 'right', () => {
            expect(row(term.screen, 35)).toContain("Blob's hitpoints");
            expect(row(term.screen, 36)).toContain('Bloop');
            return 'enter';
        }, 'enter', 'x', 'x', ...LEAVE);
        await game.run();
        expect(p).toMatchObject({ x: 11, gold: 27, exp: 3 });
    });
});

describe('drawing', () => {
    test('{center} centres on the whole screen', () => {
        const screen = new Screen('true', SIZE);
        draw(screen, '{center}ABCD', { y: 5 });
        expect(screen.cell(59, 5).ch).toBe('A');
        expect(screen.cell(62, 5).ch).toBe('D');
    });

    test('text scrolls a page as tall as the screen, with its help on the bottom row', async () => {
        const term = new FakeTerminal([() => {
            expect(row(term.screen, 3)).toBe(' line 1');
            expect(row(term.screen, 35)).toBe(' line 33');
            expect(row(term.screen, 36)).toBe('');
            expect(row(term.screen, 37)).toContain('1-33 of 40');
            return 'escape';
        }], { size: SIZE });
        await scrollText(term, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`));
        expect(term.remaining).toBe(0);
    });
});

describe('mods', () => {
    const SOURCE = `export default { id: 'tower', name: 'The Tower', version: '1.0', api: ${MOD_API} };\n`;

    test("are read at the game's map size", async () => {
        const dir = tempDir();
        mkdirSync(join(dir, 'tower', 'maps'), { recursive: true });
        writeFileSync(join(dir, 'tower', 'mod.ts'), SOURCE);
        writeFileSync(join(dir, 'tower', 'maps', '0003.json'), writeMap(blankMap(3, 1)));
        expect(String(await caught(loadMods(dir, ['tower'], MAP)))).toContain('tower/maps/0003.json.tiles[0]: expected 119 cells, found 79');

        writeFileSync(join(dir, 'tower', 'maps', '0003.json'), writeMap(blankMap(3, 1, undefined, MAP)));
        const [tower] = await loadMods(dir, ['tower'], MAP);
        expect(tower?.maps[0]?.tiles).toHaveLength(34);
    });

    test('adding a screen of another size names the mod', () => {
        const mod = readMod({ id: 'tower', name: 'The Tower', version: '1.0', api: MOD_API }, 'tower/mod.ts');
        const game = { content: bigContent, world: bigWorld(), items: itemCatalogue, monsters: onlyMonster(monster()) };
        expect(() => applyMods(game, [{ mod, dir: 'tower', items: null, monsters: null, maps: [makeMap(3)] }])).toThrow('The mod "tower" adds screen 3 at 79x22, but the game\'s screens are 119x34.');
    });
});
