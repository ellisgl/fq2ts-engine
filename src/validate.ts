// Checks for data read from JSON files. Each one returns the value with its
// real type or throws an InvalidData naming the path to the bad value, e.g.
// "monsters[3].hp: expected a number".

export class InvalidData extends Error {
    public override name = 'InvalidData';
}

export type Reader<T> = (value: unknown, path: string) => T;

function fail(path: string, expected: string): never {
    throw new InvalidData(`${path}: expected ${expected}`);
}

export function record(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(path, 'an object');
    }
    return { ...value };
}

export function string(value: unknown, path: string): string {
    return typeof value === 'string' ? value : fail(path, 'a string');
}

export function number(value: unknown, path: string): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'a number');
}

export function integer(value: unknown, path: string): number {
    return Number.isInteger(value) ? number(value, path) : fail(path, 'a whole number');
}

export function boolean(value: unknown, path: string): boolean {
    return typeof value === 'boolean' ? value : fail(path, 'true or false');
}

export function array<T>(value: unknown, path: string, item: Reader<T>): T[] {
    if (!Array.isArray(value)) {
        fail(path, 'a list');
    }
    return value.map((v: unknown, i) => item(v, `${path}[${i}]`));
}

// One of a fixed set of values.
export function oneOf<const T extends readonly unknown[]>(choices: T): Reader<T[number]> {
    return (value, path) => {
        const found = choices.find((c) => c === value);
        return found !== undefined ? found : fail(path, `one of ${choices.join(', ')}`);
    };
}

// A field of an object read with `reader`. A missing field uses `fallback`
// when one is given.
export function field<T>(obj: Record<string, unknown>, key: string, path: string, reader: Reader<T>, fallback?: T): T {
    const value = obj[key];
    if (value === undefined && fallback !== undefined) {
        return fallback;
    }
    return reader(value, `${path}.${key}`);
}
