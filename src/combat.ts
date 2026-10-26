// Turn-based fights on the bottom three rows of the screen.

import { draw } from './text.ts';
import { at } from './assert.ts';
import { InvalidData, record, string, number, integer, array, field, oneOf, type Reader } from './validate.ts';
import type { Color } from './screen.ts';
import type { Terminal } from './terminal.ts';

export interface Attack {
    // What the monster does, after its name: "spits poison at you".
    text: string;
    power: number;
}

export const PRONOUNS = ['he', 'she', 'it'] as const;
export type Pronoun = (typeof PRONOUNS)[number];
export type FightResult = 'won' | 'lost' | 'fled';

export interface Monster {
    name: string;
    // What it says when the fight starts.
    says: string;
    pronoun: Pronoun;
    hp: number;
    // Taken off every blow the player lands.
    defense: number;
    gold: number;
    exp: number;
    // It uses one of these, at random, each turn.
    attacks: Attack[];
    // Shown when the player kills it with a power hit (or "" for the usual).
    kill: string;
    // Names of content scripts (Content.events) to run after the fight ends
    // each way.
    after: Partial<Record<FightResult, string>>;
}

// A set of monsters to meet at random. Monsters are listed weakest first;
// each tier limits how far down the list a player with less experience can
// meet.
export interface EncounterTable {
    name: string;
    // One step in `chance` starts a fight.
    chance: number;
    tiers: { belowExp: number; pick: number }[];
    monsters: Monster[];
}

const attack: Reader<Attack> = (value, path) => {
    const r = record(value, path);
    return {
        text: field(r, 'text', path, string),
        power: field(r, 'power', path, number),
    };
};

const RESULTS = ['won', 'lost', 'fled'] as const;

const after: Reader<Monster['after']> = (value, path) => {
    const hooks: Monster['after'] = {};
    const r = record(value, path);
    for (const [key, script] of Object.entries(r)) {
        hooks[oneOf(RESULTS)(key, `${path} key`)] = string(script, `${path}.${key}`);
    }

    return hooks;
};

export const readMonster: Reader<Monster> = (value, path) => {
    const r = record(value, path);
    const attacks = field(r, 'attacks', path, (v, p) => array(v, p, attack));
    if (!attacks.length) {
        throw new InvalidData(`${path}.attacks: expected at least one attack`);
    }

    return {
        name: field(r, 'name', path, string),
        says: field(r, 'says', path, string),
        pronoun: field(r, 'pronoun', path, oneOf(PRONOUNS), 'it'),
        hp: field(r, 'hp', path, integer),
        defense: field(r, 'defense', path, number, 0),
        gold: field(r, 'gold', path, integer),
        exp: field(r, 'exp', path, integer),
        attacks,
        kill: field(r, 'kill', path, string, ''),
        after: r['after'] === undefined ? {} : field(r, 'after', path, after),
    };
};

// The monsters (data/monsters.json), by id, and the encounter tables, by name.
export class Bestiary {
    private readonly monsters: ReadonlyMap<string, Monster>;
    private readonly tables: ReadonlyMap<string, EncounterTable>;

    public constructor(monsters: ReadonlyMap<string, Monster>, tables: readonly EncounterTable[]) {
        this.monsters = monsters;
        this.tables = new Map(tables.map((t) => [t.name, t]));
    }

    // Every monster, by id, in the order they were read.
    public allMonsters(): [string, Monster][] {
        return [...this.monsters.entries()];
    }

    // Every encounter table, in the order they were read.
    public allTables(): EncounterTable[] {
        return [...this.tables.values()];
    }

    public monster(id: string): Monster {
        const monster = this.monsters.get(id);
        if (!monster) {
            throw new RangeError(`There's no monster "${id}".`);
        }
        return monster;
    }

    public table(name: string): EncounterTable {
        const table = this.tables.get(name);
        if (!table) {
            throw new RangeError(`There's no encounter table "${name}".`);
        }
        return table;
    }

    public hasTable(name: string): boolean {
        return this.tables.has(name);
    }

    public tableNames(): string[] {
        return [...this.tables.keys()];
    }

    // Every script name the monsters' after-fight hooks use.
    public hooks(): string[] {
        return [...new Set([...this.monsters.values()].flatMap((m) => Object.values(m.after)))];
    }
}

export function readBestiary(value: unknown, path = 'monsters.json'): Bestiary {
    const r = record(value, path);
    const monsters = new Map<string, Monster>();
    for (const [i, entry] of field(r, 'monsters', path, (v, p) => array(v, p, (m) => m)).entries()) {
        const where = `${path}.monsters[${i}]`;
        const id = field(record(entry, where), 'id', where, string);
        if (monsters.has(id)) {
            throw new InvalidData(`${where}.id: "${id}" is used twice`);
        }

        monsters.set(id, readMonster(entry, where));
    }

    const tables = field(r, 'tables', path, (v, p) =>
        array(v, p, (t, tp): EncounterTable => {
            const table = record(t, tp);
            const members = field(table, 'monsters', tp, (m, mp) => array(m, mp, string)).map((id, i) => {
                const monster = monsters.get(id);
                if (!monster) {
                    throw new InvalidData(`${tp}.monsters[${i}]: there's no monster "${id}"`);
                }

                return monster;
            });
            const tiers = field(
                table,
                'tiers',
                tp,
                (v2, p2) =>
                    array(
                        v2,
                        p2,
                        (tier, tierPath) => {
                            const tr = record(tier, tierPath);
                            const pick = field(tr, 'pick', tierPath, integer);
                            if (pick < 1 || pick > members.length) {
                                throw new InvalidData(`${tierPath}.pick: expected 1 to ${members.length}`);
                            }

                            return { belowExp: field(tr, 'belowExp', tierPath, number), pick };
                        },
                    ),
                [],
            );

            if (!members.length) {
                throw new InvalidData(`${tp}.monsters: expected at least one monster`);
            }

            // pickMonster takes the first tier the player is below.
            tiers.forEach((tier, i) => {
                const before = tiers[i - 1];
                if (before && tier.belowExp <= before.belowExp) {
                    throw new InvalidData(`${tp}.tiers[${i}].belowExp: expected more than the tier before (${before.belowExp})`);
                }
            });

            // One step in `chance` starts a fight, so 0 would mean every step.
            const chance = field(table, 'chance', tp, integer);
            if (chance < 1) {
                throw new InvalidData(`${tp}.chance: expected 1 or more`);
            }

            return { name: field(table, 'name', tp, string), chance, tiers, monsters: members };
        }),
    );

    return new Bestiary(monsters, tables);
}

// The parts of the player a fight uses (and changes).
export interface Fighter {
    hp: number;
    maxHp: number;
    gold: number;
    exp: number;
    strength: number;
    defense: number;
    superhuman: boolean;
}

// The power of the player's weapon and armour (0 for none).
export interface Gear {
    weapon: number;
    armour: number;
}


const roll = (n: number): number => Math.floor(Math.random() * n); // 0 .. n-1
const coin = (): boolean => Math.random() < 0.5;

// Damage the player deals with one blow.
export function playerDamage(player: Fighter, gear: Gear, superhumanFactor: number): { damage: number; powerHit: boolean } {
    const power = gear.weapon;
    let damage;
    if (power <= 0) {
        damage = roll(10) + 1;
    } else {
        const spread = power > 36 ? roll(Math.trunc(power / 6)) + 1 : roll(Math.trunc(power / 2));
        damage = coin() ? power + spread : power - spread;
    }

    const bonus = roll(Math.trunc(player.strength / 10)) + 1;
    damage += coin() ? player.strength + bonus : player.strength - bonus;
    const powerHit = roll(5) === 4;
    if (powerHit) {
        damage *= 2;
    }

    if (player.superhuman) {
        damage *= superhumanFactor;
    }

    return { damage: Math.max(0, damage), powerHit };
}

// Damage a monster deals to the player with one blow.
// Damage a monster's attack deals to the player.
export function monsterDamage(attack: Attack, player: Fighter, gear: Gear, superhumanFactor: number): number {
    let damage = attack.power;
    const armour = gear.armour;
    if (armour > 0) {
        const spread = roll(Math.trunc(armour / 6)) + 1;
        damage += coin() ? spread : -spread;
        damage -= armour;
    }
    damage -= player.defense;
    damage = damage <= 0 ? 0 : damage + roll(5) + 1;

    if (player.superhuman) {
        damage = Math.trunc(damage / superhumanFactor);
    }

    return damage;
}

export interface FightOptions {
    superhumanFactor?: number;
    // What losing does to the player, and what it says. By default (a
    // monster's way): no gold, a tenth less experience, 10 hitpoints.
    defeat?(player: Fighter): string;
    // What winning says (the monster's gold and experience are the player's
    // either way). By default: "You killed the ...! You find ...".
    victory?: string;
    // Told the monster's hitpoints when the fight ends, however it ends
    // (0 if it's dead): for a monster whose hitpoints are kept elsewhere,
    // like one everyone in the realm fights.
    left?(hp: number): void;
}

// A monster's way of beating the player.
function monsterDefeat(player: Fighter): string {
    player.exp -= Math.trunc(player.exp / 10);
    player.gold = 0;
    player.hp = Math.min(10, player.maxHp);
    return 'You are defeated... Your Gold and Experience have been lowered unfortunately..';
}

export async function fight(
    term: Terminal,
    player: Fighter,
    gear: Gear,
    monster: Monster,
    { superhumanFactor = 3, defeat = monsterDefeat, victory, left }: FightOptions = {},
): Promise<FightResult> {
    const { screen } = term;
    const maxHp = monster.hp;
    let hp = monster.hp;

    const clear = (y: number): void => {
        screen.fillRow(y, 0);
    };
    const line = (y: number, text: string, fg: Color, bg: Color = 0): void => {
        clear(y);
        draw(screen, text, { y, fg, bg });
    };
    const status = (dead = false): void => {
        for (let x = 1; x <= 79; x++) {
            screen.put(x, 23, ' ', 14, 1);
        }
        const mine = `Your Hitpoints - (${player.hp}/${player.maxHp}) ${monster.name}'s hitpoints - `;
        draw(screen, dead ? `${mine}{red}Dead` : `${mine}(${hp}/${maxHp})`, { y: 23, fg: 14, bg: 1 });
    };
    const anyKey = (): Promise<string> => term.key();
    const enter = async (): Promise<void> => {
    // Wait for Enter, ignoring other keys.
        while ((await term.key()) !== 'enter'){
            ;
        }
    };

    const monsterTurn = async (): Promise<boolean> => {
        const { attacks } = monster;
        const attack = attacks.length === 1 ? at(attacks, 0) : at(attacks, roll(attacks.length));
        const damage = monsterDamage(attack, player, gear, superhumanFactor);
        player.hp = Math.max(0, player.hp - damage);
        status();
        const result = damage > 0 ? `for ${damage} points damage` : 'but does no damage';
        line(25, `${monster.name} ${attack.text} ${result}. Hit Enter...`, 7);
        await enter();
        clear(24);
        clear(25);

        return player.hp > 0;
    };

    const lose = async (): Promise<FightResult> => {
        status();
        line(23, defeat(player), 14, 1);
        await anyKey();
        clear(24);
        clear(25);

        return 'lost';
    };

    const result = await (async (): Promise<FightResult> => {
        line(24, monster.says, 15);

        if (coin() && !(await monsterTurn())) {
            return lose();
        }

        for (;;) {
            status();
            let option = 0;
            let key;

            do {
                clear(25);
                draw(screen, option === 0 ? '{on blue}Attack{on black}  Run for it' : 'Attack  {on blue}Run for it', { y: 25, fg: 15, bg: 0 });
                key = await term.key();
                if (key === 'left' || key === 'right') {
                    option = 1 - option;
                }
            } while (key !== 'enter');

            clear(24);
            clear(25);

            if (option === 1) {
                // One time in ten the monster catches you as you run.
                if (roll(10) !== 5) {
                    return 'fled';
                }

                line(24, `As you attempt to leave, ${monster.name} sees you and attacks!`, 15);
                if (!(await monsterTurn())) {
                    return lose();
                }

                continue;
            }

            const blow = playerDamage(player, gear, superhumanFactor);
            const damage = Math.max(0, blow.damage - monster.defense);
            const { powerHit } = blow;
            hp -= damage;
            const verb = powerHit ? 'POWER HIT' : 'hit';
            line(24, `You ${verb} ${monster.name} for ${damage} points damage.${hp < 1 ? '  Press any key...' : ''}`, 7);
            if (hp < 1) {
                status(true);
                player.gold += monster.gold;
                player.exp += monster.exp;
                await anyKey();

                if (powerHit && monster.kill) {
                    line(24, `{lightcyan}${monster.kill}`, 15);
                    await anyKey();
                }

                const them = { he: 'him', she: 'her', it: 'it' }[monster.pronoun];
                line(24, victory ?? `{green}You killed {lightred}${monster.name}{green}!  You find {yellow}$${monster.gold} {green}on ${them} and get {white}${monster.exp}{green} Experience..`, 15);
                clear(25);
                await anyKey();
                clear(24);

                return 'won';
            }

            status();

            if (!(await monsterTurn())) {
                return lose();
            }
        }
    })();
    left?.(Math.max(0, hp));
    return result;
}

// Picks a random encounter.
export function pickMonster({ monsters, tiers }: EncounterTable, exp: number): Monster {
    const tier = tiers.find((t) => exp < t.belowExp);
    const count = tier ? tier.pick : monsters.length;

    return at(monsters, roll(count));
}
