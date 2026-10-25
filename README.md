# @fq2js/engine

The game engine Final Quest 2 runs on: an 80x25 terminal screen, maps, text
markup, the `g` API that scripts use, combat, items and saves. A game supplies
its content (scripts for each screen, the starting player, the title screen)
and its data (maps, items, monsters).

[testing.ts](src/testing.ts) is a kit for testing games: a terminal that plays
back scripted key presses, and small maps, worlds and monsters.

See [games/fq2/](../../games/fq2/) for a game built on it.
