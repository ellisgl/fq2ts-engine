import { describe, expect, test } from "bun:test";
import { newPlayer, pick, row, screenText, scriptContext } from "../helpers.ts";

describe("g.buy", () => {
  test("lists the items with prices and descriptions, and Never mind", async () => {
    const { g, term } = scriptContext({
      steps: [
        () => {
          expect(row(term.screen, 1)).toBe("Stick             $50      A sturdy stick. Mostly.");
          expect(row(term.screen, 2)).toBe("Wildberries       $1       Small, sweet and good for you.");
          expect(row(term.screen, 3)).toBe("Never mind");
          return "escape";
        },
      ],
    });
    expect(await g.buy(["stick", "wildberries"])).toBeNull();
  });

  test("buying something that isn't gear just carries on", async () => {
    const { g, term } = scriptContext({
      steps: [
        ...pick(1),
        () => {
          expect(screenText(term.screen)).toContain("You buy the Wildberries.");
          return "x";
        },
      ],
    });
    expect(await g.buy(["stick", "wildberries"])).toBe("wildberries");
    expect(g.count("wildberries")).toBe(1);
    expect(g.gold).toBe(49);
  });

  test("prices can differ from the items' values", async () => {
    const { g, term } = scriptContext({
      player: newPlayer({ gold: 10 }),
      steps: [
        () => {
          expect(row(term.screen, 1)).toStartWith("RPG               $5 ");
          return "enter";
        },
        ...pick(0),
      ],
    });
    expect(await g.buy(["rpg"], { prices: { rpg: 5 } })).toBe("rpg");
    expect(g.weapon?.id).toBe("rpg");
    expect(g.gold).toBe(5);
  });

  test("buying gear when nothing is equipped", async () => {
    const { g, term } = scriptContext({
      steps: [
        "enter",
        () => {
          expect(screenText(term.screen)).toContain("Use it instead of nothing?");
          return "enter";
        },
      ],
    });
    await g.buy(["vest"]);
    expect(g.armour?.id).toBe("vest");
  });
});

describe("g.sell", () => {
  test("pays half by default and lists everything", async () => {
    const { g, term } = scriptContext({
      player: newPlayer({ gold: 0, items: { rpg: 1, wildberries: 3 }, weapon: "rpg" }),
      steps: [
        () => {
          expect(row(term.screen, 1)).toBe("RPG               $5000    (in use)");
          expect(row(term.screen, 2)).toBe("Wildberries x3");
          return "enter";
        },
        ...pick(0),
        "x",
      ],
    });
    expect(await g.sell()).toBe("rpg");
    expect(g.gold).toBe(5000);
    expect(g.weapon).toBeNull();
  });

  test("Never mind sells nothing", async () => {
    const { g } = scriptContext({ player: newPlayer({ items: { stick: 1 } }), steps: [...pick(1)] });
    expect(await g.sell()).toBeNull();
    expect(g.count("stick")).toBe(1);
  });
});
