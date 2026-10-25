import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/files.ts';
import { tempDir } from '../src/testing.ts';

test('writeFileAtomic writes or replaces a file and leaves nothing else behind', () => {
    const dir = tempDir();
    const path = join(dir, 'save.json');
    writeFileAtomic(path, 'one');
    expect(readFileSync(path, 'utf8')).toBe('one');
    writeFileSync(path, 'old');
    writeFileAtomic(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['save.json']);
});
