import { describe, expect, test } from "bun:test";
import { restorePlayer, type Player } from "../../engine/player.ts";

type TestFlags = { seen: boolean; count: number; name: string };

const start: Player<TestFlags> = {
  screen: 1,
  x: 2,
  y: 3,
  mapScreen: 1,
  hp: 10,
  maxHp: 10,
  gold: 0,
  strength: 1,
  defense: 1,
  exp: 0,
  weapon: { name: "Nothing", power: 0, value: 0 },
  armour: { name: "Nothing", power: 0, value: 0 },
  monsters: false,
  superhuman: false,
  flags: { seen: false, count: 0, name: "" },
};

describe("restorePlayer", () => {
  test("a full save comes back as it was", () => {
    const saved: Player<TestFlags> = {
      ...start,
      screen: 7,
      gold: 99,
      weapon: { name: "Stick", power: 15, value: 50 },
      monsters: true,
      flags: { seen: true, count: 3, name: "Bob" },
    };
    expect(restorePlayer(start, JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  test("missing fields and flags keep their starting values", () => {
    const player = restorePlayer(start, { gold: 5, flags: { count: 2 } });
    expect(player.gold).toBe(5);
    expect(player.hp).toBe(10);
    expect(player.weapon).toEqual(start.weapon);
    expect(player.flags).toEqual({ seen: false, count: 2, name: "" });
    expect(restorePlayer(start, {}).flags).toEqual(start.flags);
  });

  test("never shares objects with the starting player", () => {
    const player = restorePlayer(start, {});
    player.flags.count = 9;
    expect(start.flags.count).toBe(0);
  });

  test("unknown flags are dropped", () => {
    expect(restorePlayer(start, { flags: { other: 1 } }).flags).toEqual(start.flags);
  });

  test.each([
    [{ hp: "10" }, "save.hp: expected a whole number"],
    [{ x: 1.5 }, "save.x: expected a whole number"],
    [{ weapon: { name: "Stick", power: "big", value: 1 } }, "save.weapon.power: expected a number"],
    [{ armour: "Vest" }, "save.armour: expected an object"],
    [{ monsters: "yes" }, "save.monsters: expected true or false"],
    [{ flags: [] }, "save.flags: expected an object"],
    [{ flags: { seen: "yes" } }, "save.flags.seen: expected a boolean"],
    [{ flags: { count: true } }, "save.flags.count: expected a number"],
    [null, "save: expected an object"],
  ])("rejects bad saves: %p", (saved, message) => {
    expect(() => restorePlayer(start, saved)).toThrow(message);
  });

  test("names the file in errors", () => {
    expect(() => restorePlayer(start, { hp: "x" }, "slot1.json")).toThrow("slot1.json.hp");
  });
});
