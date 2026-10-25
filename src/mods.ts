// Mods: folders of TypeScript (or JavaScript) and data that add to a game
// without changing it. A mod can add screens (maps), triggers and show
// scripts on any screen, items, monsters and encounter tables, events for
// monsters' after-fight hooks, and something to run after the opening of a
// new game. It keeps its own flags, saved with the player.
//
//   mods/wishing-well/
//     mod.ts          default export: the Mod (see below)
//     items.json      new items, as in a game's items.json
//     monsters.json   new monsters and encounter tables
//     maps/           new screens, as in a game's maps/
//
// Mods only add. Anything a mod adds that's already there (an item id, a
// screen, a trigger tile, an event...) is an error naming the mod, so two
// mods can't quietly fight over something; show scripts and the new game
// script run one after the other instead (the game's first, then the
// mods', by id). A folder whose name starts with _ or . is left out.
//
// Mods are code, run with the game's own permissions: only install mods
// you trust.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bestiary, readBestiary, type EncounterTable } from './combat.ts';
import { ItemCatalogue, readItems } from './items.ts';
import { World, readMap, type GameMap } from './world.ts';
import { InvalidData, field, integer, record, string } from './validate.ts';
import type { Content, Coord, ScreenScripts } from './game.ts';
import type { FlagRecord, FlagValue } from './player.ts';
import type { Script, ScriptContext } from './script.ts';

// The version of what mods are given. A mod says which it was written for
// (`api`), and isn't loaded by an engine with another.
export const MOD_API = 1;

// What a mod's scripts get besides `g`: the mod's own flags (as it declared
// them; they're kept in the player's flags as "<mod id>.<flag>").
export interface ModTools<MF extends FlagRecord> {
    flags: MF;
}

// What a mod's scripts get as `g`: everything a game's scripts get. The
// game's own flags are in g.flags, untyped (g.flags['ownsCastle']).
export type ModContext = { [K in keyof ScriptContext<FlagRecord>]: ScriptContext<FlagRecord>[K] };

// A mod's scripts are the game's, with the mod's tools too.
export type ModScript<MF extends FlagRecord> = (g: ModContext, mod: ModTools<MF>) => void | Promise<void>;

export interface ModScreen<MF extends FlagRecord> {
    // Runs every time the screen is drawn, after the game's.
    show?: ModScript<MF>;
    // Runs when the player steps on (x, y). Only on tiles with no trigger.
    at?: Readonly<Partial<Record<Coord, ModScript<MF>>>>;
}

// What a mod's mod.ts exports as its default. For type checking, write it as
//   export default { ... } satisfies Mod<{ wishes: number }>;
// importing the type only (import type { Mod } from '@fq2js/engine/mods'),
// so the mod needs nothing at run time.
export interface Mod<MF extends FlagRecord = FlagRecord> {
    // Lower case letters, digits and dashes; no two mods may share one.
    id: string;
    name: string;
    version: string;
    // The MOD_API it was written for.
    api: number;
    description?: string;
    // The mod's flags, with their starting values.
    flags?: MF;
    screens?: Readonly<Partial<Record<number, ModScreen<MF>>>>;
    // Scripts for monsters' after-fight hooks (Monster.after), by name.
    events?: Readonly<Record<string, ModScript<MF>>>;
    // Runs after the game's own opening, when a new game starts.
    newGame?: ModScript<MF>;
}

// A mod, read from its folder.
export interface LoadedMod {
    mod: Mod;
    dir: string;
    items: ItemCatalogue | null;
    monsters: Bestiary | null;
    maps: GameMap[];
}

// The parts of a game that mods add to.
export interface ModdableGame<F extends FlagRecord> {
    content: Content<F>;
    world: World;
    items: ItemCatalogue;
    monsters: Bestiary;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENTRIES = ['mod.ts', 'mod.js'];

// ---- Loading

// The mods in a folder (each in its own folder), sorted by id. A missing
// folder has none.
export async function loadMods(dir: string): Promise<LoadedMod[]> {
    if (!existsSync(dir)) {
        return [];
    }

    const mods: LoadedMod[] = [];
    for (const name of readdirSync(dir).sort()) {
        const modDir = join(dir, name);
        if (name.startsWith('_') || name.startsWith('.') || !statSync(modDir).isDirectory()) {
            continue;
        }

        mods.push(await loadMod(modDir));
    }

    const seen = new Map<string, string>();
    for (const { mod, dir: modDir } of mods) {
        const other = seen.get(mod.id);
        if (other !== undefined) {
            throw new InvalidData(`Two mods have the id "${mod.id}": ${other} and ${modDir}.`);
        }
        seen.set(mod.id, modDir);
    }

    return mods.sort((a, b) => a.mod.id.localeCompare(b.mod.id));
}

// One mod, from its folder.
export async function loadMod(dir: string): Promise<LoadedMod> {
    const entry = ENTRIES.map((file) => join(dir, file)).find((file) => existsSync(file));
    if (entry === undefined) {
        throw new InvalidData(`The mod in ${dir} has no mod.ts (or mod.js).`);
    }

    const module: unknown = await import(pathToFileURL(entry).href);
    const exported = typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined;
    const mod = readMod(exported, entry);
    const json = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const where = (file: string): string => `${mod.id}/${file}`;
    const mapsDir = join(dir, 'maps');
    return {
        mod,
        dir,
        items: existsSync(join(dir, 'items.json')) ? readItems(json('items.json'), where('items.json')) : null,
        monsters: existsSync(join(dir, 'monsters.json')) ? readBestiary(json('monsters.json'), where('monsters.json')) : null,
        maps: existsSync(mapsDir)
            ? readdirSync(mapsDir)
                .filter((file) => file.endsWith('.json'))
                .sort()
                .map((file) => readMap(JSON.parse(readFileSync(join(mapsDir, file), 'utf8')), where(`maps/${file}`)))
            : [],
    };
}

// Checks what a mod.ts exported. Its scripts are wrapped, so that whatever
// they are, they're called as ModScripts.
export function readMod(value: unknown, path: string): Mod {
    if (value === undefined) {
        throw new InvalidData(`${path}: expected a default export (the mod)`);
    }

    const r = record(value, path);
    const id = field(r, 'id', path, string);
    if (!ID.test(id)) {
        throw new InvalidData(`${path}.id: expected lower case letters, digits and dashes, found "${id}"`);
    }

    const api = field(r, 'api', path, integer);
    if (api !== MOD_API) {
        throw new InvalidData(`The mod "${id}" was written for mod API ${api}; this engine has mod API ${MOD_API}.`);
    }

    const mod: Mod = { id, name: field(r, 'name', path, string), version: field(r, 'version', path, string), api };
    if (r['description'] !== undefined) {
        mod.description = field(r, 'description', path, string);
    }

    if (r['flags'] !== undefined) {
        mod.flags = readFlags(r['flags'], `${path}.flags`);
    }

    if (r['screens'] !== undefined) {
        const screens: Partial<Record<number, ModScreen<FlagRecord>>> = {};
        for (const [key, entry] of Object.entries(record(r['screens'], `${path}.screens`))) {
            const where = `${path}.screens.${key}`;
            if (!/^[1-9]\d*$/.test(key)) {
                throw new InvalidData(`${where}: expected a screen number`);
            }

            screens[Number(key)] = readScreen(entry, where);
        }
        mod.screens = screens;
    }

    if (r['events'] !== undefined) {
        const events: Record<string, ModScript<FlagRecord>> = {};
        for (const [name, script] of Object.entries(record(r['events'], `${path}.events`))) {
            events[name] = readScript(script, `${path}.events.${name}`);
        }
        mod.events = events;
    }

    if (r['newGame'] !== undefined) {
        mod.newGame = readScript(r['newGame'], `${path}.newGame`);
    }

    return mod;
}

function readFlags(value: unknown, path: string): FlagRecord {
    const flags: FlagRecord = {};
    for (const [name, v] of Object.entries(record(value, path))) {
        if (typeof v !== 'boolean' && typeof v !== 'number' && typeof v !== 'string') {
            throw new InvalidData(`${path}.${name}: expected true or false, a number or a string`);
        }
        flags[name] = v;
    }
    return flags;
}

function readScreen(value: unknown, path: string): ModScreen<FlagRecord> {
    const r = record(value, path);
    const screen: { show?: ModScript<FlagRecord>; at?: Partial<Record<Coord, ModScript<FlagRecord>>> } = {};
    if (r['show'] !== undefined) {
        screen.show = readScript(r['show'], `${path}.show`);
    }

    if (r['at'] !== undefined) {
        const at: Partial<Record<Coord, ModScript<FlagRecord>>> = {};
        for (const [key, script] of Object.entries(record(r['at'], `${path}.at`))) {
            const match = /^(\d+),(\d+)$/.exec(key);
            if (!match) {
                throw new InvalidData(`${path}.at.${key}: expected a tile as "x,y"`);
            }
            at[`${Number(match[1])},${Number(match[2])}`] = readScript(script, `${path}.at.${key}`);
        }
        screen.at = at;
    }

    return screen;
}

// A function from a mod, as a ModScript (whatever it returns, it's awaited).
function readScript(value: unknown, path: string): ModScript<FlagRecord> {
    if (typeof value !== 'function') {
        throw new InvalidData(`${path}: expected a function`);
    }

    return async (g, tools) => {
        const result: unknown = Reflect.apply(value, undefined, [g, tools]);
        await result;
    };
}

// ---- Adding mods to a game

// The game with its mods added. The game itself is left as it was.
export function applyMods<F extends FlagRecord>(game: ModdableGame<F>, mods: readonly LoadedMod[]): ModdableGame<F> {
    const world = new World(new Map(game.world.screens().map((screen) => [screen, game.world.export(screen)])));
    const items = game.items.all();
    const monsters = new Map(game.monsters.allMonsters());
    const tables: EncounterTable[] = game.monsters.allTables();
    const screens: Partial<Record<number, ScreenScripts<F>>> = { ...game.content.screens };
    const events: Record<string, Script<F>> = { ...game.content.events };
    const start = structuredClone(game.content.start);
    const startFlags: FlagRecord = start.flags;
    let newGame = game.content.newGame;

    for (const loaded of mods) {
        const { mod } = loaded;
        const conflict = (what: string): never => {
            throw new InvalidData(`The mod "${mod.id}" adds ${what}, which the game (or another mod) already has.`);
        };
        const defaults = mod.flags ?? {};
        const run = (script: ModScript<FlagRecord>): Script<F> => (g) => script(g, { flags: flagView(mod.id, defaults, g.flags) });

        for (const name of Object.keys(defaults)) {
            startFlags[`${mod.id}.${name}`] = defaults[name] ?? false;
        }

        for (const map of loaded.maps) {
            if (world.has(map.screen)) {
                conflict(`screen ${map.screen}`);
            }
            world.put(map);
        }

        for (const item of loaded.items?.all() ?? []) {
            if (items.some((i) => i.id === item.id)) {
                conflict(`the item "${item.id}"`);
            }
            items.push(item);
        }

        for (const [id, monster] of loaded.monsters?.allMonsters() ?? []) {
            if (monsters.has(id)) {
                conflict(`the monster "${id}"`);
            }
            monsters.set(id, monster);
        }

        for (const table of loaded.monsters?.allTables() ?? []) {
            if (tables.some((t) => t.name === table.name)) {
                conflict(`the encounter table "${table.name}"`);
            }
            tables.push(table);
        }

        for (const [name, script] of Object.entries(mod.events ?? {})) {
            if (events[name]) {
                conflict(`the event "${name}"`);
            }
            events[name] = run(script);
        }

        for (const [key, modScreen] of Object.entries(mod.screens ?? {})) {
            const screen = Number(key);
            if (!modScreen) {
                continue;
            }

            if (!world.has(screen)) {
                throw new InvalidData(`The mod "${mod.id}" has scripts for screen ${screen}, which doesn't exist.`);
            }

            const before = screens[screen] ?? {};
            const at: Partial<Record<Coord, Script<F>>> = { ...before.at };
            for (const [coord, script] of coords(modScreen.at)) {
                if (at[coord]) {
                    conflict(`a trigger at ${coord} on screen ${screen}`);
                }
                at[coord] = run(script);
            }

            const show = modScreen.show ? chain(before.show, run(modScreen.show)) : before.show;
            screens[screen] = { ...(show ? { show } : {}), at };
        }

        if (mod.newGame) {
            newGame = chain(newGame, run(mod.newGame));
        }
    }

    return {
        world,
        items: new ItemCatalogue(items),
        monsters: new Bestiary(monsters, tables),
        content: { ...game.content, start, screens, events, newGame },
    };
}

// A mod's scripts' view of its flags: each one reads and writes the
// player's "<mod id>.<flag>" (its default until it's set).
function flagView<MF extends FlagRecord>(id: string, defaults: MF, flags: FlagRecord): MF {
    const view = { ...defaults };
    for (const name of Object.keys(defaults)) {
        const key = `${id}.${name}`;
        Object.defineProperty(view, name, {
            enumerable: true,
            get: () => flags[key] ?? defaults[name],
            set: (value: FlagValue) => {
                flags[key] = value;
            },
        });
    }
    return view;
}

function chain<F extends FlagRecord>(first: Script<F> | undefined, then: Script<F>): Script<F> {
    if (!first) {
        return then;
    }

    return async (g) => {
        await first(g);
        await then(g);
    };
}

function coords<T>(at: Readonly<Partial<Record<Coord, T>>> | undefined): [Coord, T][] {
    const out: [Coord, T][] = [];
    for (const [key, value] of Object.entries(at ?? {})) {
        const match = /^(\d+),(\d+)$/.exec(key);
        if (match && value !== undefined) {
            out.push([`${Number(match[1])},${Number(match[2])}`, value]);
        }
    }
    return out;
}

// A one-line description of a mod, for logs.
export const describeMod = ({ mod }: LoadedMod): string => `${mod.name} ${mod.version} (${mod.id})`;

