import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLOTS, Saves } from '../src/saves.ts';
import { tempDir } from '../src/testing.ts';

describe('Saves', () => {
    test('every slot starts empty', () => {
        const saves = new Saves(join(tempDir(), 'saves'));
        expect(saves.list()).toEqual(Array.from({ length: SLOTS }, (_, i) => ({ slot: i + 1, name: null })));
        expect(saves.exists(1)).toBe(false);
    });

    test('save creates the folder and writes the slot', () => {
        const dir = join(tempDir(), 'saves');
        const saves = new Saves(dir);
        saves.save(2, 'Hero', { gold: 5 });
        expect(saves.exists(2)).toBe(true);
        expect(saves.list()[1]).toEqual({ slot: 2, name: 'Hero' });
        expect(saves.load(2)).toEqual({ gold: 5 });

        const file: unknown = JSON.parse(readFileSync(join(dir, 'slot2.json'), 'utf8'));
        expect(file).toMatchObject({ name: 'Hero', state: { gold: 5 } });
        expect(existsSync(join(dir, 'slot1.json'))).toBe(false);
    });

    test('saving again overwrites', () => {
        const saves = new Saves(tempDir());
        saves.save(1, 'A', 1);
        saves.save(1, 'B', 2);
        expect(saves.list()[0]?.name).toBe('B');
        expect(saves.load(1)).toBe(2);
    });

    test('damaged slots show as empty', () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'slot1.json'), '{not json');
        writeFileSync(join(dir, 'slot2.json'), JSON.stringify({ name: 7 }));
        writeFileSync(join(dir, 'slot3.json'), '[]');
        const names = new Saves(dir).list().map((s) => s.name);
        expect(names.slice(0, 3)).toEqual([null, null, null]);
    });

    test('load throws for a missing or damaged slot', () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'slot1.json'), '[]');
        const saves = new Saves(dir);
        expect(() => saves.load(1)).toThrow('slot1.json: expected an object');
        expect(() => saves.load(4)).toThrow();
    });

    test('load gives undefined when a save has no state', () => {
        const dir = tempDir();
        writeFileSync(join(dir, 'slot1.json'), JSON.stringify({ name: 'x' }));
        expect(new Saves(dir).load(1)).toBeUndefined();
    });
});
