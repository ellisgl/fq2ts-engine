import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { fight, monsterDamage, pickMonster, playerDamage, readBestiary, readMonster, type EncounterTable, type Fighter, type Gear } from '../../engine/combat.ts';
import { FakeTerminal, monster, readData, row } from '../helpers.ts';

let random: Mock<() => number> | null = null;

// Makes Math.random return these values in turn, then the last one forever.
function randomValues(...values: number[]): void {
    let i = 0;
    random = spyOn(Math, 'random').mockImplementation(() => values[Math.min(i++, values.length - 1)] ?? 0);
}

afterEach(() => {
    random?.mockRestore();
    random = null;
});

// No weapon or armour.
const bare: Gear = { weapon: 0, armour: 0 };

function fighter(changes: Partial<Fighter> = {}): Fighter {
    return { hp: 100, maxHp: 100, gold: 50, exp: 100, strength: 10, defense: 10, superhuman: false, ...changes };
}

const frog = monster();
const hits = (power: number) => ({ text: 'hits you', power });

describe('readBestiary', () => {
    test('reads data/monsters.json', () => {
        const bestiary = readBestiary(readData('monsters.json'));
        const table = bestiary.table('default');
        expect(table.chance).toBe(30);
        expect(table.tiers).toHaveLength(3);
        expect(table.monsters[0]?.name).toBe('Tree Frog');
        expect(bestiary.monster('lion')).toMatchObject({ pronoun: 'he', defense: 10, kill: 'The king is dead. Long live you.' });
        expect(bestiary.monster('tree-elf').after).toEqual({ won: 'elf-berries' });
        expect(bestiary.tableNames()).toEqual(['default', 'forest']);
        expect(bestiary.hooks()).toEqual(['elf-berries']);
        expect(bestiary.hasTable('forest')).toBe(true);
    });

    test('fills in defaults', () => {
        expect(readMonster({ name: 'Rat', says: 'Squeak', hp: 1, gold: 1, exp: 1, attacks: [hits(1)] }, 'rat')).toEqual({
            name: 'Rat',
            says: 'Squeak',
            pronoun: 'it',
            hp: 1,
            defense: 0,
            gold: 1,
            exp: 1,
            attacks: [hits(1)],
            kill: '',
            after: {},
        });
    });

    test('unknown monsters and tables are errors', () => {
        const bestiary = readBestiary(readData('monsters.json'));
        expect(() => bestiary.monster('dragon')).toThrow('There\'s no monster "dragon".');
        expect(() => bestiary.table('desert')).toThrow('There\'s no encounter table "desert".');
    });

    const rat = { id: 'rat', name: 'Rat', says: 'Squeak', hp: 1, gold: 1, exp: 1, attacks: [hits(1)] };
    test.each([
        [{ monsters: [{ ...rat, hp: '1' }], tables: [] }, 'monsters.json.monsters[0].hp: expected a whole number'],
        [{ monsters: [{ ...rat, attacks: [] }], tables: [] }, 'monsters.json.monsters[0].attacks: expected at least one attack'],
        [{ monsters: [{ ...rat, pronoun: 'they' }], tables: [] }, 'monsters.json.monsters[0].pronoun: expected one of he, she, it'],
        [{ monsters: [{ ...rat, after: { drew: 'x' } }], tables: [] }, 'monsters.json.monsters[0].after key: expected one of won, lost, fled'],
        [{ monsters: [{ ...rat, after: { won: 3 } }], tables: [] }, 'monsters.json.monsters[0].after.won: expected a string'],
        [{ monsters: [rat, rat], tables: [] }, 'monsters.json.monsters[1].id: "rat" is used twice'],
        [{ monsters: [rat], tables: [{ name: 't', chance: 1, monsters: ['cat'] }] }, 'monsters.json.tables[0].monsters[0]: there\'s no monster "cat"'],
        [{ monsters: [rat], tables: [{ name: 't', chance: 1, monsters: [] }] }, 'monsters.json.tables[0].monsters: expected at least one monster'],
        [{ monsters: [rat], tables: [{ name: 't', chance: 1, monsters: ['rat'], tiers: [{ belowExp: 5, pick: 2 }] }] }, 'monsters.json.tables[0].tiers[0].pick: expected 1 to 1'],
        [{ monsters: [rat], tables: [{ name: 't', monsters: ['rat'] }] }, 'monsters.json.tables[0].chance: expected a whole number'],
        [[], 'monsters.json: expected an object'],
    ])('rejects bad data: %p', (data, message) => {
        expect(() => readBestiary(data)).toThrow(message);
    });
});

describe('playerDamage', () => {
    test('bare hands hit for 1-10 plus strength', () => {
        randomValues(0, 0, 0, 0, 0);
        // roll(10)+1 = 1, bonus 1, coin → strength + bonus, no power hit
        expect(playerDamage(fighter(), bare, 3)).toEqual({ damage: 12, powerHit: false });
    });

    test('a weapon adds its power, spread up or down', () => {
        randomValues(0.99, 0.99, 0, 0, 0);
        // power 20: spread roll(10) = 9, coin false → 20 - 9 = 11; then 10 + 1 = 11
        expect(playerDamage(fighter(), { weapon: 20, armour: 0 }, 3).damage).toBe(22);
    });

    test('strong weapons spread less', () => {
        randomValues(0.99, 0, 0, 0, 0);
        // power 60: spread roll(10)+1 = 10, coin true → 70; then 11
        expect(playerDamage(fighter(), { weapon: 60, armour: 0 }, 3).damage).toBe(81);
    });

    test('power hits double the damage', () => {
        randomValues(0, 0, 0, 0.99);
        expect(playerDamage(fighter(), bare, 3)).toEqual({ damage: 24, powerHit: true });
    });

    test('superhuman players multiply it', () => {
        randomValues(0);
        expect(playerDamage(fighter({ superhuman: true }), bare, 3).damage).toBe(36);
    });

    test('can be nothing at all', () => {
        randomValues(0.99, 0.99, 0.99, 0.99, 0);
        // power 1 → 1; strength 0 - bonus 1 → -1
        expect(playerDamage(fighter({ strength: 0 }), { weapon: 1, armour: 0 }, 3).damage).toBe(0);
    });
});

describe('monsterDamage', () => {
    test('attack less defence, plus 1-5', () => {
        randomValues(0);
        expect(monsterDamage(hits(15), fighter(), bare, 3)).toBe(6);
    });

    test('armour absorbs some', () => {
        randomValues(0, 0);
        // spread roll(1)+1 = 1, coin true → +1, minus power 2
        expect(monsterDamage(hits(15), fighter(), { weapon: 0, armour: 2 }, 3)).toBe(5);
    });

    test('no damage when defence is higher', () => {
        randomValues(0);
        expect(monsterDamage(hits(15), fighter({ defense: 100 }), bare, 3)).toBe(0);
    });

    test('superhuman players take a fraction', () => {
        randomValues(0);
        expect(monsterDamage(hits(15), fighter({ superhuman: true }), bare, 3)).toBe(2);
    });
});

describe('pickMonster', () => {
    const table: EncounterTable = {
        name: 'test',
        chance: 1,
        tiers: [{ belowExp: 100, pick: 1 }],
        monsters: [frog, { ...frog, name: 'Bear' }],
    };

    test('players below a tier only meet the first monsters', () => {
        randomValues(0.99);
        expect(pickMonster(table, 50).name).toBe('Frog');
    });

    test('past every tier, any monster', () => {
        randomValues(0.99);
        expect(pickMonster(table, 100).name).toBe('Bear');
    });
});

describe('fight', () => {
    test("winning gives the monster's gold and experience", async () => {
    // Player goes first and hits for 38 (a power hit).
        randomValues(0.99);
        const player = fighter();
        const term = new FakeTerminal(['enter', 'x', 'x']);
        expect(await fight(term, player, bare, frog)).toBe('won');
        expect(player.gold).toBe(65);
        expect(player.exp).toBe(111);
        expect(term.remaining).toBe(0);
        expect(row(term.screen, 23)).toContain("Frog's hitpoints - Dead");
    });

    test('the monster may strike first, and fights go on until someone drops', async () => {
        const values = [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        randomValues(...values);
        const player = fighter();
        const tough = { ...frog, hp: 30 };
        // Monster hits (Enter), player hits for 12 → 18 left, monster hits, player hits for 12 → 6 left, ...
        const term = new FakeTerminal(['enter', 'enter', 'enter', 'enter', 'enter', 'enter', 'enter', 'x', 'x']);
        expect(await fight(term, player, bare, tough)).toBe('won');
        expect(player.hp).toBe(100 - 6 * 3);
    });

    test('losing costs all gold, a tenth of experience, and leaves 10 hp', async () => {
        randomValues(0.1);
        const player = fighter({ hp: 5 });
        const term = new FakeTerminal(['enter', 'x']);
        expect(await fight(term, player, bare, monster({ attack: 500 }))).toBe('lost');
        expect(player).toMatchObject({ gold: 0, exp: 90, hp: 10 });
        expect(row(term.screen, 23)).toContain('You are defeated');
    });

    test("dying on your own turn's counter-attack also loses", async () => {
        randomValues(0.99);
        const player = fighter({ hp: 1 });
        const term = new FakeTerminal(['enter', 'enter', 'x']);
        expect(await fight(term, player, bare, monster({ hp: 1000, attack: 500 }))).toBe('lost');
    });

    test('running away usually works', async () => {
        randomValues(0.99);
        const term = new FakeTerminal(['right', 'left', 'right', 'enter']);
        expect(await fight(term, fighter(), bare, frog)).toBe('fled');
    });

    test('one time in ten the monster catches you', async () => {
        randomValues(0.55);
        const player = fighter({ hp: 1 });
        const term = new FakeTerminal(['right', 'enter', 'enter', 'x']);
        expect(await fight(term, player, bare, monster({ attack: 500 }))).toBe('lost');
    });

    test('getting caught but surviving lets you choose again', async () => {
        randomValues(0.55, 0.55, 0.55, 0, 0.99);
        const player = fighter();
        const term = new FakeTerminal(['right', 'enter', 'enter', 'right', 'enter']);
        expect(await fight(term, player, bare, frog)).toBe('fled');
        expect(player.hp).toBeLessThan(100);
    });

    test('superhumanFactor defaults to 3', async () => {
    // The monster strikes first (for 6 / 3), then one 12-point blow x 3 wins.
        randomValues(0);
        const player = fighter({ superhuman: true });
        const term = new FakeTerminal(['enter', 'enter', 'x', 'x']);
        expect(await fight(term, player, bare, { ...frog, hp: 36 })).toBe('won');
        expect(player.hp).toBe(98);
    });
});

describe('fight with richer monsters', () => {
    test('the monster uses one of its attacks, and says which', async () => {
    // Monster first (0.1 < 0.5), picks attack roll(2) = floor(0.6 * 2) = 1.
        randomValues(0.1, 0.6, 0.1);
        const player = fighter({ hp: 5 });
        const term = new FakeTerminal([
            () => {
                expect(row(term.screen, 25)).toStartWith('Frog breathes fire at you for');
                return 'enter';
            },
            'x',
        ]);
        const dragonish = monster({ attacks: [{ text: 'nibbles you', power: 1 }, { text: 'breathes fire at you', power: 500 }] });
        expect(await fight(term, player, bare, dragonish)).toBe('lost');
    });

    test('an attack that does no damage says so', async () => {
    // The monster goes first (0.1); running away works (roll(10) = 1).
        randomValues(0.1);
        const term = new FakeTerminal([
            () => {
                expect(row(term.screen, 25)).toBe('Frog hits you but does no damage. Hit Enter...');
                return 'enter';
            },
            'right',
            'enter',
        ]);
        expect(await fight(term, fighter(), bare, monster({ attack: 0 }))).toBe('fled');
    });

    test("defense takes damage off the player's blows", async () => {
    // The player goes first (0.99) and power-hits for 38, less 30 defense.
        randomValues(0.99);
        const term = new FakeTerminal([
            'enter',
            () => {
                expect(row(term.screen, 24)).toBe('You POWER HIT Frog for 8 points damage.');
                expect(row(term.screen, 23)).toContain("Frog's hitpoints - (92/100)");
                return 'enter';
            },
            'right',
            'enter',
        ]);
        expect(await fight(term, fighter(), bare, monster({ hp: 100, defense: 30, attack: 0 }))).toBe('fled');
    });

    test("a power-hit kill shows the monster's kill line, and pronouns are used", async () => {
        randomValues(0.99);
        const term = new FakeTerminal([
            'enter',
            'x',
            () => {
                expect(row(term.screen, 24)).toBe('The frog explodes into confetti.');
                return 'x';
            },
            () => {
                expect(row(term.screen, 24)).toBe('You killed Frog!  You find $15 on her and get 11 Experience..');
                return 'x';
            },
        ]);
        expect(await fight(term, fighter(), bare, monster({ kill: 'The frog explodes into confetti.', pronoun: 'she' }))).toBe('won');
    });
});

describe('fixes from the code review', () => {
    const rat = { id: 'rat', name: 'Rat', says: 'Squeak', hp: 1, gold: 1, exp: 1, attacks: [{ text: 'bites you', power: 1 }] };

    test('an encounter table needs a chance of at least 1', () => {
        expect(() => readBestiary({ monsters: [rat], tables: [{ name: 't', chance: 0, monsters: ['rat'] }] })).toThrow('monsters.json.tables[0].chance: expected 1 or more');
    });

    test('tiers must go up in experience', () => {
        const tiers = [{ belowExp: 500, pick: 1 }, { belowExp: 100, pick: 1 }];
        expect(() => readBestiary({ monsters: [rat], tables: [{ name: 't', chance: 1, monsters: ['rat'], tiers }] })).toThrow(
            'monsters.json.tables[0].tiers[1].belowExp: expected more than the tier before (500)',
        );
    });

    test('losing never leaves more hitpoints than the maximum', async () => {
        randomValues(0.1);
        const player = fighter({ hp: 1, maxHp: 5 });
        expect(await fight(new FakeTerminal(['enter', 'x']), player, bare, monster({ attack: 500 }))).toBe('lost');
        expect(player.hp).toBe(5);
    });
});
