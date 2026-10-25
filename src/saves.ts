// Five save slots stored as saves/slotN.json.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './files.ts';
import { join } from 'node:path';
import { record } from './validate.ts';

export const SLOTS = 5;

// A slot and the name it was saved under (null when it's empty).
export interface SlotInfo {
    slot: number;
    name: string | null;
}

export class Saves {
    private readonly dir: string;

    public constructor(dir: string) {
        this.dir = dir;
    }

    private file(slot: number): string {
        return join(this.dir, `slot${slot}.json`);
    }

    private read(slot: number): Record<string, unknown> {
        const data: unknown = JSON.parse(readFileSync(this.file(slot), 'utf8'));
        return record(data, `slot${slot}.json`);
    }

    public list(): SlotInfo[] {
        return Array.from({ length: SLOTS }, (_, i) => {
            const slot = i + 1;
            try {
                const name = this.read(slot)['name'];
                return { slot, name: typeof name === 'string' ? name : null };
            } catch {
                return { slot, name: null };
            }
        });
    }

    public exists(slot: number): boolean {
        return existsSync(this.file(slot));
    }

    // The saved state, unchecked: the game checks it against its own types.
    public load(slot: number): unknown {
        return this.read(slot)['state'];
    }

    public save(slot: number, name: string, state: unknown): void {
        mkdirSync(this.dir, { recursive: true });
        const data = { name, savedAt: new Date().toISOString(), state };
        writeFileAtomic(this.file(slot), JSON.stringify(data, null, 2) + '\n');
    }
}
