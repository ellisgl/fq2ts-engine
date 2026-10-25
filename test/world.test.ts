import { describe, expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KINDS, MAP_HEIGHT, MAP_KINDS, MAP_WIDTH, TERRAINS, TERRAIN_CODES, WILD_TERRAIN, World, blankMap, gridPosition, inferTerrain, mapFileName, readMap, writeMap, type MapCell } from '../src/world.ts';
import { makeMap, makeWorld, tempDir } from '../src/testing.ts';

// A map file as stored in data/maps, with `changes` applied.
function mapFile(changes: Record<string, unknown> = {}): Record<string, unknown> {
    const rows = (ch: string): string[] => Array.from({ length: MAP_HEIGHT }, () => ch.repeat(MAP_WIDTH));
    const solid = rows('.');
    solid[1] = '#' + '.'.repeat(MAP_WIDTH - 1);
    return { screen: 5, kind: 1, tiles: rows('♠'), fg: rows('A'), bg: rows('2'), solid, ...changes };
}

function loadOne(changes: Record<string, unknown> = {}): World {
    const dir = tempDir();
    writeFileSync(join(dir, '0005.json'), JSON.stringify(mapFile(changes)));
    return World.load(dir);
}

describe('World.load', () => {
    test('reads a map file', () => {
        const world = loadOne();
        expect(world.has(5)).toBe(true);
        expect(world.kind(5)).toBe(1);
        expect(world.tile(5, 1, 1)).toEqual({ ch: '♠', fg: 10, bg: 2 });
        expect(world.isSolid(5, 1, 2)).toBe(true);
        expect(world.isSolid(5, 2, 2)).toBe(false);
    });

    test("ignores files that aren't JSON", () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'notes.txt'), 'hello');
        expect(World.load(dir).has(5)).toBe(false);
    });

    test.each([
        [{ screen: '5' }, '0005.json.screen: expected a whole number'],
        [{ kind: 9 }, '0005.json.kind: expected one of 0, 1, 2, 3, 4, 5, 6, 7, 8'],
        [{ tiles: ['x'] }, '0005.json.tiles[0]: expected 79 cells, found 1'],
        [{ tiles: ['x'.repeat(79)] }, '0005.json.tiles: expected 22 rows'],
        [{ fg: ['g'.repeat(79)] }, '0005.json.fg[0][0]: expected a hex digit, found "g"'],
        [{ solid: ['x'.repeat(79)] }, '0005.json.solid[0][0]: expected # or ., found "x"'],
        [{ bg: '2' }, '0005.json.bg: expected a list'],
    ])('rejects bad data: %p', (changes, message) => {
        expect(() => loadOne(changes)).toThrow(message);
    });

});

describe('World', () => {
    const world = makeWorld(makeMap(1, 0), makeMap(2, 2), makeMap(3, 5, ['4,5']), makeMap(4, 8));

    test('kind', () => {
        expect(world.kind(2)).toBe(2);
        expect(world.kind(99)).toBeUndefined();
    });

    test('hasMonsters is true for kinds 5-8', () => {
        expect(world.hasMonsters(1)).toBe(false);
        expect(world.hasMonsters(3)).toBe(true);
        expect(world.hasMonsters(4)).toBe(true);
        expect(world.hasMonsters(99)).toBe(false);
    });

    test('isOutdoors is false for interiors and missing screens', () => {
        expect(world.isOutdoors(1)).toBe(true);
        expect(world.isOutdoors(2)).toBe(false);
        expect(world.isOutdoors(99)).toBe(false);
    });

    test('tile and isSolid', () => {
        expect(world.tile(3, 4, 5)).toEqual({ ch: ' ', fg: 15, bg: 2 });
        expect(world.isSolid(3, 4, 5)).toBe(true);
        expect(world.isSolid(3, 5, 5)).toBe(false);
    });

    test('missing screens and cells off the map throw', () => {
        expect(() => world.tile(99, 1, 1)).toThrow('Screen 99 does not exist.');
        expect(() => world.isSolid(99, 1, 1)).toThrow(RangeError);
        expect(() => world.tile(1, 80, 1)).toThrow(RangeError);
        expect(() => world.isSolid(1, 1, 23)).toThrow(RangeError);
    });

    test('every kind is described', () => {
        for (const kind of MAP_KINDS) {
            expect(KINDS[kind].name).toBeTruthy();
        }
    });
});

describe('writeMap', () => {

    test('what it writes reads back the same', () => {
        const map = blankMap(9, 3, { ch: '▓', fg: 14, bg: 4, solid: true, terrain: 'grass' });
        expect(readMap(JSON.parse(writeMap(map)), 'x')).toEqual(map);
    });
});

test('mapFileName pads to four digits', () => {
    expect(mapFileName(7)).toBe('0007.json');
    expect(mapFileName(1201)).toBe('1201.json');
});

test('blankMap fills a screen with one cell', () => {
    const map = blankMap(3, 2);
    expect(map.tiles).toHaveLength(MAP_HEIGHT);
    expect(map.tiles[0]).toHaveLength(MAP_WIDTH);
    expect(map).toMatchObject({ screen: 3, kind: 2 });
    expect(makeWorld(map).cell(3, 79, 22)).toEqual({ ch: ' ', fg: 15, bg: 0, solid: false, terrain: 'floor' });
});

test('gridPosition', () => {
    expect(gridPosition(1)).toEqual({ col: 1, row: 1 });
    expect(gridPosition(80)).toEqual({ col: 80, row: 1 });
    expect(gridPosition(82)).toEqual({ col: 2, row: 2 });
});

describe('editing', () => {
    test('cell, setCell and setKind', () => {
        const world = makeWorld(makeMap(1));
        world.setCell(1, 79, 22, { ch: '#', fg: 4, bg: 6, solid: true, terrain: 'grass' });
        expect(world.cell(1, 79, 22)).toEqual({ ch: '#', fg: 4, bg: 6, solid: true, terrain: 'grass' });
        expect(world.cell(1, 78, 22).ch).toBe(' ');
        world.setKind(1, 8);
        expect(world.hasMonsters(1)).toBe(true);
    });

    test('setCell refuses cells off the map and missing screens', () => {
        const world = makeWorld(makeMap(1));
        const cell: MapCell = { ch: '#', fg: 4, bg: 6, solid: true, terrain: 'grass' };
        expect(() => world.setCell(1, 80, 1, cell)).toThrow(RangeError);
        expect(() => world.setCell(1, 1, 0, cell)).toThrow(RangeError);
        expect(() => world.setCell(2, 1, 1, cell)).toThrow('Screen 2 does not exist.');
        expect(() => world.setKind(2, 1)).toThrow('Screen 2 does not exist.');
    });

    test('put, remove, screens and export', () => {
        const world = makeWorld(makeMap(5));
        world.put(blankMap(2, 1));
        world.put(blankMap(5, 0));
        expect(world.screens()).toEqual([2, 5]);
        expect(world.kind(5)).toBe(0);
        world.remove(2);
        expect(world.screens()).toEqual([5]);
        const copy = world.export(5);
        copy.kind = 3;
        expect(world.kind(5)).toBe(0);
    });

    test("the world keeps its own copy of the maps it's given", () => {
        const map = makeMap(1);
        const world = makeWorld(map);
        map.kind = 0;
        world.put(map);
        map.kind = 8;
        expect(world.kind(1)).toBe(0);
    });
});

describe('save', () => {
    test('writes new and changed screens, deletes removed ones, and leaves the rest', () => {
        const dir = tempDir();
        const world = makeWorld(makeMap(1), makeMap(2), makeMap(3));
        expect(world.save(dir)).toEqual({ written: ['0001.json', '0002.json', '0003.json'], deleted: [] });
        writeFileSync(join(dir, 'notes.txt'), 'keep me');

        world.setCell(2, 1, 1, { ch: 'x', fg: 1, bg: 1, solid: false, terrain: 'grass' });
        world.remove(3);
        world.put(blankMap(4, 2));
        expect(world.save(dir)).toEqual({ written: ['0002.json', '0004.json'], deleted: ['0003.json'] });
        expect(readdirSync(dir).sort()).toEqual(['0001.json', '0002.json', '0004.json', 'notes.txt']);
        expect(World.load(dir).cell(2, 1, 1).ch).toBe('x');
        expect(world.save(dir)).toEqual({ written: [], deleted: [] });
    });

    test('creates the folder', () => {
        const dir = join(tempDir(), 'new', 'maps');
        makeWorld(makeMap(1)).save(dir);
        expect(readdirSync(dir)).toEqual(['0001.json']);
    });
});

describe('terrain and names', () => {
    test.each([
        [{ ch: ' ', fg: 15, bg: 1, solid: true }, 1, 'water'],
        [{ ch: '█', fg: 9, bg: 2, solid: true }, 1, 'water'],
        [{ ch: ' ', fg: 15, bg: 1, solid: false }, 2, 'floor'],
        [{ ch: ' ', fg: 15, bg: 1, solid: true }, 2, 'water'],
        [{ ch: '♠', fg: 10, bg: 2, solid: true }, 1, 'forest'],
        [{ ch: '♣', fg: 10, bg: 2, solid: true }, 2, 'forest'],
        [{ ch: '∩', fg: 8, bg: 2, solid: true }, 5, 'mountain'],
        [{ ch: '║', fg: 14, bg: 2, solid: true }, 1, 'structure'],
        [{ ch: ' ', fg: 15, bg: 0, solid: false }, 2, 'floor'],
        [{ ch: ' ', fg: 15, bg: 6, solid: false }, 3, 'road'],
        [{ ch: ' ', fg: 15, bg: 2, solid: false }, 5, 'grass'],
        [{ ch: ' ', fg: 15, bg: 7, solid: false }, 3, 'floor'],
    ] as const)('inferTerrain(%p, kind %i) is %s', (cell, kind, terrain) => {
        expect(inferTerrain(cell, kind)).toBe(terrain);
    });

    test('files without terrain get it inferred; files with it keep it', () => {
        const inferred = loadOne();
        expect(inferred.terrain(5, 1, 1)).toBe('forest');
        const rows = (ch: string): string[] => Array.from({ length: MAP_HEIGHT }, () => ch.repeat(MAP_WIDTH));
        const stated = loadOne({ terrain: rows('w') });
        expect(stated.terrain(5, 1, 1)).toBe('water');
        expect(stated.cell(5, 1, 1)).toMatchObject({ ch: '♠', terrain: 'water' });
    });

    test.each([
        [{ terrain: ['w'.repeat(79)] }, '0005.json.terrain: expected 22 rows'],
        [{ terrain: Array.from({ length: 22 }, () => 'x'.repeat(79)) }, '0005.json.terrain[0][0]: expected one of . f m w r _ #, found "x"'],
        [{ name: 3 }, '0005.json.name: expected a string'],
    ])('rejects bad terrain and names: %p', (changes, message) => {
        expect(() => loadOne(changes)).toThrow(message);
    });

    test('names are read, written only when set, and changeable', () => {
        const world = loadOne({ name: 'Frog Pond' });
        expect(world.name(5)).toBe('Frog Pond');
        expect(world.name(6)).toBe('');
        world.setName(5, '');
        expect(writeMap(world.export(5))).not.toContain('"name"');
        world.setName(5, 'Toad Hall');
        expect(writeMap(world.export(5))).toContain('"name": "Toad Hall"');
        expect(() => world.setName(6, 'x')).toThrow('Screen 6 does not exist.');
    });

    test('blank screens are grass outdoors and floor indoors', () => {
        expect(makeWorld(blankMap(1, 5)).terrain(1, 1, 1)).toBe('grass');
        expect(makeWorld(blankMap(1, 2)).terrain(1, 1, 1)).toBe('floor');
    });

    test('every terrain has a code, and the codes are all different', () => {
        const codes = TERRAINS.map((t) => TERRAIN_CODES[t]);
        expect(new Set(codes).size).toBe(TERRAINS.length);
        expect(WILD_TERRAIN).toEqual(['grass', 'forest', 'mountain']);
    });

});

test('map backgrounds must be colours 0 to 7 (the 16-colour terminal has no more)', () => {
    const rows = (ch: string): string[] => Array.from({ length: MAP_HEIGHT }, () => ch.repeat(MAP_WIDTH));
    expect(() => loadOne({ bg: rows('8') })).toThrow('0005.json.bg[0][0]: expected a digit from 0 to 7, found "8"');
});

describe('Unicode in map files', () => {
    const rows = (ch: string): string[] => Array.from({ length: MAP_HEIGHT }, () => ch.repeat(MAP_WIDTH));

    test('any single-width character can be a tile, and is kept as written', () => {
        const tiles = rows('λ');
        tiles[0] = 'ж☃◆' + 'λ'.repeat(MAP_WIDTH - 3);
        const world = loadOne({ tiles });
        expect([world.tile(5, 1, 1).ch, world.tile(5, 2, 1).ch, world.tile(5, 3, 1).ch]).toEqual(['ж', '☃', '◆']);
        expect(writeMap(world.export(5))).toContain('"ж☃◆λ');
    });

    test('a letter with a separate accent is one tile, stored in NFC', () => {
        const tiles = rows('.');
        tiles[0] = 'é' + '.'.repeat(MAP_WIDTH - 1);
        const world = loadOne({ tiles });
        expect(world.tile(5, 1, 1).ch).toBe('é');
    });

    test.each([
        ['😀', 'an emoji'],
        ['中', 'a wide character'],
        ['​', 'an invisible one'],
    ])('a tile %p is refused (%s)', (ch) => {
        const tiles = rows('.');
        tiles[3] = ch + '.'.repeat(MAP_WIDTH - 1);
        expect(() => loadOne({ tiles })).toThrow(`0005.json.tiles[3][0]: expected a character one column wide, found "${ch}"`);
    });
});
