// The player's state: what gets saved. The flags are up to the content;
// the engine only knows they are named booleans, numbers and strings.

import { InvalidData, record, integer, boolean, field, oneOf, string } from './validate.ts';
import type { ItemCatalogue, ItemDef, ItemKind } from './items.ts';

export type FlagValue = boolean | number | string;
export type FlagRecord = Record<string, FlagValue>;

export type Slot = 'weapon' | 'armour';

export const SEXES = ['male', 'female'] as const;
export type Sex = (typeof SEXES)[number];

export interface Player<F extends FlagRecord> {
    // Chosen when a game starts ("" in saves from before there were names).
    name: string;
    sex: Sex;
    screen: number;
    x: number;
    y: number;
    // The outdoor screen shown as "you are here" on the world map.
    mapScreen: number;
    // A title earned in the game ("the Wyrmslayer"), shown after the name
    // where players are listed (on a server); left out for none.
    title?: string;
    // Good or evil, from -10 (as evil as can be) to 10; left out for 0.
    alignment?: number;
    // The outdoor screens the world map shows: those the player has been
    // to, and the ones around them. Left out, it's the ones around where
    // they are (a new game, or a save from before the map was discovered).
    seen?: number[];
    hp: number;
    maxHp: number;
    gold: number;
    strength: number;
    defense: number;
    exp: number;
    // How many of each item the player carries, by item id (only counts
    // above 0 are kept).
    items: Record<string, number>;
    // The ids of the equipped weapon and armour, which are among the items.
    weapon: string | null;
    armour: string | null;
    // Whether random encounters are on.
    monsters: boolean;
    superhuman: boolean;
    flags: F;
}

// The player fields holding plain numbers (the ones the debug editor sets).
export type NumericField = 'screen' | 'x' | 'y' | 'mapScreen' | 'hp' | 'maxHp' | 'gold' | 'strength' | 'defense' | 'exp';

// The equipped item in a slot, if any.
export function equipped(player: Pick<Player<FlagRecord>, Slot>, slot: Slot, items: ItemCatalogue): ItemDef | null {
    const id = player[slot];
    return id === null ? null : items.get(id);
}

// Each flag must have the same type as its default; missing flags (from an
// older save) keep the default and unknown ones are dropped.
function restoreFlags<F extends FlagRecord>(defaults: F, value: unknown, path: string): F {
    const saved = record(value, path);
    const flags = structuredClone(defaults);
    const writable: FlagRecord = flags;
    for (const [name, fallback] of Object.entries(defaults)) {
        const v = saved[name];
        if (v === undefined) {
            continue;
        }
        if (typeof v !== typeof fallback) {
            throw new TypeError(`${path}.${name}: expected a ${typeof fallback}`);
        }
        if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
            writable[name] = v;
        }
    }

    return flags;
}

// Item counts. Items the catalogue doesn't have any more are dropped.
function restoreItems(value: unknown, path: string, catalogue: ItemCatalogue): Record<string, number> {
    const items: Record<string, number> = {};
    for (const [id, count] of Object.entries(record(value, path))) {
        const n = integer(count, `${path}.${id}`);
        if (n > 0 && catalogue.has(id)) {
            items[id] = n;
        }
    }

    return items;
}

// An equipped item: an id the player carries, of the right kind. Saves from
// before the item catalogue have { name, power, value } here; those are
// matched to the catalogue by name, and given to the player.
function restoreSlot(value: unknown, kind: ItemKind, items: Record<string, number>, catalogue: ItemCatalogue): string | null {
    if (typeof value === 'string') {
        return (items[value] ?? 0) > 0 && catalogue.get(value).kind === kind ? value : null;
    }
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const name: unknown = 'name' in value ? value.name : undefined;
    const item = typeof name === 'string' ? catalogue.named(name) : undefined;
    if (item?.kind !== kind) {
        return null;
    }
    items[item.id] = Math.max(1, items[item.id] ?? 0);
    return item.id;
}

// A saved player, checked against the starting state and the item
// catalogue. Missing fields keep their starting values.
export function restorePlayer<F extends FlagRecord>(start: Player<F>, value: unknown, catalogue: ItemCatalogue, path = 'save'): Player<F> {
    const r = record(value, path);
    const int = (key: NumericField): number => field(r, key, path, integer, start[key]);
    const items = r['items'] === undefined ? structuredClone(start.items) : restoreItems(r['items'], `${path}.items`, catalogue);
    const slot = (key: Slot, kind: ItemKind): string | null => (r[key] === undefined ? start[key] : restoreSlot(r[key], kind, items, catalogue));

    return {
        name: field(r, 'name', path, string, start.name),
        sex: field(r, 'sex', path, oneOf(SEXES), start.sex),
        screen: int('screen'),
        x: int('x'),
        y: int('y'),
        mapScreen: int('mapScreen'),
        hp: int('hp'),
        maxHp: int('maxHp'),
        gold: int('gold'),
        strength: int('strength'),
        defense: int('defense'),
        exp: int('exp'),
        weapon: slot('weapon', 'weapon'),
        armour: slot('armour', 'armour'),
        items,
        monsters: field(r, 'monsters', path, boolean, start.monsters),
        superhuman: field(r, 'superhuman', path, boolean, start.superhuman),
        flags: r['flags'] === undefined ? structuredClone(start.flags) : restoreFlags(start.flags, r['flags'], `${path}.flags`),
        ...(r['seen'] === undefined ? {} : { seen: restoreSeen(r['seen'], `${path}.seen`) }),
        ...(r['title'] === undefined || r['title'] === '' ? {} : { title: field(r, 'title', path, string) }),
        ...(r['alignment'] === undefined || r['alignment'] === 0 ? {} : { alignment: clampAlignment(field(r, 'alignment', path, integer)) }),
    };
}

// How good or evil a player can be.
export const ALIGNMENT_MIN = -10;
export const ALIGNMENT_MAX = 10;
export const clampAlignment = (n: number): number => Math.max(ALIGNMENT_MIN, Math.min(ALIGNMENT_MAX, Math.trunc(n)));

// The screens seen on the world map: whole numbers, each once.
function restoreSeen(value: unknown, path: string): number[] {
    if (!Array.isArray(value)) {
        throw new InvalidData(`${path}: expected a list of screens`);
    }

    return [...new Set(value.map((n: unknown, i) => integer(n, `${path}[${i}]`)))];
}
