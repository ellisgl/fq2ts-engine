import { afterEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { HEIGHT } from "../../engine/screen.ts";
import { makeMap, makeWorld, newPlayer, row, scriptContext, typed } from "../helpers.ts";

let random: Mock<() => number> | null = null;
afterEach(() => {
  random?.mockRestore();
  random = null;
});

describe("ScriptContext: the player", () => {
  test("reads the player's state", () => {
    const { g } = scriptContext({ player: newPlayer({ x: 3, y: 4, screen: 82, exp: 7 }, { berries: 5 }) });
    expect([g.x, g.y, g.screenNumber, g.exp, g.flags.berries]).toEqual([3, 4, 82, 7, 5]);
    expect(g.version).toBe("V0.94 Rev D");
  });

  test("hp stays between 0 and maxHp, in whole numbers", () => {
    const { g, game } = scriptContext();
    g.hp = 1000;
    expect(g.hp).toBe(250);
    g.hp = -5;
    expect(g.hp).toBe(0);
    g.hp = 10.7;
    expect(game.playing.hp).toBe(10);
  });

  test("maxHp is at least 1", () => {
    const { g } = scriptContext();
    g.maxHp = 0;
    expect(g.maxHp).toBe(1);
    g.maxHp = 300.9;
    expect(g.maxHp).toBe(300);
  });

  test("gold, strength, defense and exp are whole and never negative", () => {
    const { g, game } = scriptContext();
    g.gold = -10;
    g.strength = 12.9;
    g.defense = -1;
    g.exp = 5.5;
    expect([g.gold, g.strength, g.defense, g.exp]).toEqual([0, 12, 0, 5]);
    expect(game.playing.strength).toBe(12);
  });

  test("weapon, armour and flags", () => {
    const { g, game } = scriptContext();
    g.weapon = { name: "Club", power: 5, value: 1 };
    g.armour = { name: "Hat", power: 1, value: 1 };
    g.flags.ownsCastle = true;
    expect(game.playing.weapon.name).toBe("Club");
    expect(g.armour.name).toBe("Hat");
    expect(game.playing.flags.ownsCastle).toBe(true);
  });

  test("healFull", () => {
    const { g } = scriptContext({ player: newPlayer({ hp: 3 }) });
    g.healFull();
    expect(g.hp).toBe(250);
  });

  test("using it with no game in progress is an error", () => {
    const { g, game } = scriptContext();
    Object.assign(game, { player: null });
    expect(() => g.hp).toThrow("No game is in progress.");
  });
});

describe("ScriptContext: talking", () => {
  test("write shows a message in the status bar", () => {
    const { g, term } = scriptContext();
    g.write("Hello!");
    expect(row(term.screen, 23)).toContain("Hello!");
    expect(g.tookScreen).toBe(false);
  });

  test("cls and print take over the screen, printing downwards", () => {
    const { g, term } = scriptContext();
    term.screen.text(1, 1, "old", 15, 0);
    g.cls();
    expect(row(term.screen, 1)).toBe("");
    g.print("one", "two");
    g.print("{y 10}three", "four");
    expect([row(term.screen, 1), row(term.screen, 2), row(term.screen, 10), row(term.screen, 11)]).toEqual(["one", "two", "three", "four"]);
    expect(g.tookScreen).toBe(true);
  });

  test("print never goes below the last row", () => {
    const { g, term } = scriptContext();
    g.cls();
    g.print(...Array.from({ length: 30 }, (_, i) => `line ${i}`));
    expect(row(term.screen, HEIGHT)).toBe("line 29");
  });

  test("overlay draws without taking the screen", () => {
    const { g, term } = scriptContext();
    g.overlay("{x 5}{y 5}hi");
    expect(term.screen.cell(5, 5).ch).toBe("h");
    expect(g.tookScreen).toBe(false);
  });

  test("key waits for a key", async () => {
    const { g } = scriptContext({ steps: ["q"] });
    expect(await g.key()).toBe("q");
  });

  test("choice lists the options below the printed text", async () => {
    const { g, term } = scriptContext({ steps: ["down", "enter"] });
    g.cls();
    g.print("Pick one");
    expect(await g.choice(["Yes", "No"])).toBe(1);
    expect(row(term.screen, 2)).toBe("Yes");
    expect(row(term.screen, 3)).toBe("No");
    g.print("after");
    expect(row(term.screen, 4)).toBe("after");
    expect(g.tookScreen).toBe(true);
  });

  test("input and number", async () => {
    const { g } = scriptContext({ steps: [...typed("abc"), ...typed("42"), ...typed("4x"), ...typed("")] });
    const where = { x: 1, y: 1, length: 10 };
    expect(await g.input(where)).toBe("abc");
    expect(await g.number(where)).toBe(42);
    expect(await g.number(where)).toBe(0);
    expect(await g.number(where)).toBe(0);
  });

  test("sleep", async () => {
    const { g } = scriptContext();
    const started = Date.now();
    await g.sleep(5);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("ScriptContext: moving", () => {
  test("moveTo moves the player on this screen", () => {
    const { g, game, term } = scriptContext({ player: newPlayer({ screen: 82, x: 10, y: 10 }) });
    g.moveTo(12, 11);
    expect([game.playing.x, game.playing.y]).toEqual([12, 11]);
    expect(term.screen.cell(12, 11).ch).toBe("☺");
  });

  test("goto only records where to go", () => {
    const { g, game } = scriptContext();
    expect(g.destination).toBeNull();
    g.goto(82, 5, 6);
    expect(g.destination).toEqual({ screen: 82, x: 5, y: 6 });
    expect(game.playing.screen).toBe(721);
  });
});

describe("ScriptContext: rules", () => {
  test("random gives 1 to n", () => {
    const { g } = scriptContext();
    random = spyOn(Math, "random").mockReturnValue(0);
    expect(g.random(6)).toBe(1);
    random.mockReturnValue(0.999);
    expect(g.random(6)).toBe(6);
  });

  test("spend takes gold when there's enough", async () => {
    const { g } = scriptContext({ player: newPlayer({ gold: 50 }) });
    expect(await g.spend(50)).toBe(true);
    expect(g.gold).toBe(0);
  });

  test("spend says so when there isn't", async () => {
    const { g, term } = scriptContext({ player: newPlayer({ gold: 5 }), steps: ["x"] });
    expect(await g.spend(6)).toBe(false);
    expect(g.gold).toBe(5);
    expect(row(term.screen, 1)).toContain("Your funds aren't exactly");
    expect(term.remaining).toBe(0);
  });

  test("fight uses the configured superhuman factor", async () => {
    random = spyOn(Math, "random").mockReturnValue(0.99);
    const { g } = scriptContext({ player: newPlayer({ superhuman: true }), steps: ["enter", "x", "x"] });
    // Bare hands with random 0.99: 10 + 9, power hit x2, superhuman x3 = 114.
    expect(await g.fight({ name: "Wall", says: "...", hp: 114, attack: 0, gold: 1, exp: 1 })).toBe("won");
  });

  test("animate moves a sprite along a path and restores the map behind it", async () => {
    const world = makeWorld(makeMap(1));
    const { g, term } = scriptContext({ world, player: newPlayer({ screen: 1, x: 40, y: 20 }) });
    g.overlay("{x 5}{y 5}{red}☻");
    await g.animate(0.1, [[5, 5], [6, 5], [6, 6]]);
    expect(term.screen.cell(6, 6)).toMatchObject({ ch: "☻", fg: 4 });
    expect(term.screen.cell(5, 5).ch).toBe(" ");
    expect(term.screen.cell(6, 5).ch).toBe(" ");
  });
});
