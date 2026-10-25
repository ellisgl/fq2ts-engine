# @fq2js/engine

The game engine Final Quest 2 runs on: an 80x25 terminal screen, maps, text
markup, the `g` API that scripts use, combat, items and saves. A game supplies
its content (scripts for each screen, the starting player, the title screen)
and its data (maps, items, monsters).

[testing.ts](src/testing.ts) is a kit for testing games: a terminal that plays
back scripted key presses, and small maps, worlds and monsters.
[fixture.ts](src/fixture.ts) is Test Quest, a tiny game (four screens, a few
triggers, data in [fixture/](src/fixture/)) that the engine, server and tools
are tested on.

[docs/making-a-game.md](../../docs/making-a-game.md) is the guide to making a
game with it, built around [Hello Quest](../../games/hello/), the smallest
whole game. [Final Quest 2](../../games/fq2/) is a bigger one.
