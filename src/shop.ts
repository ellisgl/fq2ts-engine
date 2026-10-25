// Shop menus for scripts (g.buy and g.sell), like LORD II's buy and sell
// managers. Both carry on from whatever the script has printed above them.

import type { FlagRecord } from "./player.ts";
import type { ItemDef, ItemKind } from "./items.ts";
import type { ScriptContext } from "./script.ts";

const CONTINUE = "{lightgreen}<{green}Continue{lightgreen}>";

export interface BuyOptions {
  // Prices that differ from the items' values, by item id.
  prices?: Readonly<Record<string, number>>;
}

export interface SellOptions {
  // Only these kinds of items are listed (default: everything).
  kinds?: readonly ItemKind[];
  // The share of an item's value paid for it (default: half).
  rate?: number;
}

// A menu line in columns. The text is plain; the colours are added here.
const label = (name: string, price: string, note: string, colour = "{white}"): string =>
  `${colour}${name.padEnd(18)}{yellow}${price.padEnd(9)}{gray}${note.slice(0, 49)}`;

async function pause<F extends FlagRecord>(g: ScriptContext<F>, ...lines: string[]): Promise<void> {
  g.print("", ...lines, "", CONTINUE);
  await g.key();
}

// Lists the items for sale. Returns the id of the item bought, or null.
// Buying a weapon or armour offers to equip it.
export async function buyMenu<F extends FlagRecord>(g: ScriptContext<F>, ids: readonly string[], { prices = {} }: BuyOptions = {}): Promise<string | null> {
  const items = ids.map((id) => g.item(id));
  const price = (item: ItemDef): number => prices[item.id] ?? item.value;
  const labels = items.map((item) => label(item.name, `$${price(item)}`, item.description));
  const item = items[await g.choice([...labels, "{white}Never mind"])];
  if (!item) return null;

  if (g.gold < price(item)) {
    await pause(g, `{green}You can't afford the {white}${item.name}{green}. It costs {yellow}$${price(item)}{green}; you have {yellow}$${g.gold}{green}.`);
    return null;
  }
  g.gold -= price(item);
  g.give(item.id);
  g.print("", `{green}You buy the {white}${item.name}{green}.`);
  if (item.kind === "weapon" || item.kind === "armour") {
    const current = item.kind === "weapon" ? g.weapon : g.armour;
    g.print(`{green}Use it instead of ${current ? `your {white}${current.name}` : "nothing"}{green}?`);
    if ((await g.choice(["Yes", "No, keep it in my pack"])) === 0) g.equip(item.id);
  } else {
    await pause(g);
  }
  return item.id;
}

// Lists the player's items for selling. Returns the id of the item sold, or
// null. Items that can't be sold are shown greyed out.
export async function sellMenu<F extends FlagRecord>(g: ScriptContext<F>, { kinds, rate = 0.5 }: SellOptions = {}): Promise<string | null> {
  const entries = g.inventory.filter((e) => !kinds || kinds.includes(e.item.kind));
  if (!entries.length) {
    await pause(g, "{green}You have nothing they want.");
    return null;
  }
  const price = (item: ItemDef): number => Math.floor(item.value * rate);
  const worn = (item: ItemDef): boolean => g.weapon?.id === item.id || g.armour?.id === item.id;
  const labels = entries.map(({ item, count }) => {
    const name = `${item.name}${count > 1 ? ` x${count}` : ""}`;
    return item.sellable ? label(name, `$${price(item)}`, worn(item) ? "(in use)" : "") : label(name, "", "", "{darkgray}");
  });
  const entry = entries[await g.choice([...labels, "{white}Never mind"])];
  if (!entry) return null;
  const { item } = entry;

  if (!item.sellable) {
    await pause(g, "{green}They don't seem interested in that.");
    return null;
  }
  g.print("", `{green}Sell your {white}${item.name}{green} for {yellow}$${price(item)}{green}?`);
  if ((await g.choice(["Yes", "No"])) !== 0) return null;
  g.take(item.id);
  g.gold += price(item);
  await pause(g, `{green}Sold. You now have {yellow}$${g.gold}{green}.`);
  return item.id;
}
