// The player's state: what gets saved. The flags are up to the content;
// the engine only knows they are named booleans, numbers and strings.

import { record, string, number, integer, boolean, field, type Reader } from "./validate.ts";

export type FlagValue = boolean | number | string;
export type FlagRecord = Record<string, FlagValue>;

export interface Item {
  name: string;
  power: number;
  value: number;
}

export interface Player<F extends FlagRecord> {
  screen: number;
  x: number;
  y: number;
  // The outdoor screen shown as "you are here" on the world map.
  mapScreen: number;
  hp: number;
  maxHp: number;
  gold: number;
  strength: number;
  defense: number;
  exp: number;
  weapon: Item;
  armour: Item;
  // Whether random encounters are on.
  monsters: boolean;
  superhuman: boolean;
  flags: F;
}

// The player fields holding plain numbers (the ones the debug editor sets).
export type NumericField = "screen" | "x" | "y" | "mapScreen" | "hp" | "maxHp" | "gold" | "strength" | "defense" | "exp";

const item: Reader<Item> = (value, path) => {
  const r = record(value, path);
  return { name: field(r, "name", path, string), power: field(r, "power", path, number), value: field(r, "value", path, number) };
};

// Each flag must have the same type as its default; missing flags (from an
// older save) keep the default and unknown ones are dropped.
function restoreFlags<F extends FlagRecord>(defaults: F, value: unknown, path: string): F {
  const saved = record(value, path);
  const flags = structuredClone(defaults);
  const writable: FlagRecord = flags;
  for (const [name, fallback] of Object.entries(defaults)) {
    const v = saved[name];
    if (v === undefined) continue;
    if (typeof v !== typeof fallback) throw new TypeError(`${path}.${name}: expected a ${typeof fallback}`);
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") writable[name] = v;
  }
  return flags;
}

// A saved player, checked against the starting state. Missing fields keep
// their starting values.
export function restorePlayer<F extends FlagRecord>(start: Player<F>, value: unknown, path = "save"): Player<F> {
  const r = record(value, path);
  const int = (key: NumericField): number => field(r, key, path, integer, start[key]);
  return {
    screen: int("screen"),
    x: int("x"),
    y: int("y"),
    mapScreen: int("mapScreen"),
    hp: int("hp"),
    maxHp: int("maxHp"),
    gold: int("gold"),
    strength: int("strength"),
    defense: int("defense"),
    exp: int("exp"),
    weapon: field(r, "weapon", path, item, start.weapon),
    armour: field(r, "armour", path, item, start.armour),
    monsters: field(r, "monsters", path, boolean, start.monsters),
    superhuman: field(r, "superhuman", path, boolean, start.superhuman),
    flags: r["flags"] === undefined ? structuredClone(start.flags) : restoreFlags(start.flags, r["flags"], `${path}.flags`),
  };
}
