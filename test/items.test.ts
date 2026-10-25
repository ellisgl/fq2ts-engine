import { describe, expect, test } from 'bun:test';
import { ItemCatalogue, count, effectOf, equip, gearOf, give, readItems, take, wear, type Carrier } from '@fq2js/engine/items';
import { itemCatalogue as items, readData } from '../helpers.ts';

const carrier = (changes: Partial<Carrier> = {}): Carrier => ({ items: {}, weapon: null, armour: null, ...changes });

describe('readItems', () => {
    test('reads data/items.json', () => {
        const catalogue = readItems(readData('items.json'));
        expect(catalogue.get('stick')).toEqual({
            id: 'stick',
            name: 'Stick',
            kind: 'weapon',
            power: 15,
            value: 50,
            sellable: true,
            breakChance: 2,
            description: 'A sturdy stick. Mostly.',
            effect: null,
            useText: '',
        });
        expect(catalogue.get('wildberries').effect).toEqual({ heal: 5, maxHp: 0, strength: 0, defense: 0 });
    });

    test('fills in defaults, and quest items are never sellable', () => {
        const catalogue = readItems([
            { id: 'rock', name: 'Rock', kind: 'misc' },
            { id: 'key', name: 'Key', kind: 'quest', sellable: true },
        ]);
        expect(catalogue.get('rock')).toMatchObject({ power: 0, value: 0, sellable: true, breakChance: 0, description: '', effect: null, useText: '' });
        expect(catalogue.get('key').sellable).toBe(false);
    });

    test.each([
        [[{ id: 'Big Rock', name: 'x', kind: 'misc' }], 'items.json[0].id: expected lower case letters, digits and dashes, found "Big Rock"'],
        [[{ id: 'x', name: 'x', kind: 'food' }], 'items.json[0].kind: expected one of weapon, armour, usable, quest, misc'],
        [[{ id: 'x', name: 'x', kind: 'usable' }], 'items.json[0].effect: a usable item needs an effect'],
        [[{ id: 'x', name: 'x', kind: 'usable', effect: { heal: 'lots' } }], 'items.json[0].effect.heal: expected a whole number'],
        [[{ id: 'x', name: 'x', kind: 'misc' }, { id: 'x', name: 'y', kind: 'misc' }], 'Two items have the id "x".'],
        [{}, 'items.json: expected a list'],
    ])('rejects bad items: %p', (data, message) => {
        expect(() => readItems(data)).toThrow(message);
    });
});

describe('ItemCatalogue', () => {
    test('get, has, all and named', () => {
        expect(items.has('rpg')).toBe(true);
        expect(items.has('bazooka')).toBe(false);
        expect(() => items.get('bazooka')).toThrow('There\'s no item "bazooka".');
        expect(items.all()[0]?.id).toBe('stick');
        expect(items.named('Chain Mail')?.id).toBe('chain-mail');
        expect(items.named('Nothing')).toBeUndefined();
    });

    test('effectOf', () => {
        expect(effectOf(items.get('wildberries')).heal).toBe(5);
        expect(effectOf(items.get('stick'))).toEqual({ heal: 0, maxHp: 0, strength: 0, defense: 0 });
    });

    test('an empty catalogue', () => {
        expect(new ItemCatalogue([]).all()).toEqual([]);
    });
});

describe('carrying', () => {
    test('give and count', () => {
        const c = carrier();
        give(c, 'stick', 2, items);
        give(c, 'stick', 1, items);
        give(c, 'vest', 0, items);
        expect(count(c, 'stick')).toBe(3);
        expect(c.items).toEqual({ stick: 3 });
    });

    test('give refuses unknown items and bad amounts', () => {
        expect(() => give(carrier(), 'bazooka', 1, items)).toThrow('There\'s no item "bazooka".');
        expect(() => give(carrier(), 'stick', -1, items)).toThrow("Can't give -1");
        expect(() => give(carrier(), 'stick', 1.5, items)).toThrow("Can't give 1.5");
    });

    test("take only takes what's there, and unequips the last one", () => {
        const c = carrier({ items: { stick: 2, vest: 1 }, weapon: 'stick', armour: 'vest' });
        expect(take(c, 'stick', 3)).toBe(false);
        expect(take(c, 'stick', 1)).toBe(true);
        expect(c).toMatchObject({ items: { stick: 1, vest: 1 }, weapon: 'stick' });
        expect(take(c, 'stick', 1)).toBe(true);
        expect(take(c, 'vest', 1)).toBe(true);
        expect(c).toEqual({ items: {}, weapon: null, armour: null });
    });

    test('equip', () => {
        const c = carrier({ items: { stick: 1, vest: 1, wildberries: 1 } });
        equip(c, 'stick', items);
        equip(c, 'vest', items);
        expect(c).toMatchObject({ weapon: 'stick', armour: 'vest' });
        expect(() => equip(c, 'wildberries', items)).toThrow("Wildberries isn't a weapon or armour.");
        expect(() => equip(c, 'rpg', items)).toThrow("The player doesn't have RPG.");
    });

    test('gearOf', () => {
        expect(gearOf(carrier(), items)).toEqual({ weapon: 0, armour: 0 });
        expect(gearOf(carrier({ items: { rpg: 1, vest: 1 }, weapon: 'rpg', armour: 'vest' }), items)).toEqual({ weapon: 500, armour: 15 });
    });

    test('wear breaks gear by its break chance', () => {
        const c = carrier({ items: { stick: 1, vest: 2 }, weapon: 'stick', armour: 'vest' });
        expect(wear(c, items, () => 0.5)).toEqual([]);
        expect(wear(c, items, () => 0.01)).toEqual(['{lightred}Your Stick breaks!', '{lightred}Your Vest breaks!']);
        expect(c).toEqual({ items: { vest: 1 }, weapon: null, armour: 'vest' });
    });

    test('gear that never breaks, and no gear at all', () => {
        expect(wear(carrier({ items: { rpg: 1 }, weapon: 'rpg' }), items, () => 0)).toEqual([]);
        expect(wear(carrier(), items, () => 0)).toEqual([]);
    });
});
