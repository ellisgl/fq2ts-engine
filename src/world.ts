// The world: 79x22 screens laid out on an 80-wide grid (screen n's
// neighbours are n-1, n+1, n-80 and n+80). Screens come from data/maps.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, cellAt } from './assert.ts';
import { record, string, integer, array, oneOf, field, InvalidData, type Reader } from './validate.ts';
import type { Color } from './screen.ts';

export const MAP_WIDTH = 79;
export const MAP_HEIGHT = 22;
export const GRID_WIDTH = 80;
export const GRID_HEIGHT = 24;

export const MAP_KINDS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
export type MapKind = (typeof MAP_KINDS)[number];

// What each map kind is. Kinds 5-8 are the same terrain as 1, 4, 3 and 0
// but have random monster encounters.
export const KINDS: Readonly<Record<MapKind, { name: string; monsters?: true }>> = {
    0: { name: 'water' },
    1: { name: 'land' },
    2: { name: 'interior' },
    3: { name: 'town' },
    4: { name: 'small town' },
    5: { name: 'land', monsters: true },
    6: { name: 'small town', monsters: true },
    7: { name: 'town', monsters: true },
    8: { name: 'water', monsters: true },
};

export interface Tile {
    ch: string;
    fg: Color;
    bg: Color;
}

// What the ground of a cell is (whether it's solid is separate). Random
// monsters are only met on wild ground: grass, forest and mountains.
export const TERRAINS = ['grass', 'forest', 'mountain', 'water', 'road', 'floor', 'structure'] as const;
export type Terrain = (typeof TERRAINS)[number];

// How terrain is written in map files, one character per cell.
export const TERRAIN_CODES: Readonly<Record<Terrain, string>> = {
    grass: '.',
    forest: 'f',
    mountain: 'm',
    water: 'w',
    road: 'r',
    floor: '_',
    structure: '#',
};

export const WILD_TERRAIN: readonly Terrain[] = ['grass', 'forest', 'mountain'];

// Everything about one cell of a screen.
export interface MapCell extends Tile {
    solid: boolean;
    terrain: Terrain;
}

// A best guess at a cell's terrain from how it looks, for maps made before
// terrain was recorded.
export function inferTerrain({ ch, fg, bg, solid }: Tile & { solid: boolean }, kind: MapKind): Terrain {
    // (Walkable blue inside a building is a blue floor, not water.)
    if ((bg === 1 || (ch === '█' && fg === 9)) && (solid || kind !== 2)) {
        return 'water';
    }
    if (ch === '♠' || ch === '♣') {
        return 'forest';
    }
    if (ch === '∩') {
        return 'mountain';
    }
    if (solid) {
        return 'structure';
    }
    if (kind === 2) {
        return 'floor';
    }
    if (bg === 6) {
        return 'road';
    }
    return bg === 2 ? 'grass' : 'floor';
}

// One screen of data/maps. Rows are top to bottom, MAP_HEIGHT of them, each
// MAP_WIDTH cells wide.
export interface GameMap {
    screen: number;
    // Shown when the player arrives ("" for none).
    name: string;
    kind: MapKind;
    // The encounter table for random fights here, if not "default".
    encounters?: string;
    tiles: string[][];
    fg: Color[][];
    bg: Color[][];
    solid: boolean[][];
    terrain: Terrain[][];
}

// A list of MAP_HEIGHT strings of MAP_WIDTH characters, each turned into
// a cell with `cell` (which returns undefined for a character it rejects).
function grid<T>(cell: (ch: string) => T | undefined, expected: string): Reader<T[][]> {
    return (value, path) =>
        array(value, path, (row, rowPath) => {
            const chars = [...string(row, rowPath)];
            if (chars.length !== MAP_WIDTH) {
                throw new InvalidData(`${rowPath}: expected ${MAP_WIDTH} cells, found ${chars.length}`);
            }
            return chars.map((ch, i) => {
                const c = cell(ch);
                if (c === undefined) {
                    throw new InvalidData(`${rowPath}[${i}]: expected ${expected}, found "${ch}"`);
                }
                return c;
            });
        });
}

const hex = (ch: string): Color | undefined => (/^[0-9A-F]$/.test(ch) ? parseInt(ch, 16) : undefined);
const kind = oneOf(MAP_KINDS);
const terrainCode = (ch: string): Terrain | undefined => TERRAINS.find((t) => TERRAIN_CODES[t] === ch);

export function readMap(value: unknown, path: string): GameMap {
    const r = record(value, path);
    const mapKind = field(r, 'kind', path, kind);
    const tiles = field(r, 'tiles', path, grid((ch) => ch, 'a character'));
    const fg = field(r, 'fg', path, grid(hex, 'a hex digit'));
    const bg = field(r, 'bg', path, grid(hex, 'a hex digit'));
    const solid = field(r, 'solid', path, grid((ch) => (ch === '#' ? true : ch === '.' ? false : undefined), '# or .'));
    for (const [name, rows] of [['tiles', tiles], ['fg', fg], ['bg', bg], ['solid', solid]] as const) {
        if (rows.length !== MAP_HEIGHT) {
            throw new InvalidData(`${path}.${name}: expected ${MAP_HEIGHT} rows`);
        }
    }
    const terrain =
    r['terrain'] === undefined
        ? tiles.map((row, y) => row.map((ch, x) => inferTerrain({ ch, fg: cellAt(fg, x + 1, y + 1), bg: cellAt(bg, x + 1, y + 1), solid: cellAt(solid, x + 1, y + 1) }, mapKind)))
        : field(r, 'terrain', path, grid(terrainCode, `one of ${Object.values(TERRAIN_CODES).join(' ')}`));
    if (terrain.length !== MAP_HEIGHT) {
        throw new InvalidData(`${path}.terrain: expected ${MAP_HEIGHT} rows`);
    }
    const map: GameMap = {
        screen: field(r, 'screen', path, integer),
        name: field(r, 'name', path, string, ''),
        kind: mapKind,
        ...(r['encounters'] === undefined ? {} : { encounters: field(r, 'encounters', path, string) }),
        tiles,
        fg,
        bg,
        solid,
        terrain,
    };
    return map;
}

const HEX = '0123456789ABCDEF';

// A screen as the text of its data/maps file (the format readMap reads).
export function writeMap(map: GameMap): string {
    const rows = <T>(grid: T[][], cell: (c: T) => string): string[] => grid.map((r) => r.map(cell).join(''));
    const data = {
        screen: map.screen,
        ...(map.name ? { name: map.name } : {}),
        kind: map.kind,
        ...(map.encounters === undefined ? {} : { encounters: map.encounters }),
        tiles: rows(map.tiles, (ch) => ch),
        fg: rows(map.fg, (c) => HEX.charAt(c)),
        bg: rows(map.bg, (c) => HEX.charAt(c)),
        solid: rows(map.solid, (s) => (s ? '#' : '.')),
        terrain: rows(map.terrain, (t) => TERRAIN_CODES[t]),
    };
    return JSON.stringify(data, null, 2) + '\n';
}

export const mapFileName = (screen: number): string => `${String(screen).padStart(4, '0')}.json`;

// A new screen filled with one cell (by default, blank ground of the
// kind's terrain).
export function blankMap(screen: number, kind: MapKind, cell?: MapCell): GameMap {
    const { ch, fg, bg, solid, terrain } = cell ?? { ch: ' ', fg: 15, bg: 0, solid: false, terrain: kind === 2 ? 'floor' : 'grass' };
    const rows = <T>(value: T): T[][] => Array.from({ length: MAP_HEIGHT }, () => Array.from({ length: MAP_WIDTH }, () => value));
    return { screen, name: '', kind, tiles: rows(ch), fg: rows(fg), bg: rows(bg), solid: rows(solid), terrain: rows(terrain) };
}

// Where screen n sits on the world grid (1-based column and row).
export function gridPosition(screen: number): { col: number; row: number } {
    return { col: ((screen - 1) % GRID_WIDTH) + 1, row: Math.floor((screen - 1) / GRID_WIDTH) + 1 };
}

export class World {
    private readonly maps: Map<number, GameMap>;

    public constructor(maps: ReadonlyMap<number, GameMap>) {
        this.maps = new Map(maps);
    }

    public static load(dir: string): World {
        const maps = new Map<number, GameMap>();
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json')) {
                continue;
            }
            const data: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            const map = readMap(data, file);
            maps.set(map.screen, map);
        }
        return new World(maps);
    }

    private map(screen: number): GameMap {
        const map = this.maps.get(screen);
        if (!map) {
            throw new RangeError(`Screen ${screen} does not exist.`);
        }
        return map;
    }

    public has(screen: number): boolean {
        return this.maps.has(screen);
    }

    public kind(screen: number): MapKind | undefined {
        return this.maps.get(screen)?.kind;
    }

    public hasMonsters(screen: number): boolean {
        const kind = this.kind(screen);
        return kind !== undefined && KINDS[kind].monsters === true;
    }

    // Interiors don't show up on the world map; everything else does.
    public isOutdoors(screen: number): boolean {
        const kind = this.kind(screen);
        return kind !== undefined && kind !== 2;
    }

    public tile(screen: number, x: number, y: number): Tile {
        const map = this.map(screen);
        return { ch: cellAt(map.tiles, x, y), fg: cellAt(map.fg, x, y), bg: cellAt(map.bg, x, y) };
    }

    public isSolid(screen: number, x: number, y: number): boolean {
        return cellAt(this.map(screen).solid, x, y);
    }

    public cell(screen: number, x: number, y: number): MapCell {
        return { ...this.tile(screen, x, y), solid: this.isSolid(screen, x, y), terrain: this.terrain(screen, x, y) };
    }

    public terrain(screen: number, x: number, y: number): Terrain {
        return cellAt(this.map(screen).terrain, x, y);
    }

    // The screen's name ("" for none, or for a screen that doesn't exist).
    public name(screen: number): string {
        return this.maps.get(screen)?.name ?? '';
    }

    public setName(screen: number, name: string): void {
        this.map(screen).name = name;
    }

    // The screen numbers in order.
    public screens(): number[] {
        return [...this.maps.keys()].sort((a, b) => a - b);
    }

    // ---- Editing

    public setCell(screen: number, x: number, y: number, { ch, fg, bg, solid, terrain }: MapCell): void {
        const map = this.map(screen);
        cellAt(map.tiles, x, y); // throws if (x, y) is off the map
        const set = <T>(grid: T[][], value: T): void => {
            at(grid, y - 1)[x - 1] = value;
        };
        set(map.tiles, ch);
        set(map.fg, fg);
        set(map.bg, bg);
        set(map.solid, solid);
        set(map.terrain, terrain);
    }

    public setKind(screen: number, kind: MapKind): void {
        this.map(screen).kind = kind;
    }

    // The encounter table named for a screen (undefined means "default").
    public encounters(screen: number): string | undefined {
        return this.maps.get(screen)?.encounters;
    }

    public setEncounters(screen: number, table: string | undefined): void {
        const map = this.map(screen);
        if (table === undefined) {
            delete map.encounters;
        } else {
            map.encounters = table;
        }
    }

    // Adds a screen, replacing any with the same number.
    public put(map: GameMap): void {
        this.maps.set(map.screen, structuredClone(map));
    }

    public remove(screen: number): void {
        this.maps.delete(screen);
    }

    // A copy of a screen's data.
    public export(screen: number): GameMap {
        return structuredClone(this.map(screen));
    }

    // Writes the world to `dir`: changed screens are rewritten, and files for
    // screens that no longer exist are deleted. Returns the files it touched.
    public save(dir: string): { written: string[]; deleted: string[] } {
        mkdirSync(dir, { recursive: true });
        const written: string[] = [];
        const deleted: string[] = [];
        const existing = new Set(readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)));
        for (const map of this.maps.values()) {
            const file = mapFileName(map.screen);
            const text = writeMap(map);
            existing.delete(file);
            const path = join(dir, file);
            let old: string | null = null;
            try {
                old = readFileSync(path, 'utf8');
            } catch {
                // a new screen
            }
            if (old === text) {
                continue;
            }
            writeFileSync(path, text);
            written.push(file);
        }
        for (const file of existing) {
            rmSync(join(dir, file));
            deleted.push(file);
        }
        return { written: written.sort(), deleted: [...deleted].sort() };
    }
}
