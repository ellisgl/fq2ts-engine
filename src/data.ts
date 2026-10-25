// A game's data folder: config.json, items.json, monsters.json and maps/
// (one file per screen), read and checked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, type Config } from './game.ts';
import { readBestiary, type Bestiary } from './combat.ts';
import { readItems, type ItemCatalogue } from './items.ts';
import { World } from './world.ts';

export interface GameData {
    config: Config;
    world: World;
    items: ItemCatalogue;
    monsters: Bestiary;
}

export function readGameData(dir: string): GameData {
    const json = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return {
        config: readConfig(json('config.json')),
        world: World.load(join(dir, 'maps')),
        items: readItems(json('items.json')),
        monsters: readBestiary(json('monsters.json')),
    };
}
