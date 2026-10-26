// The world's state: what belongs to everyone in the game, as opposed to
// each player (their flags). In single-player it's kept with the save; on
// a server, everyone playing shares it: what one player changes, the
// others see.
//
// A game declares its world state with starting values (Content.world),
// and scripts read and set it as g.world, typed like the flags.

import { InvalidData, record } from './validate.ts';

// A world value: like a flag, or a list of names (who has bought the
// castle, say).
export type WorldValue = boolean | number | string | readonly string[];
export type WorldRecord = Record<string, WorldValue>;

// Where the world's values are kept: in memory (single-player) or a
// server's database.
export interface WorldStore {
    get(name: string): WorldValue | undefined;
    set(name: string, value: WorldValue): void;
}

// The world kept in memory, saved with the player (single-player).
export class MemoryWorld implements WorldStore {
    private values = new Map<string, WorldValue>();

    public get(name: string): WorldValue | undefined {
        return this.values.get(name);
    }

    public set(name: string, value: WorldValue): void {
        this.values.set(name, copy(value));
    }

    // What's been set, for a save.
    public saved(): WorldRecord {
        return Object.fromEntries(this.values);
    }

    // Starts again from these values (a new game, or a loaded one).
    public reset(values: WorldRecord = {}): void {
        this.values = new Map(Object.entries(values));
    }
}

// What scripts see as g.world: each of the game's world names, reading and
// setting the store (with its starting value until it's set). A list comes
// back as a copy that can't be changed: set a new one to change it
// (g.world.owners = [...g.world.owners, g.name]).
export function worldView<W extends WorldRecord>(defaults: W, store: WorldStore): W {
    const view = { ...defaults };
    for (const name of Object.keys(defaults)) {
        Object.defineProperty(view, name, {
            enumerable: true,
            get: () => frozen(store.get(name) ?? defaults[name]),
            set: (value: WorldValue) => {
                if (!sameKind(value, defaults[name])) {
                    throw new TypeError(`world.${name}: expected ${kind(defaults[name])}`);
                }
                store.set(name, value);
            },
        });
    }
    return view;
}

// World values from a save or a database: each must be the same kind as
// its starting value; ones the game doesn't have (any more) are dropped.
export function restoreWorld(defaults: WorldRecord, value: unknown, path = 'world'): WorldRecord {
    if (value === undefined) {
        return {};
    }

    const saved = record(value, path);
    const world: WorldRecord = {};
    for (const [name, fallback] of Object.entries(defaults)) {
        const v: unknown = saved[name];
        if (v === undefined) {
            continue;
        }
        if (!sameKind(v, fallback)) {
            throw new InvalidData(`${path}.${name}: expected ${kind(fallback)}`);
        }
        world[name] = v;
    }
    return world;
}

function sameKind(value: unknown, like: WorldValue | undefined): value is WorldValue {
    if (isList(like)) {
        return Array.isArray(value) && value.every((v: unknown) => typeof v === 'string');
    }
    return typeof value === typeof like;
}

// (Array.isArray narrows a readonly list to any[]; this keeps its type.)
const isList = (value: WorldValue | undefined): value is readonly string[] => Array.isArray(value);
const kind = (value: WorldValue | undefined): string => (isList(value) ? 'a list of strings' : `a ${typeof value}`);
const copy = (value: WorldValue): WorldValue => (isList(value) ? [...value] : value);
const frozen = (value: WorldValue | undefined): WorldValue | undefined => (isList(value) ? Object.freeze([...value]) : value);
