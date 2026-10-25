import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD_API, applyMods, describeMod, loadMods, readMod, type LoadedMod, type Mod, type ModdableGame } from '../src/mods.ts';
import { Bestiary, readBestiary } from '../src/combat.ts';
import { readItems } from '../src/items.ts';
import { blankMap, writeMap } from '../src/world.ts';
import { caught, monster, row, screenText, tempDir } from '../src/testing.ts';
import { bestiary, content, itemCatalogue, makeGameWith, newPlayer, scriptContext, testWorld, type TestFlags } from '../src/fixture.ts';
import { ScriptContext } from '../src/script.ts';
import { restorePlayer } from '../src/player.ts';

// Test Quest, ready to add mods to.
const game = (): ModdableGame<TestFlags> => ({ content, world: testWorld(), items: itemCatalogue, monsters: bestiary });

// A mod as loadMods would give it, with nothing but `mod` unless told.
function loaded(mod: Partial<Mod> & { id: string }, extra: Partial<LoadedMod> = {}): LoadedMod {
    return { mod: readMod({ name: mod.id, version: '1.0', api: MOD_API, ...mod }, `${mod.id}/mod.ts`), dir: mod.id, items: null, monsters: null, maps: [], ...extra };
}

// Writes a mod folder: mod.ts with this source, and any other files.
function writeMod(dir: string, name: string, source: string, files: Record<string, unknown> = {}): void {
    mkdirSync(join(dir, name, 'maps'), { recursive: true });
    writeFileSync(join(dir, name, 'mod.ts'), source);
    for (const [file, data] of Object.entries(files)) {
        writeFileSync(join(dir, name, file), JSON.stringify(data));
    }
}

// A monster entry as monsters.json has them.
const creature = (id: string, changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, name: id, pronoun: 'it', hp: 5, gold: 1, exp: 1, says: '...', attacks: [{ text: 'bites', power: 1 }], kill: 'Gone.', ...changes,
});

const SOURCE = (id: string, rest = ''): string => `export default { id: '${id}', name: 'The ${id}', version: '0.1', api: ${MOD_API}${rest} };\n`;

describe('readMod', () => {
    test('reads a mod, wrapping its scripts', async () => {
        const said: string[] = [];
        const mod = readMod({ id: 'well', name: 'Well', version: '1.2', api: MOD_API, description: 'A well.', flags: { wishes: 0 }, newGame: () => said.push('new') }, 'well/mod.ts');
        expect(mod).toMatchObject({ id: 'well', name: 'Well', version: '1.2', description: 'A well.', flags: { wishes: 0 } });
        await mod.newGame?.(scriptContext().g, { flags: {} });
        expect(said).toEqual(['new']);
    });

    test.each([
        [undefined, 'x/mod.ts: expected a default export (the mod)'],
        [{ id: 'Big Mod', name: 'x', version: '1', api: MOD_API }, 'x/mod.ts.id: expected lower case letters, digits and dashes, found "Big Mod"'],
        [{ id: 'm', name: 'x', version: '1', api: 99 }, `The mod "m" was written for mod API 99; this engine has mod API ${MOD_API}.`],
        [{ id: 'm', name: 'x', version: 1, api: MOD_API }, 'x/mod.ts.version: expected a string'],
        [{ id: 'm', name: 'x', version: '1', api: MOD_API, flags: { a: [] } }, 'x/mod.ts.flags.a: expected true or false, a number or a string'],
        [{ id: 'm', name: 'x', version: '1', api: MOD_API, screens: { one: {} } }, 'x/mod.ts.screens.one: expected a screen number'],
        [{ id: 'm', name: 'x', version: '1', api: MOD_API, screens: { 1: { at: { middle: () => undefined } } } }, 'x/mod.ts.screens.1.at.middle: expected a tile as "x,y"'],
        [{ id: 'm', name: 'x', version: '1', api: MOD_API, screens: { 1: { show: 'hello' } } }, 'x/mod.ts.screens.1.show: expected a function'],
        [{ id: 'm', name: 'x', version: '1', api: MOD_API, events: { e: 5 } }, 'x/mod.ts.events.e: expected a function'],
    ])('refuses bad mods: %p', (value, message) => {
        expect(() => readMod(value, 'x/mod.ts')).toThrow(message);
    });
});

describe('applyMods', () => {
    test('adds items, monsters, tables and screens, leaving the game as it was', () => {
        const items = readItems([{ id: 'lucky-coin', name: 'Lucky Coin', kind: 'misc' }]);
        const monsters = readBestiary({ monsters: [creature('eel', { name: 'Eel' })], tables: [{ name: 'well', chance: 5, tiers: [], monsters: ['eel'] }] });
        const base = game();
        const modded = applyMods(base, [loaded({ id: 'well' }, { items, monsters, maps: [blankMap(500, 2)] })]);
        expect(modded.items.get('lucky-coin').name).toBe('Lucky Coin');
        expect(modded.items.has('stick')).toBe(true);
        expect(modded.monsters.monster('eel').name).toBe('Eel');
        expect(modded.monsters.hasTable('well')).toBe(true);
        expect(modded.monsters.hasTable('default')).toBe(true);
        expect(modded.world.has(500)).toBe(true);
        expect(base.world.has(500)).toBe(false);
        expect(base.items.has('lucky-coin')).toBe(false);
    });

    test('with no mods, the game is the same', () => {
        const modded = applyMods(game(), []);
        expect(modded.world.screens()).toEqual([1, 2, 3, 82]);
        expect(modded.content.start).toEqual(content.start);
    });

    const conflicts: [string, () => LoadedMod, string][] = [
        ['an item', () => loaded({ id: 'm' }, { items: readItems([{ id: 'stick', name: 'Stick', kind: 'misc' }]) }), 'The mod "m" adds the item "stick", which the game (or another mod) already has.'],
        ['a monster', () => loaded({ id: 'm' }, { monsters: readBestiary({ monsters: [creature('owl')], tables: [] }) }), 'adds the monster "owl"'],
        ['a table', () => loaded({ id: 'm' }, { monsters: new Bestiary(new Map(), [{ name: 'forest', chance: 1, tiers: [], monsters: [monster()] }]) }), 'adds the encounter table "forest"'],
        ['a screen', () => loaded({ id: 'm' }, { maps: [blankMap(1, 1)] }), 'adds screen 1'],
        ['a trigger', () => loaded({ id: 'm', screens: { 1: { at: { '12,10': () => undefined } } } }), 'adds a trigger at 12,10 on screen 1'],
        ['an event', () => loaded({ id: 'm', events: { 'elf-berries': () => undefined } }), 'adds the event "elf-berries"'],
    ];
    test.each(conflicts)("adding %s that's already there is an error", (_, mod, message) => {
        expect(() => applyMods(game(), [mod()])).toThrow(message);
    });

    test('two mods adding the same thing is an error too', () => {
        const coin = (): LoadedMod => loaded({ id: 'b' }, { items: readItems([{ id: 'coin', name: 'Coin', kind: 'misc' }]) });
        expect(() => applyMods(game(), [loaded({ id: 'a' }, { items: readItems([{ id: 'coin', name: 'Coin', kind: 'misc' }]) }), coin()])).toThrow('The mod "b" adds the item "coin"');
    });

    test('scripts for a screen that does not exist are an error', () => {
        expect(() => applyMods(game(), [loaded({ id: 'm', screens: { 404: { at: { '1,1': () => undefined } } } })])).toThrow('The mod "m" has scripts for screen 404, which doesn\'t exist.');
    });

    test("a mod's flags start in the player as <mod id>.<flag>", () => {
        const modded = applyMods(game(), [loaded({ id: 'well', flags: { wishes: 0, lucky: false } })]);
        const flags: Record<string, unknown> = modded.content.start.flags;
        expect(flags).toEqual({ ...content.start.flags, 'well.wishes': 0, 'well.lucky': false });
    });
});

test("saves keep a mod's flags, and drop them once the mod is gone", () => {
    const modded = applyMods(game(), [loaded({ id: 'well', flags: { wishes: 0 } })]);
    const saved = { flags: { visits: 1, 'well.wishes': 3 } };
    expect(restorePlayer(modded.content.start, saved, itemCatalogue).flags).toMatchObject({ visits: 1, 'well.wishes': 3 });
    expect(restorePlayer(content.start, saved, itemCatalogue).flags).toEqual({ visits: 1, met: false, name: '' });
});

describe('playing with mods', () => {
    // Test Quest with this mod, a player on screen 1 at (10,10).
    function play(mods: LoadedMod[], player = newPlayer()) {
        const modded = applyMods(game(), mods);
        const start = { ...player, flags: { ...modded.content.start.flags, ...player.flags } };
        return makeGameWith(modded.content, { ...modded, world: modded.world, player: start });
    }

    // Resumes from the title menu, plays `steps`, and leaves.
    const RESUME = ['down', 'down', 'down', 'down', 'enter'];
    const LEAVE = ['escape', 'escape'];

    test("a mod's trigger runs with the mod's own flags, kept in the player", async () => {
        const well = loaded({
            id: 'well',
            flags: { wishes: 0 },
            screens: {
                1: {
                    at: {
                        '10,11': () => undefined,
                    },
                },
            },
        });
        // (10,11) is the game's door; a mod can't take it.
        expect(() => play([well])).toThrow('adds a trigger at 10,11 on screen 1');

        const wishing = loaded({
            id: 'well',
            flags: { wishes: 0 },
            screens: {
                1: {
                    at: {
                        '20,16': (g, { flags }) => {
                            flags['wishes'] = Number(flags['wishes']) + 1;
                            g.write(`You make wish number ${flags['wishes']}.`);
                        },
                    },
                },
            },
        });
        // (Clear of Test Quest's own triggers.)
        const { game: running, term } = play([wishing], newPlayer({ x: 20, y: 15 }));
        term.feed(...RESUME, 'down', () => {
            expect(screenText(term.screen)).toContain('You make wish number 1.');
            return 'up';
        }, 'down', ...LEAVE);
        await running.run();
        expect(running.playing.flags).toMatchObject({ 'well.wishes': 2 });
    });

    test("show scripts run after the game's, in mod order", async () => {
        const shown: string[] = [];
        const show = (id: string): LoadedMod => loaded({ id, screens: { 1: { show: () => {
            shown.push(id);
        } } } });
        const { game: running, term } = play([show('a'), show('b')], newPlayer({}, { met: true }));
        term.feed(...RESUME, () => {
            // The game's own show script (MET) ran too.
            expect(row(term.screen, 2)).toContain('MET');
            return 'escape';
        }, 'escape');
        await running.run();
        expect(shown.slice(0, 2)).toEqual(['a', 'b']);
    });

    test("a mod's newGame runs after the game's opening", async () => {
        const gifts = loaded({ id: 'gift', newGame: (g) => {
            g.give('stick');
        } });
        const { game: running, term } = play([gifts]);
        term.feed('enter', () => {
            expect(row(term.screen, 1)).toBe('A NEW GAME BEGINS');
            return 'x';
        }, 'escape', 'escape');
        await running.run();
        expect(running.playing.items).toEqual({ stick: 1 });
    });

    test("a mod's monster can run a mod's event after a fight", async () => {
        const monsters = readBestiary({ monsters: [creature('eel', { hp: 1, attacks: [{ text: 'bites', power: 0 }], kill: '', after: { won: 'eel-prize' } })], tables: [] });
        const prize = loaded({ id: 'eels', flags: { won: false }, events: { 'eel-prize': (_g, { flags }) => {
            flags['won'] = true;
        } } }, { monsters });
        const modded = applyMods(game(), [prize]);
        const { game: running, term } = makeGameWith(modded.content, { ...modded, player: { ...newPlayer(), flags: { ...modded.content.start.flags } }, steps: ['enter', 'x', 'x'] });
        const g = new ScriptContext(running);
        // A high roll: the player hits first and wins in one blow.
        const random = spyOn(Math, 'random').mockReturnValue(0.99);
        try {
            expect(await g.fight({ ...modded.monsters.monster('eel'), defense: 0 })).toBe('won');
        } finally {
            random.mockRestore();
        }
        expect(running.playing.flags).toMatchObject({ 'eels.won': true });
        expect(term.remaining).toBe(0);
    });
});

describe('loadMods', () => {
    test('loads each folder, sorted by id, with its data; _ and . folders are left out', async () => {
        const dir = tempDir();
        writeMod(dir, 'z-folder', SOURCE('alpha'), {
            'items.json': [{ id: 'coin', name: 'Coin', kind: 'misc' }],
            'monsters.json': { monsters: [], tables: [] },
        });
        writeMod(dir, 'a-folder', SOURCE('beta', ", screens: { 1: { at: { '1,1': (g) => g.write('hi') } } }"));
        writeMod(dir, '_off', SOURCE('off'));
        writeMod(dir, '.hidden', SOURCE('hidden'));
        writeFileSync(join(dir, 'notes.txt'), 'not a mod');
        writeFileSync(join(dir, 'z-folder', 'maps', '0500.json'), writeMap(blankMap(500, 2)));
        const mods = await loadMods(dir);
        expect(mods.map(describeMod)).toEqual(['The alpha 0.1 (alpha)', 'The beta 0.1 (beta)']);
        expect(mods[0]?.items?.get('coin').name).toBe('Coin');
        expect(mods[0]?.maps.map((m) => m.screen)).toEqual([500]);
        expect(mods[1]?.mod.screens?.[1]?.at?.['1,1']).toBeFunction();
    });

    test('mod.js works too, and a missing folder has no mods', async () => {
        const dir = tempDir();
        mkdirSync(join(dir, 'js'));
        writeFileSync(join(dir, 'js', 'mod.js'), SOURCE('js'));
        expect((await loadMods(dir)).map((m) => m.mod.id)).toEqual(['js']);
        expect(await loadMods(join(dir, 'nowhere'))).toEqual([]);
    });

    test("a folder without mod.ts, or two mods with one id, won't load", async () => {
        const empty = tempDir();
        mkdirSync(join(empty, 'nothing'));
        expect(String(await caught(loadMods(empty)))).toContain(`The mod in ${join(empty, 'nothing')} has no mod.ts (or mod.js).`);

        const twins = tempDir();
        writeMod(twins, 'one', SOURCE('same'));
        writeMod(twins, 'two', SOURCE('same'));
        expect(String(await caught(loadMods(twins)))).toContain('Two mods have the id "same"');
    });

    test("a mod's data files are checked, naming the mod", async () => {
        const dir = tempDir();
        writeMod(dir, 'bad', SOURCE('bad'), { 'items.json': [{ id: 'x', name: 'X', kind: 'food' }] });
        expect(String(await caught(loadMods(dir)))).toContain('bad/items.json[0].kind');
    });
});

