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

```json
"dependencies": {
  "@fq2ts/engine": "github:ellisgl/fq2ts-engine#f8066accf40f0a0fdecad3afe48a6cdf6f0adfc3"
},
"overrides": {
  "@fq2ts/engine": "github:ellisgl/fq2ts-engine#f8066accf40f0a0fdecad3afe48a6cdf6f0adfc3"
}
```

It ships its TypeScript source, which Bun runs as it is. Name it by its
full commit hash (v0.1.0's above), not the tag, and give the same in
`overrides`: `@fq2ts/server` and `@fq2ts/tools` depend on it too, and Bun
fails to resolve a tag that a project and its dependencies both name, or
installs two engines for two different names, so a game's content and the
server wouldn't share one.

## Development

```sh
bun install
bun run check          # tsc (strict) + eslint + tests
```
