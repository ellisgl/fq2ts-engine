import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { fight, monsterDamage, pickMonster, playerDamage, readMonsterTable, type Fighter, type Gear, type Monster, type MonsterTable } from "../../engine/combat.ts";
import { FakeTerminal, readData, row } from "../helpers.ts";

let random: Mock<() => number> | null = null;

// Makes Math.random return these values in turn, then the last one forever.
function randomValues(...values: number[]): void {
  let i = 0;
  random = spyOn(Math, "random").mockImplementation(() => values[Math.min(i++, values.length - 1)] ?? 0);
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

const frog: Monster = { name: "Frog", says: "Ribbit!", hp: 15, attack: 15, gold: 15, exp: 11 };

describe("readMonsterTable", () => {
  test("reads data/monsters.json", () => {
    const table = readMonsterTable(readData("monsters.json"));
    expect(table.chance).toBe(30);
    expect(table.tiers).toHaveLength(3);
    expect(table.monsters[0]?.name).toBe("Tree Frog");
  });

  test("rejects bad monsters and tiers", () => {
    expect(() => readMonsterTable({ chance: 1, tiers: [], monsters: [{ ...frog, hp: "1" }] })).toThrow("monsters.json.monsters[0].hp: expected a whole number");
    expect(() => readMonsterTable({ chance: 1, tiers: [{ belowExp: 1 }], monsters: [] })).toThrow("monsters.json.tiers[0].pick");
    expect(() => readMonsterTable({ tiers: [], monsters: [] })).toThrow("monsters.json.chance");
    expect(() => readMonsterTable([])).toThrow("monsters.json: expected an object");
  });
});

describe("playerDamage", () => {
  test("bare hands hit for 1-10 plus strength", () => {
    randomValues(0, 0, 0, 0, 0);
    // roll(10)+1 = 1, bonus 1, coin → strength + bonus, no power hit
    expect(playerDamage(fighter(), bare, 3)).toEqual({ damage: 12, powerHit: false });
  });

  test("a weapon adds its power, spread up or down", () => {
    randomValues(0.99, 0.99, 0, 0, 0);
    // power 20: spread roll(10) = 9, coin false → 20 - 9 = 11; then 10 + 1 = 11
    expect(playerDamage(fighter(), { weapon: 20, armour: 0 }, 3).damage).toBe(22);
  });

  test("strong weapons spread less", () => {
    randomValues(0.99, 0, 0, 0, 0);
    // power 60: spread roll(10)+1 = 10, coin true → 70; then 11
    expect(playerDamage(fighter(), { weapon: 60, armour: 0 }, 3).damage).toBe(81);
  });

  test("power hits double the damage", () => {
    randomValues(0, 0, 0, 0.99);
    expect(playerDamage(fighter(), bare, 3)).toEqual({ damage: 24, powerHit: true });
  });

  test("superhuman players multiply it", () => {
    randomValues(0);
    expect(playerDamage(fighter({ superhuman: true }), bare, 3).damage).toBe(36);
  });

  test("can be nothing at all", () => {
    randomValues(0.99, 0.99, 0.99, 0.99, 0);
    // power 1 → 1; strength 0 - bonus 1 → -1
    expect(playerDamage(fighter({ strength: 0 }), { weapon: 1, armour: 0 }, 3).damage).toBe(0);
  });
});

describe("monsterDamage", () => {
  test("attack less defence, plus 1-5", () => {
    randomValues(0);
    expect(monsterDamage(frog, fighter(), bare, 3)).toBe(6);
  });

  test("armour absorbs some", () => {
    randomValues(0, 0);
    // spread roll(1)+1 = 1, coin true → +1, minus power 2
    expect(monsterDamage(frog, fighter(), { weapon: 0, armour: 2 }, 3)).toBe(5);
  });

  test("no damage when defence is higher", () => {
    randomValues(0);
    expect(monsterDamage(frog, fighter({ defense: 100 }), bare, 3)).toBe(0);
  });

  test("superhuman players take a fraction", () => {
    randomValues(0);
    expect(monsterDamage(frog, fighter({ superhuman: true }), bare, 3)).toBe(2);
  });
});

describe("pickMonster", () => {
  const table: MonsterTable = {
    chance: 1,
    tiers: [{ belowExp: 100, pick: 1 }],
    monsters: [frog, { ...frog, name: "Bear" }],
  };

  test("players below a tier only meet the first monsters", () => {
    randomValues(0.99);
    expect(pickMonster(table, 50).name).toBe("Frog");
  });

  test("past every tier, any monster", () => {
    randomValues(0.99);
    expect(pickMonster(table, 100).name).toBe("Bear");
  });
});

describe("fight", () => {
  test("winning gives the monster's gold and experience", async () => {
    // Player goes first and hits for 38 (a power hit).
    randomValues(0.99);
    const player = fighter();
    const term = new FakeTerminal(["enter", "x", "x"]);
    expect(await fight(term, player, bare, frog)).toBe("won");
    expect(player.gold).toBe(65);
    expect(player.exp).toBe(111);
    expect(term.remaining).toBe(0);
    expect(row(term.screen, 23)).toContain("Frog's hitpoints - Dead");
  });

  test("the monster may strike first, and fights go on until someone drops", async () => {
    const values = [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    randomValues(...values);
    const player = fighter();
    const tough = { ...frog, hp: 30 };
    // Monster hits (Enter), player hits for 12 → 18 left, monster hits, player hits for 12 → 6 left, ...
    const term = new FakeTerminal(["enter", "enter", "enter", "enter", "enter", "enter", "enter", "x", "x"]);
    expect(await fight(term, player, bare, tough)).toBe("won");
    expect(player.hp).toBe(100 - 6 * 3);
  });

  test("losing costs all gold, a tenth of experience, and leaves 10 hp", async () => {
    randomValues(0.1);
    const player = fighter({ hp: 5 });
    const term = new FakeTerminal(["enter", "x"]);
    expect(await fight(term, player, bare, { ...frog, attack: 500 })).toBe("lost");
    expect(player).toMatchObject({ gold: 0, exp: 90, hp: 10 });
    expect(row(term.screen, 23)).toContain("You are defeated");
  });

  test("dying on your own turn's counter-attack also loses", async () => {
    randomValues(0.99);
    const player = fighter({ hp: 1 });
    const term = new FakeTerminal(["enter", "enter", "x"]);
    expect(await fight(term, player, bare, { ...frog, hp: 1000, attack: 500 })).toBe("lost");
  });

  test("running away usually works", async () => {
    randomValues(0.99);
    const term = new FakeTerminal(["right", "left", "right", "enter"]);
    expect(await fight(term, fighter(), bare, frog)).toBe("fled");
  });

  test("one time in ten the monster catches you", async () => {
    randomValues(0.55);
    const player = fighter({ hp: 1 });
    const term = new FakeTerminal(["right", "enter", "enter", "x"]);
    expect(await fight(term, player, bare, { ...frog, attack: 500 })).toBe("lost");
  });

  test("getting caught but surviving lets you choose again", async () => {
    randomValues(0.55, 0.55, 0.55, 0, 0.99);
    const player = fighter();
    const term = new FakeTerminal(["right", "enter", "enter", "right", "enter"]);
    expect(await fight(term, player, bare, frog)).toBe("fled");
    expect(player.hp).toBeLessThan(100);
  });

  test("superhumanFactor defaults to 3", async () => {
    // The monster strikes first (for 6 / 3), then one 12-point blow x 3 wins.
    randomValues(0);
    const player = fighter({ superhuman: true });
    const term = new FakeTerminal(["enter", "enter", "x", "x"]);
    expect(await fight(term, player, bare, { ...frog, hp: 36 })).toBe("won");
    expect(player.hp).toBe(98);
  });
});
