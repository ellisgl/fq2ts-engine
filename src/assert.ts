// Indexing for lookups that can only miss if there's a bug: it throws
// instead of returning undefined.

export function at<T>(list: ArrayLike<T>, i: number): T {
    const value = list[i];
    if (value === undefined) {
        throw new RangeError(`Index ${i} is out of range (length ${list.length}).`);
    }

    return value;
}

// A cell of a 1-based grid of rows.
export function cellAt<T>(rows: ArrayLike<ArrayLike<T>>, x: number, y: number): T {
    return at(at(rows, y - 1), x - 1);
}
