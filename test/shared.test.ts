import { describe, expect, test } from 'bun:test';
import { MemoryWorld, restoreWorld, worldView } from '../src/shared.ts';

type Castle = { owners: readonly string[]; gold: number; open: boolean };
const DEFAULTS: Castle = { owners: [], gold: 0, open: true };

describe('worldView', () => {
    test('reads the starting values until something is set, then the store', () => {
        const store = new MemoryWorld();
        const world = worldView(DEFAULTS, store);
        expect([world.owners, world.gold, world.open]).toEqual([[], 0, true]);
        world.gold = 5;
        world.owners = [...world.owners, 'Ann'];
        expect(store.get('gold')).toBe(5);
        expect(worldView(DEFAULTS, store).owners).toEqual(['Ann']);
    });

    test("a list can't be changed in place, only set", () => {
        const world = worldView(DEFAULTS, new MemoryWorld());
        world.owners = ['Ann'];
        const owners = world.owners;
        expect(() => {
            Reflect.apply(Array.prototype.push, owners, ['Bob']);
        }).toThrow();
        expect(world.owners).toEqual(['Ann']);
    });

    test('a value of the wrong kind is refused', () => {
        const world: Record<string, unknown> = worldView(DEFAULTS, new MemoryWorld());
        expect(() => {
            world['gold'] = 'lots';
        }).toThrow('world.gold: expected a number');
        expect(() => {
            world['owners'] = [1, 2];
        }).toThrow('world.owners: expected a list of strings');
    });

    test('two views of one store see each other', () => {
        const store = new MemoryWorld();
        const mine = worldView(DEFAULTS, store);
        const yours = worldView(DEFAULTS, store);
        mine.open = false;
        expect(yours.open).toBe(false);
    });
});

describe('MemoryWorld', () => {
    test('saved gives what was set; reset starts again', () => {
        const store = new MemoryWorld();
        store.set('gold', 3);
        expect(store.saved()).toEqual({ gold: 3 });
        store.reset({ open: false });
        expect(store.saved()).toEqual({ open: false });
        store.reset();
        expect(store.saved()).toEqual({});
    });

    test('keeps its own copy of a list', () => {
        const store = new MemoryWorld();
        const owners = ['Ann'];
        store.set('owners', owners);
        owners.push('Bob');
        expect(store.get('owners')).toEqual(['Ann']);
    });
});

describe('restoreWorld', () => {
    test("keeps the game's values that are the right kind, and drops the rest", () => {
        expect(restoreWorld(DEFAULTS, { gold: 7, owners: ['Ann'], gone: 1 })).toEqual({ gold: 7, owners: ['Ann'] });
        expect(restoreWorld(DEFAULTS, undefined)).toEqual({});
    });

    test.each([
        [{ gold: 'x' }, 'save.world.gold: expected a number'],
        [{ owners: 'Ann' }, 'save.world.owners: expected a list of strings'],
        [{ owners: ['Ann', 2] }, 'save.world.owners: expected a list of strings'],
        [[], 'save.world: expected an object'],
    ])('refuses %p', (value, message) => {
        expect(() => restoreWorld(DEFAULTS, value, 'save.world')).toThrow(message);
    });
});
