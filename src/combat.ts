// Turn-based fights on the bottom three rows of the screen.

import { draw } from "./text.ts";
import { at } from "./assert.ts";
import { record, string, number, integer, array, field, type Reader } from "./validate.ts";
import type { Color } from "./screen.ts";
import type { Terminal } from "./terminal.ts";
import type { Item } from "./player.ts";

export interface Monster {
  name: string;
  says: string;
  hp: number;
  attack: number;
  gold: number;
  exp: number;
}

// Random encounters (data/monsters.json). Monsters are listed weakest first;
// each tier limits how far down the list a player with less experience can
// meet.
export interface MonsterTable {
  // One step in `chance` starts a fight.
  chance: number;
  tiers: { belowExp: number; pick: number }[];
  monsters: Monster[];
}

// The parts of the player a fight uses.
export interface Fighter {
  hp: number;
  maxHp: number;
  gold: number;
  exp: number;
  strength: number;
  defense: number;
  weapon: Item;
  armour: Item;
  superhuman: boolean;
}

export type FightResult = "won" | "lost" | "fled";

const monster: Reader<Monster> = (value, path) => {
  const r = record(value, path);
  return {
    name: field(r, "name", path, string),
    says: field(r, "says", path, string),
    hp: field(r, "hp", path, integer),
    attack: field(r, "attack", path, number),
    gold: field(r, "gold", path, integer),
    exp: field(r, "exp", path, integer),
  };
};

export function readMonsterTable(value: unknown, path = "monsters.json"): MonsterTable {
  const r = record(value, path);
  return {
    chance: field(r, "chance", path, integer),
    tiers: field(r, "tiers", path, (v, p) =>
      array(v, p, (t, tp) => {
        const tier = record(t, tp);
        return { belowExp: field(tier, "belowExp", tp, number), pick: field(tier, "pick", tp, integer) };
      }),
    ),
    monsters: field(r, "monsters", path, (v, p) => array(v, p, monster)),
  };
}

const roll = (n: number): number => Math.floor(Math.random() * n); // 0 .. n-1
const coin = (): boolean => Math.random() < 0.5;

// Damage the player deals with one blow.
export function playerDamage(player: Fighter, superhumanFactor: number): { damage: number; powerHit: boolean } {
  const power = player.weapon.power;
  let damage;
  if (power <= 0) damage = roll(10) + 1;
  else {
    const spread = power > 36 ? roll(Math.trunc(power / 6)) + 1 : roll(Math.trunc(power / 2));
    damage = coin() ? power + spread : power - spread;
  }
  const bonus = roll(Math.trunc(player.strength / 10)) + 1;
  damage += coin() ? player.strength + bonus : player.strength - bonus;
  const powerHit = roll(5) === 4;
  if (powerHit) damage *= 2;
  if (player.superhuman) damage *= superhumanFactor;
  return { damage: Math.max(0, damage), powerHit };
}

// Damage a monster deals to the player with one blow.
export function monsterDamage(monster: Monster, player: Fighter, superhumanFactor: number): number {
  let damage = monster.attack;
  const armour = player.armour.power;
  if (armour > 0) {
    const spread = roll(Math.trunc(armour / 6)) + 1;
    damage += coin() ? spread : -spread;
    damage -= armour;
  }
  damage -= player.defense;
  damage = damage <= 0 ? 0 : damage + roll(5) + 1;
  if (player.superhuman) damage = Math.trunc(damage / superhumanFactor);
  return damage;
}

export async function fight(
  term: Terminal,
  player: Fighter,
  monster: Monster,
  { superhumanFactor = 3 }: { superhumanFactor?: number } = {},
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
    for (let x = 1; x <= 79; x++) screen.put(x, 23, " ", 14, 1);
    const mine = `Your Hitpoints - (${player.hp}/${player.maxHp}) ${monster.name}'s hitpoints - `;
    draw(screen, dead ? `${mine}{red}Dead` : `${mine}(${hp}/${maxHp})`, { y: 23, fg: 14, bg: 1 });
  };
  const anyKey = (): Promise<string> => term.key();
  const enter = async (): Promise<void> => {
    while ((await term.key()) !== "enter");
  };

  const monsterTurn = async (): Promise<boolean> => {
    const damage = monsterDamage(monster, player, superhumanFactor);
    player.hp = Math.max(0, player.hp - damage);
    status();
    line(25, `${monster.name} hits you for ${damage} points damage. Hit Enter...`, 7);
    await enter();
    clear(24);
    clear(25);
    return player.hp > 0;
  };

  const lose = async (): Promise<FightResult> => {
    status();
    line(23, "You are defeated... Your Gold and Experience have been lowered unfortunately..", 14, 1);
    player.exp -= Math.trunc(player.exp / 10);
    player.gold = 0;
    player.hp = 10;
    await anyKey();
    clear(24);
    clear(25);
    return "lost";
  };

  line(24, monster.says, 15);
  if (coin() && !(await monsterTurn())) return lose();

  for (;;) {
    status();
    let option = 0;
    let key;
    do {
      clear(25);
      draw(screen, option === 0 ? "{on blue}Attack{on black}  Run for it" : "Attack  {on blue}Run for it", { y: 25, fg: 15, bg: 0 });
      key = await term.key();
      if (key === "left" || key === "right") option = 1 - option;
    } while (key !== "enter");
    clear(24);
    clear(25);

    if (option === 1) {
      // One time in ten the monster catches you as you run.
      if (roll(10) !== 5) return "fled";
      line(24, `As you attempt to leave, ${monster.name} sees you and attacks!`, 15);
      if (!(await monsterTurn())) return lose();
      continue;
    }

    const { damage, powerHit } = playerDamage(player, superhumanFactor);
    hp -= damage;
    const verb = powerHit ? "POWER HIT" : "hit";
    line(24, `You ${verb} ${monster.name} for ${damage} points damage.${hp < 1 ? "  Press any key..." : ""}`, 7);
    if (hp < 1) {
      status(true);
      player.gold += monster.gold;
      player.exp += monster.exp;
      await anyKey();
      line(24, `{green}You killed {lightred}${monster.name}{green}!  You find {yellow}$${monster.gold} {green}Gold and get {white}${monster.exp}{green} Experience..`, 15);
      clear(25);
      await anyKey();
      clear(24);
      return "won";
    }
    status();
    if (!(await monsterTurn())) return lose();
  }
}

// Picks a random encounter.
export function pickMonster({ monsters, tiers }: MonsterTable, exp: number): Monster {
  const tier = tiers.find((t) => exp < t.belowExp);
  const count = tier ? tier.pick : monsters.length;
  return at(monsters, roll(count));
}
