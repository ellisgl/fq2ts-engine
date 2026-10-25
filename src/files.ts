// Writing files safely.

import { renameSync, writeFileSync } from 'node:fs';

// Writes a file all at once: the text goes to a temporary file next to it,
// which then replaces the file. If the game stops part way through, the
// old file is still whole.
export function writeFileAtomic(path: string, text: string): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
}
