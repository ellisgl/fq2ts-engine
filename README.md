# @fq2ts/engine

The game engine Final Quest 2 runs on: an 80x25 terminal screen, maps, text
markup, the `g` API that scripts use, combat, items and saves. A game supplies
its content (scripts for each screen, the starting player, the title screen)
and its data (maps, items, monsters).

[testing.ts](src/testing.ts) is a kit for testing games: a terminal that plays
back scripted key presses, and small maps, worlds and monsters.
[fixture.ts](src/fixture.ts) is Test Quest, a tiny game (four screens, a few
triggers, data in [fixture/](src/fixture/)) that the engine, server and tools
are tested on.

[Making a game](https://github.com/ellisgl/hello-quest/blob/main/docs/making-a-game.md) is the guide to making a
game with it, built around [Hello Quest](https://github.com/ellisgl/hello-quest), the smallest
whole game. [Final Quest 2](https://github.com/ellisgl/FQ2TS) is a bigger one.

## Using it

```sh
bun add @fq2ts/engine@github:ellisgl/fq2ts-engine#v0.1.0
```

It ships its TypeScript source, which Bun runs as it is.

## Development

```sh
bun install
bun run check          # tsc (strict) + eslint + tests
```
