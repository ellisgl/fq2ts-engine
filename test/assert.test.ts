import { describe, expect, test } from "bun:test";
import { at, cellAt } from "../../engine/assert.ts";

describe("at", () => {
  test("returns the item at an index", () => {
    expect(at(["a", "b", "c"], 1)).toBe("b");
    expect(at("xyz", 2)).toBe("z");
    expect(at(new Uint8Array([5, 6]), 0)).toBe(5);
  });

  test("keeps falsy items", () => {
    expect(at([0, false, ""], 0)).toBe(0);
    expect(at([0, false, ""], 1)).toBe(false);
    expect(at([0, false, ""], 2)).toBe("");
  });

  test("throws for an index outside the list", () => {
    expect(() => at([1, 2], 2)).toThrow(RangeError);
    expect(() => at([1, 2], -1)).toThrow("Index -1 is out of range (length 2).");
    expect(() => at([], 0)).toThrow(RangeError);
  });
});

describe("cellAt", () => {
  const grid = [
    ["a", "b"],
    ["c", "d"],
  ];

  test("uses 1-based x and y", () => {
    expect(cellAt(grid, 1, 1)).toBe("a");
    expect(cellAt(grid, 2, 1)).toBe("b");
    expect(cellAt(grid, 1, 2)).toBe("c");
    expect(cellAt(grid, 2, 2)).toBe("d");
  });

  test("throws outside the grid", () => {
    expect(() => cellAt(grid, 0, 1)).toThrow(RangeError);
    expect(() => cellAt(grid, 1, 3)).toThrow(RangeError);
  });
});
