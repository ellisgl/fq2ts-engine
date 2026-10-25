import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { HEIGHT } from '../src/screen.ts';
import { readItems } from '../src/items.ts';
import { makeMap, makeWorld, monster, row, typed } from '../src/testing.ts';
import { newPlayer, scriptContext } from '../src/fixture.ts';

let random: Mock<() => number> | null = null;
afterEach(() => {
    random?.mockRestore();
    random = null;
});

describe('ScriptContext: the player', () => {
    test("reads the player's state", () => {
        const { g } = scriptContext({ player: newPlayer({ x: 3, y: 4, screen: 82, exp: 7 }, { visits: 5 }) });
        expect([g.x, g.y, g.screenNumber, g.exp, g.flags.visits]).toEqual([3, 4, 82, 7, 5]);
        expect(g.version).toBe('V1.0 Rev A');
    });

    test('hp stays between 0 and maxHp, in whole numbers', () => {
        const { g, game } = scriptContext();
        g.hp = 1000;
        expect(g.hp).toBe(100);
        g.hp = -5;
        expect(g.hp).toBe(0);
        g.hp = 10.7;
        expect(game.playing.hp).toBe(10);
    });

    test('maxHp is at least 1', () => {
        const { g } = scriptContext();
        g.maxHp = 0;
        expect(g.maxHp).toBe(1);
        g.maxHp = 300.9;
        expect(g.maxHp).toBe(300);
    });

    test('gold, strength, defense and exp are whole and never negative', () => {
        const { g, game } = scriptContext();
        g.gold = -10;
        g.strength = 12.9;
        g.defense = -1;
        g.exp = 5.5;
        expect([g.gold, g.strength, g.defense, g.exp]).toEqual([0, 12, 0, 5]);
        expect(game.playing.strength).toBe(12);
    });

    test('flags', () => {
        const { g, game } = scriptContext();
        g.flags.met = true;
        expect(game.playing.flags.met).toBe(true);
    });

    test('healFull', () => {
        const { g } = scriptContext({ player: newPlayer({ hp: 3 }) });
        g.healFull();
        expect(g.hp).toBe(100);
    });

    test('using it with no game in progress is an error', () => {
        const { g, game } = scriptContext();
        Object.assign(game, { player: null });
        expect(() => g.hp).toThrow('No game is in progress.');
    });
});

describe('ScriptContext: talking', () => {
    test('write shows a message in the status bar', () => {
        const { g, term } = scriptContext();
        g.write('Hello!');
        expect(row(term.screen, 23)).toContain('Hello!');
        expect(g.tookScreen).toBe(false);
    });

    test('cls and print take over the screen, printing downwards', () => {
        const { g, term } = scriptContext();
        term.screen.text(1, 1, 'old', 15, 0);
        g.cls();
        expect(row(term.screen, 1)).toBe('');
        g.print('one', 'two');
        g.print('{y 10}three', 'four');
        expect([row(term.screen, 1), row(term.screen, 2), row(term.screen, 10), row(term.screen, 11)]).toEqual(['one', 'two', 'three', 'four']);
        expect(g.tookScreen).toBe(true);
    });

    test('print never goes below the last row', () => {
        const { g, term } = scriptContext();
        g.cls();
        g.print(...Array.from({ length: 30 }, (_, i) => `line ${i}`));
        expect(row(term.screen, HEIGHT)).toBe('line 29');
    });

    test('overlay draws without taking the screen', () => {
        const { g, term } = scriptContext();
        g.overlay('{x 5}{y 5}hi');
        expect(term.screen.cell(5, 5).ch).toBe('h');
        expect(g.tookScreen).toBe(false);
    });

    test('key waits for a key', async () => {
        const { g } = scriptContext({ steps: ['q'] });
        expect(await g.key()).toBe('q');
    });

    test('choice lists the options below the printed text', async () => {
        const { g, term } = scriptContext({ steps: ['down', 'enter'] });
        g.cls();
        g.print('Pick one');
        expect(await g.choice(['Yes', 'No'])).toBe(1);
        expect(row(term.screen, 2)).toBe('Yes');
        expect(row(term.screen, 3)).toBe('No');
        g.print('after');
        expect(row(term.screen, 4)).toBe('after');
        expect(g.tookScreen).toBe(true);
    });

    test('input and number', async () => {
        const { g } = scriptContext({ steps: [...typed('abc'), ...typed('42'), ...typed('4x'), ...typed('')] });
        const where = { x: 1, y: 1, length: 10 };
        expect(await g.input(where)).toBe('abc');
        expect(await g.number(where)).toBe(42);
        expect(await g.number(where)).toBe(0);
        expect(await g.number(where)).toBe(0);
    });

    test('sleep', async () => {
        const { g } = scriptContext();
        const started = Date.now();
        await g.sleep(5);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe('ScriptContext: moving', () => {
    test('moveTo moves the player on this screen', () => {
        const { g, game, term } = scriptContext({ player: newPlayer({ screen: 82, x: 10, y: 10 }) });
        g.moveTo(12, 11);
        expect([game.playing.x, game.playing.y]).toEqual([12, 11]);
        expect(term.screen.cell(12, 11).ch).toBe('☺');
    });

    test('goto only records where to go', () => {
        const { g, game } = scriptContext();
        expect(g.destination).toBeNull();
        g.goto(82, 5, 6);
        expect(g.destination).toEqual({ screen: 82, x: 5, y: 6 });
        expect(game.playing.screen).toBe(1);
    });
});

describe('ScriptContext: rules', () => {
    test('random gives 1 to n', () => {
        const { g } = scriptContext();
        random = spyOn(Math, 'random').mockReturnValue(0);
        expect(g.random(6)).toBe(1);
        random.mockReturnValue(0.999);
        expect(g.random(6)).toBe(6);
    });

    test("spend takes gold when there's enough", async () => {
        const { g } = scriptContext({ player: newPlayer({ gold: 50 }) });
        expect(await g.spend(50)).toBe(true);
        expect(g.gold).toBe(0);
    });

    test("spend says so when there isn't", async () => {
        const { g, term } = scriptContext({ player: newPlayer({ gold: 5 }), steps: ['x'] });
        expect(await g.spend(6)).toBe(false);
        expect(g.gold).toBe(5);
        expect(row(term.screen, 1)).toContain("Your funds aren't exactly");
        expect(term.remaining).toBe(0);
    });

    test('fight uses the configured superhuman factor', async () => {
        random = spyOn(Math, 'random').mockReturnValue(0.99);
        const { g } = scriptContext({ player: newPlayer({ superhuman: true }), steps: ['enter', 'x', 'x'] });
        // Bare hands with random 0.99: 10 + 9, power hit x2, superhuman x3 = 114.
        expect(await g.fight(monster({ name: 'Wall', hp: 114, attack: 0, gold: 1, exp: 1 }))).toBe('won');
    });

    test('animate moves a sprite along a path and restores the map behind it', async () => {
        const world = makeWorld(makeMap(1));
        const { g, term } = scriptContext({ world, player: newPlayer({ screen: 1, x: 40, y: 20 }) });
        g.overlay('{x 5}{y 5}{red}☻');
        await g.animate(0.1, [[5, 5], [6, 5], [6, 6]]);
        expect(term.screen.cell(6, 6)).toMatchObject({ ch: '☻', fg: 4 });
        expect(term.screen.cell(5, 5).ch).toBe(' ');
        expect(term.screen.cell(6, 5).ch).toBe(' ');
    });
});

describe('ScriptContext: items', () => {
    test('give, count, has, take and inventory', () => {
        const { g } = scriptContext();
        g.give('wildberries', 3);
        g.give('stick');
        expect([g.count('wildberries'), g.has('wildberries', 3), g.has('wildberries', 4), g.has('stick')]).toEqual([3, true, false, true]);
        expect(g.take('wildberries', 5)).toBe(false);
        expect(g.take('wildberries', 2)).toBe(true);
        expect(g.inventory.map((e) => [e.item.id, e.count])).toEqual([['stick', 1], ['wildberries', 1]]);
    });

    test('unknown items are errors', () => {
        const { g } = scriptContext();
        expect(() => g.count('bazooka')).toThrow('There\'s no item "bazooka".');
        expect(() => g.take('bazooka')).toThrow();
        expect(() => g.give('bazooka')).toThrow();
    });

    test('equip, unequip, weapon and armour', () => {
        const { g, game } = scriptContext({ player: newPlayer({ items: { rpg: 1, vest: 1 } }) });
        expect([g.weapon, g.armour]).toEqual([null, null]);
        g.equip('rpg');
        g.equip('vest');
        expect([g.weapon?.name, g.armour?.name]).toEqual(['RPG', 'Vest']);
        g.unequip('weapon');
        expect(game.playing.weapon).toBeNull();
    });

    test("use applies the item's effect and uses it up", () => {
        const { g } = scriptContext({ player: newPlayer({ hp: 98, items: { wildberries: 1 } }) });
        expect(g.use('wildberries')).toBe('You eat some wildberries. Delicious! (+5 hitpoints)');
        expect(g.hp).toBe(100);
        expect(g.count('wildberries')).toBe(0);
        expect(() => g.use('wildberries')).toThrow("The player doesn't have Wildberries.");
        expect(() => g.use('stick')).toThrow("Stick can't be used.");
    });

    test('an effect can raise every stat', () => {
        const { g } = scriptContext({ player: newPlayer({ hp: 10, items: { tonic: 1 } }), items: readItems([{ id: 'tonic', name: 'Tonic', kind: 'usable', effect: { heal: 50, maxHp: 10, strength: 2, defense: 3 } }]) });
        g.use('tonic');
        expect([g.hp, g.maxHp, g.strength, g.defense]).toEqual([60, 110, 12, 13]);
    });

    test("fights use the gear's power, and gear can break", async () => {
        const { g, term } = scriptContext({ player: newPlayer({ items: { stick: 1 }, weapon: 'stick' }), steps: ['enter', 'enter', 'x', 'x'] });
        random = spyOn(Math, 'random').mockReturnValue(0.01);
        // The monster goes first (and misses), then the player hits for 15 power
        // + strength 10 + 1.
        expect(await g.fight(monster({ name: 'Wall', hp: 26, attack: 0, gold: 1, exp: 1 }))).toBe('won');
        expect(g.weapon).toBeNull();
        expect(row(term.screen, 23)).toContain('Your Stick breaks!');
    });
});

describe('ScriptContext: monsters', () => {
    test('monster looks one up in data/monsters.json', () => {
        const { g } = scriptContext();
        expect(g.monster('lion').name).toBe('Lion');
        expect(() => g.monster('dragon')).toThrow();
    });

    test("a scripted fight runs the monster's hook too", async () => {
        random = spyOn(Math, 'random').mockReturnValue(0.99);
        const { g } = scriptContext({ steps: ['enter', 'x', 'x'] });
        // The Tree Elf's hook (the fixture's elf-berries event) drops
        // wildberries; this one has 1 hp.
        expect(await g.fight({ ...g.monster('tree-elf'), hp: 1 })).toBe('won');
        expect(g.count('wildberries')).toBe(3);
    });
});

describe('ScriptContext: choices and scrolling', () => {
    test('hidden options are left out, but the result counts all of them', async () => {
        const { g, term } = scriptContext({
            steps: [
                () => {
                    expect(row(term.screen, 1)).toBe('A');
                    expect(row(term.screen, 2)).toBe('C');
                    expect(row(term.screen, 3)).toBe('');
                    return 'down';
                },
                'enter',
            ],
        });
        expect(await g.choice(['A', { text: 'B', show: false }, { text: 'C', show: true }])).toBe(2);
    });

    test('Escape is still -1, and the print row moves past only the shown options', async () => {
        const { g, term } = scriptContext({ steps: ['escape'] });
        expect(await g.choice([{ text: 'A', show: false }, 'B'])).toBe(-1);
        g.print('after');
        expect(row(term.screen, 2)).toBe('after');
    });

    test('scroll shows text in a window and takes the screen', async () => {
        const { g, term } = scriptContext({
            steps: [
                () => {
                    expect(row(term.screen, 1).trim()).toBe('Notes');
                    expect(row(term.screen, 3)).toBe(' first');
                    return 'escape';
                },
            ],
        });
        await g.scroll(['first', 'second'], 'Notes');
        expect(g.tookScreen).toBe(true);
    });
});

describe('ScriptContext: name and sex', () => {
    test('name is trimmed, and bySex picks a word', () => {
        const { g, game } = scriptContext();
        g.name = '  Ellis ';
        expect(game.playing.name).toBe('Ellis');
        expect(g.bySex('boy', 'girl')).toBe('boy');
        g.sex = 'female';
        expect([g.sex, g.bySex('boy', 'girl')]).toEqual(['female', 'girl']);
    });
});

test('a choice with every option hidden is -1, without waiting for a key', async () => {
    const { g, term } = scriptContext();
    expect(await g.choice([{ text: 'A', show: false }])).toBe(-1);
    expect(term.remaining).toBe(0);
});
