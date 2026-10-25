// The item catalogue (data/items.json) and what items do.
//
// Players carry a count of each item, by id, and equip one weapon and one
// armour from what they carry. A weapon's or armour's power is what counts
// in fights; usable items have an effect and are used up.

import { InvalidData, array, boolean, field, integer, number, oneOf, record, string, type Reader } from './validate.ts';

export const ITEM_KINDS = ['weapon', 'armour', 'usable', 'quest', 'misc'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

// What using an item does to the player.
export interface ItemEffect {
    heal: number;
    maxHp: number;
    strength: number;
    defense: number;
}

export interface ItemDef {
    id: string;
    name: string;
    kind: ItemKind;
    // Weapons and armour: how strong they are in a fight.
    power: number;
    // What a shop asks for it.
    value: number;
    // Quest items can never be sold or dropped.
    sellable: boolean;
    // The chance, in percent, that it breaks in each fight it's used in.
    breakChance: number;
    description: string;
    // Usable items: what using it does, and the message shown.
    effect: ItemEffect | null;
    useText: string;
}

const NO_EFFECT: ItemEffect = { heal: 0, maxHp: 0, strength: 0, defense: 0 };

const effect: Reader<ItemEffect> = (value, path) => {
    const r = record(value, path);
    return {
        heal: field(r, 'heal', path, integer, 0),
        maxHp: field(r, 'maxHp', path, integer, 0),
        strength: field(r, 'strength', path, integer, 0),
        defense: field(r, 'defense', path, integer, 0),
    };
};

const itemDef: Reader<ItemDef> = (value, path) => {
    const r = record(value, path);
    const id = field(r, 'id', path, string);
    if (!/^[a-z0-9-]+$/.test(id)) {
        throw new InvalidData(`${path}.id: expected lower case letters, digits and dashes, found "${id}"`);
    }
    const kind = field(r, 'kind', path, oneOf(ITEM_KINDS));
    const item: ItemDef = {
        id,
        name: field(r, 'name', path, string),
        kind,
        power: field(r, 'power', path, number, 0),
        value: field(r, 'value', path, integer, 0),
        sellable: kind !== 'quest' && field(r, 'sellable', path, boolean, true),
        breakChance: field(r, 'breakChance', path, number, 0),
        description: field(r, 'description', path, string, ''),
        effect: r['effect'] === undefined ? null : field(r, 'effect', path, effect),
        useText: field(r, 'useText', path, string, ''),
    };
    if (kind === 'usable' && !item.effect) {
        throw new InvalidData(`${path}.effect: a usable item needs an effect`);
    }

    return item;
};

export class ItemCatalogue {
    private readonly items: ReadonlyMap<string, ItemDef>;

    public constructor(items: readonly ItemDef[]) {
        const byId = new Map<string, ItemDef>();
        for (const item of items) {
            if (byId.has(item.id)) {
                throw new InvalidData(`Two items have the id "${item.id}".`);
            }
            byId.set(item.id, item);
        }
        this.items = byId;
    }

    public has(id: string): boolean {
        return this.items.has(id);
    }

    public get(id: string): ItemDef {
        const item = this.items.get(id);
        if (!item) {
            throw new RangeError(`There's no item "${id}".`);
        }
        return item;
    }

    // Every item, in catalogue order.
    public all(): ItemDef[] {
        return [...this.items.values()];
    }

    // The item with this name (for upgrading old saves), if there is one.
    public named(name: string): ItemDef | undefined {
        return this.all().find((item) => item.name === name);
    }
}

export function readItems(value: unknown, path = 'items.json'): ItemCatalogue {
    return new ItemCatalogue(array(value, path, itemDef));
}

// The effect of an item, or nothing at all.
export const effectOf = (item: ItemDef): ItemEffect => item.effect ?? NO_EFFECT;

// ---- Carrying items

// Everything below works on the parts of the player that hold items.
export interface Carrier {
    items: Record<string, number>;
    weapon: string | null;
    armour: string | null;
}

export function count(carrier: Carrier, id: string): number {
    return carrier.items[id] ?? 0;
}

export function give(carrier: Carrier, id: string, n: number, catalogue: ItemCatalogue): void {
    catalogue.get(id); // throws for an unknown item
    if (!Number.isInteger(n) || n < 0) {
        throw new RangeError(`Can't give ${n} of "${id}".`);
    }
    if (n > 0) {
        carrier.items[id] = count(carrier, id) + n;
    }
}

// Takes n of an item if the player has that many. Taking the last one of
// an equipped item unequips it.
export function take(carrier: Carrier, id: string, n: number): boolean {
    const have = count(carrier, id);
    if (have < n) {
        return false;
    }
    if (have === n) {
        carrier.items = Object.fromEntries(Object.entries(carrier.items).filter(([other]) => other !== id));
        if (carrier.weapon === id) {
            carrier.weapon = null;
        }
        if (carrier.armour === id) {
            carrier.armour = null;
        }
    } else {
        carrier.items[id] = have - n;
    }

    return true;
}

// Equips a weapon or armour the player carries.
export function equip(carrier: Carrier, id: string, catalogue: ItemCatalogue): void {
    const item = catalogue.get(id);
    if (item.kind !== 'weapon' && item.kind !== 'armour') {
        throw new RangeError(`${item.name} isn't a weapon or armour.`);
    }
    if (count(carrier, id) < 1) {
        throw new RangeError(`The player doesn't have ${item.name}.`);
    }

    carrier[item.kind] = id;
}

// The power of the equipped weapon and armour, for fights.
export function gearOf(carrier: Carrier, catalogue: ItemCatalogue): { weapon: number; armour: number } {
    return {
        weapon: carrier.weapon === null ? 0 : catalogue.get(carrier.weapon).power,
        armour: carrier.armour === null ? 0 : catalogue.get(carrier.armour).power,
    };
}

// After a fight, each equipped item may break (its breakChance, in
// percent). Returns a message for each one that did.
export function wear(carrier: Carrier, catalogue: ItemCatalogue, random: () => number = Math.random): string[] {
    const messages: string[] = [];
    for (const id of [carrier.weapon, carrier.armour]) {
        if (id === null) {
            continue;
        }
        const item = catalogue.get(id);
        if (item.breakChance > 0 && random() * 100 < item.breakChance) {
            take(carrier, id, 1);
            messages.push(`{lightred}Your ${item.name} breaks!`);
        }
    }

    return messages;
}
