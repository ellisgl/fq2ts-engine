import { describe, expect, test } from 'bun:test';
import { InvalidData, array, boolean, field, integer, number, oneOf, record, string } from '../src/validate.ts';

describe('record', () => {
    test('accepts plain objects', () => {
        expect(record({ a: 1 }, 'x')).toEqual({ a: 1 });
        expect(record({}, 'x')).toEqual({});
    });

    test.each([[null], [[]], ['text'], [3], [true], [undefined]])('rejects %p', (value: unknown) => {
        expect(() => record(value, 'thing')).toThrow('thing: expected an object');
    });
});

describe('primitives', () => {
    test('string', () => {
        expect(string('hi', 'p')).toBe('hi');
        expect(string('', 'p')).toBe('');
        expect(() => string(1, 'p')).toThrow('p: expected a string');
    });

    test('number', () => {
        expect(number(1.5, 'p')).toBe(1.5);
        expect(number(-3, 'p')).toBe(-3);
        expect(() => number('1', 'p')).toThrow('p: expected a number');
        expect(() => number(NaN, 'p')).toThrow(InvalidData);
        expect(() => number(Infinity, 'p')).toThrow(InvalidData);
    });

    test('integer', () => {
        expect(integer(7, 'p')).toBe(7);
        expect(() => integer(7.5, 'p')).toThrow('p: expected a whole number');
        expect(() => integer('7', 'p')).toThrow('p: expected a whole number');
    });

    test('boolean', () => {
        expect(boolean(false, 'p')).toBe(false);
        expect(() => boolean(0, 'p')).toThrow('p: expected true or false');
    });
});

describe('array', () => {
    test('reads every item', () => {
        expect(array([1, 2], 'list', number)).toEqual([1, 2]);
        expect(array([], 'list', number)).toEqual([]);
    });

    test('names the bad item', () => {
        expect(() => array([1, 'two'], 'list', number)).toThrow('list[1]: expected a number');
    });

    test('rejects anything else', () => {
        expect(() => array({ 0: 1 }, 'list', number)).toThrow('list: expected a list');
    });
});

describe('oneOf', () => {
    const size = oneOf(['small', 'large']);

    test('accepts the listed values', () => {
        expect(size('small', 'p')).toBe('small');
    });

    test('rejects others', () => {
        expect(() => size('medium', 'p')).toThrow('p: expected one of small, large');
    });
});

describe('field', () => {
    const obj = { a: 1, b: 'x' };

    test('reads a field and names it in errors', () => {
        expect(field(obj, 'a', 'obj', number)).toBe(1);
        expect(() => field(obj, 'b', 'obj', number)).toThrow('obj.b: expected a number');
    });

    test('a missing field uses the fallback', () => {
        expect(field(obj, 'c', 'obj', number, 9)).toBe(9);
    });

    test('a present field ignores the fallback', () => {
        expect(field(obj, 'a', 'obj', number, 9)).toBe(1);
        expect(() => field(obj, 'b', 'obj', number, 9)).toThrow('obj.b: expected a number');
    });

    test('a missing field without a fallback is an error', () => {
        expect(() => field(obj, 'c', 'obj', number)).toThrow('obj.c: expected a number');
    });
});

test('InvalidData is an Error with its own name', () => {
    const err = new InvalidData('bad');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidData');
});
