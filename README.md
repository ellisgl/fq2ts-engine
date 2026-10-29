# @fq2ts/engine

The game engine Final Quest 2 runs on: an 80x25 terminal screen, maps, text
markup, the `g` API that scripts use, combat, items and saves. A game supplies
its content (scripts for each screen, the starting player, the title screen)
and its data (maps, items, monsters); the engine does the rest: the title
menu, walking the world, the status bar, random fights, the inventory and
world map keys, saving and loading.

The same game runs in a terminal (single-player) or, with
[@fq2ts/server](https://github.com/ellisgl/fq2ts-server), in web browsers
for many players at once.

[Making a game](https://github.com/ellisgl/hello-quest/blob/main/docs/making-a-game.md)
is the step-by-step guide, built around [Hello Quest](https://github.com/ellisgl/hello-quest),
the smallest whole game. [Final Quest 2](https://github.com/ellisgl/final-quest-2)
is a bigger one. This page is the map of the engine itself.

- [Using it](#using-it)
- [How a game fits together](#how-a-game-fits-together)
- [The data folder](#the-data-folder)
- [The content](#the-content)
- [Scripts: the `g` API](#scripts-the-g-api)
- [Text markup](#text-markup)
- [The files](#the-files)
- [Testing a game](#testing-a-game)
- [Development](#development)

## Using it

```json
"dependencies": {
  "@fq2ts/engine": "github:ellisgl/fq2ts-engine#cc6e1ef4572ee3d8117bd32c9178b994b47e4263"
},
"overrides": {
  "@fq2ts/engine": "github:ellisgl/fq2ts-engine#cc6e1ef4572ee3d8117bd32c9178b994b47e4263"
}
```

It ships its TypeScript source, which Bun runs as it is. Name it by its
full commit hash (v0.13.1's above), not the tag, and give the same in
`overrides`: `@fq2ts/server` and `@fq2ts/tools` depend on it too, and Bun
fails to resolve a tag that a project and its dependencies both name, or
installs two engines for two different names, so a game's content and the
server wouldn't share one.

Each release's commit hash is the line ending in `^{}` here (the other is
the tag's own):

```sh
git ls-remote --tags https://github.com/ellisgl/fq2ts-engine
```

Each file is its own module: `import { Game } from '@fq2ts/engine/game'`,
`import { draw } from '@fq2ts/engine/text'`, and so on.

## How a game fits together

A game is three things:

```
my-game/
  data/           what the world is: config.json, items.json,
                  monsters.json, maps/ (one file per screen)
  content.ts      what happens in it: the title screen, the starting
                  player, and scripts for screens, tiles and keys
  game.ts         the entry point: reads the data, makes a Game, runs it
```

The entry point, in full (Hello Quest's, less its `--mods` options):

```ts
import { join } from 'node:path';
import { Terminal } from '@fq2ts/engine/terminal';
import { Saves } from '@fq2ts/engine/saves';
import { Game } from '@fq2ts/engine/game';
import { readGameData } from '@fq2ts/engine/data';
import content from './content.ts';

// Read (and check) everything before taking over the terminal, so a
// mistake in a data file is a plain message, not a garbled screen.
const { config, ...data } = readGameData(join(import.meta.dir, 'data'));
const game = new Game({
    term: new Terminal({ name: config.title }),
    config,
    ...data,                  // world, items, monsters
    content,
    saves: new Saves(join(import.meta.dir, 'saves')),
});

game.term.start();
await game.run();             // until the player leaves from the title menu
game.term.stop();
```

To add mods, wrap the data and content with `applyMods` (see
[mods.ts](#modsts)). For a multiplayer server, the same `content` and
data folder go to `runServer` from `@fq2ts/server` instead.

## The data folder

[data.ts](src/data.ts)'s `readGameData(dir)` reads all of it, and every
file is checked as it's read: a mistake is an error naming the place
(`items.json[1].effect: a usable item needs an effect`). Test Quest's
[src/fixture/](src/fixture/) is a complete small example.

**config.json**: the game's name and version, shown on the title, help and
credits screens; `superhumanFactor` is how much harder a superhuman player
hits.

```json
{ "title": "Test Quest", "company": "Test Company", "companyShort": "TestCo",
  "version": "V1.0", "revision": "Rev A", "superhumanFactor": 3 }
```

**items.json**: a list of items. `kind` is `weapon`, `armour`, `usable`,
`quest` (never sold or dropped) or `misc`. Weapons and armour have a
`power` (and a `breakChance`, in percent per fight); usable items have an
`effect` (`heal`, `maxHp`, `strength`, `defense`) and a `useText`. `value`
is what shops ask.

```json
[
  { "id": "stick", "name": "Stick", "kind": "weapon", "power": 15, "value": 50,
    "breakChance": 2, "description": "A sturdy stick. Mostly." },
  { "id": "wildberries", "name": "Wildberries", "kind": "usable", "value": 1,
    "sellable": false, "description": "Small, sweet and good for you.",
    "effect": { "heal": 5 }, "useText": "You eat some wildberries. Delicious! (+5 hitpoints)" }
]
```

**monsters.json**: `monsters`, and the encounter `tables` that random
fights pick from. A table's monsters are listed weakest first; one step in
`chance` on wild ground starts a fight, and `tiers` keep players with
little experience to the first few. A monster's `after` names content
scripts (`Content.events`) to run once a fight is `won`, `lost` or `fled`.

```json
{
  "monsters": [
    { "id": "tree-frog", "name": "Tree Frog", "pronoun": "it", "hp": 15, "gold": 15, "exp": 11,
      "says": "Want some poison? Tree Frog Gasps at you!",
      "attacks": [{ "text": "spits poison at you", "power": 15 }, { "text": "leaps at your face", "power": 12 }],
      "kill": "You squash the Tree Frog flat. Ribbit." }
  ],
  "tables": [
    { "name": "default", "chance": 30,
      "tiers": [{ "belowExp": 500, "pick": 3 }, { "belowExp": 5000, "pick": 6 }],
      "monsters": ["tree-frog", "woodpecker", "owl", "leopard", "wolf", "bear"] }
  ]
}
```

**maps/**: one file per screen, `0001.json` for screen 1. Screens sit on
a grid 80 wide, so screen n's neighbours are n-1, n+1, n-80 and n+80, and
the player walks off one edge onto the next screen. Each screen is 79x22
cells, kept as 22 strings per layer: `tiles` (the characters), `fg` and
`bg` (a hex digit per cell for the 16 colours, or two for all 256),
`solid` (`#` or `.`), `terrain` (`.` grass, `f` forest, `m` mountain, `w`
water, `r` road, `_` floor, `#` structure) and, if any, `triggers` (a
character per tile whose script is in the content). `kind` is the screen's
kind: 0 water, 1 land, 2 interior, 3 town, 4 small town; 5 to 8 are land,
small town, town and water with random monsters. A map can also say
`name`, `encounters` (a table other than `default`), and on a server
`safe`, `inn` or `home`.

The maps are best made with the level editor in
[@fq2ts/tools](https://github.com/ellisgl/fq2ts-tools) (`bun run edit`),
not by hand.

> **Rows and columns count from 1.** The top left cell is (1,1): a map's
> columns are 1-79 and its rows 1-22, and the whole screen is 80x25. The
> same numbers are used everywhere in the engine: `at` tiles (`"9,9"`),
> `{x}` and `{y}` in markup, `g.x` and `g.y`, `g.moveTo` and `g.goto`, and
> the level editor. Icy Draw counts from 0, so add 1 to both of the
> numbers it shows: its 8,8 is the engine's 9,9.

## The content

A game's `Content<Flags, World>` ([game.ts](src/game.ts)) is everything
that makes it that game:

| Field | What it is |
|---|---|
| `title` | The title screen's `art` (lines of markup) and its `menu`: where each of the six options (new game, save, load, help, resume, leave) goes, and their colours. |
| `help`, `credits` | Their screens, as lines of markup. |
| `worldMapLegend` | Markup drawn over the world map (M). |
| `statusLine(player, config)` | The text of the status bar under the map. |
| `start` | The player at the start of a new game, flags and all. |
| `newGame` | A script run when a new game starts (asking the name, say). |
| `inventory` | The script for I. |
| `world` | Values shared by every player on a server (kept with the save in single-player), with their starting values. `{}` for none. |
| `screens` | Scripts for each screen, by number: `show` runs each time it's drawn; `at` runs when the player steps on (or bumps into) a tile, by `"x,y"`; `triggers` does the same for every tile the map marks with a character. |
| `keys` | The game's own keys while exploring (listed by ?). |
| `events` | Scripts monsters' `after` hooks run, by name. |
| `daily` | Flags that go back to their start values each day on a server. |
| `upgradeSave` | Brings an old save up to date. |

`Flags` is the game's own state for each player: a type of named booleans,
numbers and strings (`{ readSign: boolean; metHermit: boolean }`), whose
starting values are in `start.flags`. Scripts read and set them as
`g.flags.readSign`, and they're saved with the player.

A screen's scripts look like this:

```ts
screens: {
    1: {
        // Every time screen 1 is drawn.
        show: (g) => g.overlay('{x 20}{y 12}{yellow}≡'),
        at: {
            // The sign, a solid tile: bumping into it reads it.
            '20,12': (g) => {
                g.write(g.flags.readSign ? 'It still says: monsters to the east.' : 'Beware of monsters to the east!');
                g.flags.readSign = true;
            },
            // A door into the hut, screen 1000.
            '31,10': (g) => g.goto(1000, 40, 19),
        },
    },
},
```

## Scripts: the `g` API

A script is `async (g) => { ... }`, and `g` is a `ScriptContext`
([script.ts](src/script.ts)). After a script finishes, the game redraws the
map if the script took over the screen, and travels if it called `goto`.

| | |
|---|---|
| **The player** | `g.name`, `g.title`, `g.sex`, `g.bySex(male, female)`, `g.hp`, `g.maxHp`, `g.gold`, `g.strength`, `g.defense`, `g.exp`, `g.alignment` (-10 to 10), `g.flags`, `g.healFull()`, `await g.spend(gold)` |
| **Items** | `g.give(id, n)`, `g.take(id, n)`, `g.has(id, n)`, `g.count(id)`, `g.item(id)`, `g.inventory`, `g.equip(id)`, `g.unequip(slot)`, `g.weapon`, `g.armour`, `g.use(id)` (returns its use text) |
| **Shops** | `await g.buy(ids, { prices })`, `await g.sell({ kinds, rate })` |
| **Talking** | `g.write(text)` (the status bar), `g.cls()` and `g.print(...lines)` (a screen of its own), `g.overlay(markup)` (over the map), `await g.key()`, `await g.choice(options)`, `await g.scroll(lines, title)` |
| **Asking** | `await g.input({ x, y, length })`, `await g.ask(...)` (null on Escape), `await g.askLine(question)`, `await g.number(...)` |
| **Moving** | `g.x`, `g.y`, `g.screenNumber`, `g.moveTo(x, y)`, `g.goto(screen, x, y)` |
| **Fighting** | `g.monster(id)`, `await g.fight(monster, { defeat, victory, left })` (`'won'`, `'lost'` or `'fled'`) |
| **The world** | `g.world` (the content's `world`), `g.news(text)` (a server's daily news), `g.nearby()` (other players next to this one, on a server) |
| **Other** | `g.random(n)` (1 to n), `await g.sleep(seconds)`, `await g.animate(delay, path)`, `g.version` |

An `await`ed call waits for the player, so a script reads in order:

```ts
async function hermit(g: G): Promise<void> {
    g.cls();
    g.print('{lightcyan}"Visitors! Take this, you look like you\'ll need it."', '', '{gray}Press any key...');
    g.give('potion');
    await g.key();
}
```

## Text markup

Everything the game writes is markup ([text.ts](src/text.ts)):

```
{yellow}        foreground colour (black, blue, green, cyan, red, magenta,
                brown, gray, darkgray, lightblue, lightgreen, lightcyan,
                lightred, lightmagenta, yellow, white)
{color 208}     foreground colour by number, 0-255
{blink red}     blinking foreground (a name or a number)
{on blue}       background colour (a name or a number)
{x 27} {y 5}    move to a column / row (counting from 1)
{sp 10}         ten spaces in the current colours
{center}        centre the rest of the line
{{              a literal "{"
```

Put a player's own words through `escapeMarkup` before writing them, so a
name with a `{` in it can't change colours.

## The files

All in [src/](src/). The ones a game uses most are first.

### Running a game

#### [game.ts](src/game.ts)
The `Game`: the title menu, walking the world, the built-in screens
(help, credits, the world map, inventory), random fights, saving, and
running the content's scripts. Also the `Content` and `Config` types,
`readConfig`, and `placeTriggers` (which turns a map's trigger characters
into `at` scripts). Make one with a `Terminal`, the data and the content,
then `await game.run()`. A server gives it more (`autosave`, a shared
`worldStore`, `news`, `nearby` players, `figures` drawn over the map, its
own `keys`...); single-player needs none of them.

#### [script.ts](src/script.ts)
`ScriptContext`, the `g` that every script gets (see above), and the
`Script` type: `(g) => void | Promise<void>`.

#### [data.ts](src/data.ts)
`readGameData(dir)`: a game's data folder read and checked, as
`{ config, world, items, monsters }`.

#### [terminal.ts](src/terminal.ts)
The `Terminal`: raw keyboard (and, if asked, mouse) input, and drawing.
`new Terminal({ name })` uses the process's stdin and stdout; a server
gives it a connection's instead. `term.start()` / `term.stop()` take over
and give back the terminal; `await term.key()` reads one key, as a name
(`'up'`, `'enter'`, `'escape'`...) or the character typed. Also
`parseKeys`, which turns raw input into keys.

#### [screen.ts](src/screen.ts)
The `Screen`: an 80x25 grid of cells (a character, its colours and blink),
drawn to the terminal by sending only the cells that changed. Colours are
0-255: the 16 CGA colours (`COLORS`), then xterm's. `colorDepth(env)`
works out what the terminal can show (true colour, 256 or 16), and the
screen gets as close as it can.

#### [text.ts](src/text.ts)
The markup (see above): `draw(screen, markup, { x, y })` draws it,
`width` measures it, `strip` takes the markup out, `escapeMarkup` makes
text safe to put in it.

#### [ui.ts](src/ui.ts)
Widgets the game is built from, for scripts or screens of your own:
`statusBar`, `choose` (a menu; mouse too), `textInput` / `askText` /
`prompt` (typing), and `scrollText` (a long text, a page at a time).

#### [chars.ts](src/chars.ts)
What can go in a cell: one character one column wide (any Unicode letter,
symbol or line drawing, but not emoji or other wide characters).
`cells(text)` splits text into cells, `cellCount` measures it, and
`fitsCell` checks one.

### The world and its things

#### [world.ts](src/world.ts)
The `World` (every screen's map, by number; `World.load(dir)` reads a
maps folder) and a `GameMap` (a screen: its tiles, colours, solid cells,
terrain and triggers). `readMap` / `writeMap` read and write map files,
`blankMap` makes an empty one, `inferTerrain` guesses terrain from how a
tile looks, and the constants say how big things are (`MAP_WIDTH`,
`MAP_HEIGHT`, `GRID_WIDTH`) and what map kinds and terrains there are.

#### [player.ts](src/player.ts)
The `Player`: what's saved (name, position, hitpoints, gold, strength,
defense, experience, items, what's equipped, flags...), with `FlagRecord`
for a game's flags. `restorePlayer` checks a loaded save against the start
player, keeping what's valid and filling in what's new, so old saves keep
working as a game grows; `equipped` finds a slot's item.

#### [items.ts](src/items.ts)
The `ItemCatalogue` (`readItems` reads items.json; `catalogue.get(id)`),
and what can be done with items: `give`, `take`, `count`, `equip`,
`gearOf` (weapon and armour power), and `wear` (items breaking after a
fight).

#### [combat.ts](src/combat.ts)
Turn-based fights on the bottom three rows of the screen: `fight`, the
`Bestiary` (`readBestiary` reads monsters.json; `bestiary.monster(id)`,
`bestiary.table(name)`), `pickMonster` (a random one from a table, by the
player's experience), and how hard each side hits (`playerDamage`,
`monsterDamage`). Scripts start fights with `g.fight`.

#### [shared.ts](src/shared.ts)
The world's state (`Content.world`): what belongs to everyone rather than
each player. `MemoryWorld` keeps it in memory for single-player (saved with
the player); a server gives the game its own `WorldStore`, so every player
sees the same. `restoreWorld` checks a saved one.

#### [saves.ts](src/saves.ts)
`Saves`: five save slots as `saves/slotN.json`, for the title menu's save
and load. `new Saves(dir)`; a server has accounts instead.

### Ready-made parts

#### [shop.ts](src/shop.ts)
The shop menus behind `g.buy` and `g.sell`, like LORD II's: a list of
items with prices that the player picks from, offering to equip what they
buy; and their items to sell, at a `rate` of what they're worth.

```ts
// A blacksmith: three weapons, the stick at a bargain.
triggers: { B: async (g) => { g.cls(); g.print('{white}"Best steel in the valley."', ''); await g.buy(['stick', 'shotgun', 'rpg'], { prices: { stick: 20 } }); } }
```

#### [jobs.ts](src/jobs.ts)
A `JobBoard`, as LORD II's deliveries: townspeople hand the player a sack
or letter to take to someone in another town, for gold that grows with the
jobs they've done. A game adds `JobFlags` to its flags (`JOB_FLAGS` to the
start player's), lists the givers, and puts `jobs.giver(id, greeting)` on
their tiles, or `jobs.talk(g, id)` in a menu they already have.

```ts
const jobs = new JobBoard<Flags>({ givers: [
    { id: 'bartender', name: 'the bartender', town: 'Port City' },
    { id: 'healer', name: 'the healer', town: 'Hill Valley' },
] });
// ...
triggers: { T: jobs.giver('bartender', '{white}"What\'ll it be?"') }
```

#### [mods.ts](src/mods.ts)
Mods: folders of TypeScript and data that add to a game without changing
it: screens, scripts on any screen, items, monsters, events, and their own
flags and world state. `loadMods(dir, names)` loads the ones named (only
those; a folder that isn't named is never run), `readModList` reads a
setting such as `"wishing-well, other-mod"` into names, and `applyMods`
merges them into a game's content and data. Mods only add: anything one
adds that's already there is an error naming the mod.

```ts
import { applyMods, loadMods, readModList } from '@fq2ts/engine/mods';

const mods = await loadMods('mods', readModList(process.env['MY_GAME_MODS'], 'MY_GAME_MODS'));
const game = new Game({ term, config, ...applyMods({ content, ...data }, mods), saves });
```

A mod's `mod.ts` exports a `Mod` (its id, name, version, the `api` it was
written for, and its scripts); see Final Quest 2's
[docs/mods.md](https://github.com/ellisgl/final-quest-2/blob/main/docs/mods.md)
for writing one.

#### [icy.ts](src/icy.ts)
Screens drawn in [Icy Draw](https://github.com/mkrueger/icy_tools/blob/master/crates/icy_draw/README.md)
(0.6 or later). `readIcy` reads a `.icy` file, `flatten` draws its layers
together, `pictureMarkup` turns that into markup, `tagMarkup` fills its
tags with the game's text (`@TITLE@`, `@VERSION@`...), and `layerBox`
finds a named layer (where a menu goes, say). `writeIcy` writes one back.
A title screen's `art` can be an `.icy` file this way, instead of markup
written by hand.

### Small helpers

- [validate.ts](src/validate.ts): checks for values read from JSON
  (`record`, `string`, `number`, `integer`, `boolean`, `array`, `oneOf`,
  `field`), each throwing an `InvalidData` that names the path to the bad
  value. Use them for a game's own data files too.
- [files.ts](src/files.ts): `writeFileAtomic`, which writes a file so that
  stopping part way leaves the old one whole.
- [assert.ts](src/assert.ts): `at` and `cellAt`, indexing that throws
  instead of returning undefined, for lookups that can only miss through a
  bug.

### For tests

#### [testing.ts](src/testing.ts)
A kit for testing games: `FakeTerminal`, which plays back keys instead of
reading the keyboard (a step can be a function, to look at the screen at
that moment); `screenText` and `row` to read the screen; `typed` and
`pick` for typing and menu choices; and small `makeMap`, `makeWorld`,
`monster`, `mouse` and `tempDir` helpers.

#### [fixture.ts](src/fixture.ts)
Test Quest: a tiny game (four screens, a few triggers, data in
[fixture/](src/fixture/)) that the engine, server and tools are tested on.
`makeGameWith(content, setup)` makes a `Game` on a `FakeTerminal` for any
game's content; `makeGame` and `scriptContext` do it for Test Quest.

## Testing a game

A whole game can be played from a test, with `bun test`:

```ts
import { expect, test } from 'bun:test';
import { readGameData } from '@fq2ts/engine/data';
import { makeGameWith } from '@fq2ts/engine/fixture';
import { screenText, typed } from '@fq2ts/engine/testing';
import content from '../content.ts';

test('a new game asks your name', async () => {
    const { game, term } = makeGameWith(content, { ...readGameData('data'), screensaver: false });
    term.feed(
        'enter',               // New game
        ...typed('Ada'),       // the name, and Enter
        () => {
            expect(screenText(term.screen)).toContain('Hello, Ada!');
            return 'x';
        },
        'escape', 'escape',    // back to the title menu, and Leave
    );
    await game.run();
    expect(game.playing.name).toBe('Ada');
});
```

The engine's own tests, in [test/](test/), are more examples of each part.

## Development

```sh
bun install
bun run check          # tsc (strict) + eslint + tests
```

`tsc` is TypeScript 7 (installed as `@typescript/native`); `typescript`
stays at 6 only because typescript-eslint needs the compiler API, which
TypeScript 7 doesn't have yet.
