import { describe, expect, test } from 'bun:test';
import { equipped, restorePlayer, type Player } from '../src/player.ts';
import { itemCatalogue as items } from '../src/fixture.ts';

type TestFlags = { seen: boolean; count: number; name: string };

const start: Player<TestFlags> = {
    name: '',
    sex: 'male',
    screen: 1,
    x: 2,
    y: 3,
    mapScreen: 1,
    hp: 10,
    maxHp: 10,
    gold: 0,
    strength: 1,
    defense: 1,
    exp: 0,
    items: {},
    weapon: null,
    armour: null,
    monsters: false,
    superhuman: false,
    flags: { seen: false, count: 0, name: '' },
};

describe('restorePlayer', () => {
    test('a full save comes back as it was', () => {
        const saved: Player<TestFlags> = {
            ...start,
            screen: 7,
            gold: 99,
            items: { stick: 1, vest: 2, wildberries: 5 },
            weapon: 'stick',
            armour: 'vest',
            monsters: true,
            flags: { seen: true, count: 3, name: 'Bob' },
        };
        expect(restorePlayer(start, JSON.parse(JSON.stringify(saved)), items)).toEqual(saved);
    });

    test('missing fields and flags keep their starting values', () => {
        const player = restorePlayer(start, { gold: 5, flags: { count: 2 } }, items);
        expect(player.gold).toBe(5);
        expect(player.hp).toBe(10);
        expect(player.items).toEqual({});
        expect(player.weapon).toBeNull();
        expect(player.flags).toEqual({ seen: false, count: 2, name: '' });
        expect(restorePlayer(start, {}, items).flags).toEqual(start.flags);
    });

    test('never shares objects with the starting player', () => {
        const withItems = { ...start, items: { stick: 1 } };
        const player = restorePlayer(withItems, {}, items);
        player.flags.count = 9;
        player.items['stick'] = 5;
        expect(start.flags.count).toBe(0);
        expect(withItems.items).toEqual({ stick: 1 });
    });

    test('unknown flags and items, and counts of 0, are dropped', () => {
        const player = restorePlayer(start, { flags: { other: 1 }, items: { stick: 1, 'magic-bean': 3, vest: 0 } }, items);
        expect(player.flags).toEqual(start.flags);
        expect(player.items).toEqual({ stick: 1 });
    });

    test('an equipped item must be carried, and of the right kind', () => {
        const player = (weapon: unknown, armour: unknown, carried: Record<string, number>) => restorePlayer(start, { items: carried, weapon, armour }, items);
        expect(player('stick', 'vest', { stick: 1, vest: 1 })).toMatchObject({ weapon: 'stick', armour: 'vest' });
        expect(player('stick', 'vest', {})).toMatchObject({ weapon: null, armour: null });
        expect(player('vest', 'stick', { stick: 1, vest: 1 })).toMatchObject({ weapon: null, armour: null });
        expect(player(null, 7, { stick: 1 })).toMatchObject({ weapon: null, armour: null });
    });

    test('weapons and armour from older saves become items', () => {
        const old = { weapon: { name: 'Shotgun', power: 100, value: 1000 }, armour: { name: 'Vest', power: 15, value: 50 } };
        const player = restorePlayer(start, old, items);
        expect(player).toMatchObject({ weapon: 'shotgun', armour: 'vest', items: { shotgun: 1, vest: 1 } });
    });

    test("... unless the catalogue doesn't know them (like 'Nothing')", () => {
        const old = { weapon: { name: 'Nothing', power: 0, value: 0 }, armour: { name: 'Vest' } };
        const player = restorePlayer(start, { ...old, items: {} }, items);
        expect(player).toMatchObject({ weapon: null, armour: 'vest', items: { vest: 1 } });
        expect(restorePlayer(start, { armour: { name: 'Shotgun' } }, items).armour).toBeNull();
        expect(restorePlayer(start, { weapon: { power: 3 } }, items).weapon).toBeNull();
    });

    test.each([
        [{ hp: '10' }, 'save.hp: expected a whole number'],
        [{ x: 1.5 }, 'save.x: expected a whole number'],
        [{ items: [] }, 'save.items: expected an object'],
        [{ items: { stick: 'one' } }, 'save.items.stick: expected a whole number'],
        [{ monsters: 'yes' }, 'save.monsters: expected true or false'],
        [{ flags: [] }, 'save.flags: expected an object'],
        [{ flags: { seen: 'yes' } }, 'save.flags.seen: expected a boolean'],
        [{ flags: { count: true } }, 'save.flags.count: expected a number'],
        [null, 'save: expected an object'],
    ])('rejects bad saves: %p', (saved, message) => {
        expect(() => restorePlayer(start, saved, items)).toThrow(message);
    });

    test('names the file in errors', () => {
        expect(() => restorePlayer(start, { hp: 'x' }, items, 'slot1.json')).toThrow('slot1.json.hp');
    });
});

test('equipped gives the item in a slot', () => {
    expect(equipped({ weapon: 'stick', armour: null }, 'weapon', items)?.name).toBe('Stick');
    expect(equipped({ weapon: 'stick', armour: null }, 'armour', items)).toBeNull();
});

describe('names and sex', () => {
    test('are restored, and default to the start player\'s', () => {
        expect(restorePlayer(start, { name: 'Ellis', sex: 'female' }, items)).toMatchObject({ name: 'Ellis', sex: 'female' });
        expect(restorePlayer(start, {}, items)).toMatchObject({ name: '', sex: 'male' });
    });

    test.each([
        [{ name: 7 }, 'save.name: expected a string'],
        [{ sex: 'other' }, 'save.sex: expected one of male, female'],
    ])('bad values are refused: %p', (saved, message) => {
        expect(() => restorePlayer(start, saved, items)).toThrow(message);
    });
});
