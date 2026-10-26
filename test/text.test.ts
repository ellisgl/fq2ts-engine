import { describe, expect, test } from 'bun:test';
import { draw, escapeMarkup, parse, strip, width } from '../src/text.ts';
import { Screen } from '../src/screen.ts';
import { row } from '../src/testing.ts';

describe('parse', () => {
    test('plain text', () => {
        expect(parse('hello')).toEqual([{ type: 'text', text: 'hello' }]);
        expect(parse('')).toEqual([]);
    });

    test('tags', () => {
        expect(parse('{yellow}a{blink red}b{on blue}c{x 5}{y 6}{sp 2}{center}')).toEqual([
            { type: 'fg', color: 14, blink: false },
            { type: 'text', text: 'a' },
            { type: 'fg', color: 4, blink: true },
            { type: 'text', text: 'b' },
            { type: 'bg', color: 1 },
            { type: 'text', text: 'c' },
            { type: 'x', n: 5 },
            { type: 'y', n: 6 },
            { type: 'sp', n: 2 },
            { type: 'center' },
        ]);
    });

    test('{{ is a literal brace', () => {
        expect(strip('a{{b')).toBe('a{b');
    });

    test('colours by number, 0 to 255, and any background', () => {
        expect(parse('{color 208}{blink 16}{on 255}{on yellow}{color 7}')).toEqual([
            { type: 'fg', color: 208, blink: false },
            { type: 'fg', color: 16, blink: true },
            { type: 'bg', color: 255 },
            { type: 'bg', color: 14 },
            { type: 'fg', color: 7, blink: false },
        ]);
    });

    test.each(['{nope}', '{on 256}', '{color 1000}', '{color}', '{color nope}', '{blink nope}', '{x a}', '{center 3}', '{yellow 3}'])('%s is left as text', (tag) => {
        expect(strip(tag)).toBe(tag);
    });
});

describe('width and strip', () => {
    test('count only visible cells', () => {
        expect(width('{red}ab{sp 3}c')).toBe(6);
        expect(width('☺☻')).toBe(2);
        expect(strip('{red}ab{sp 3}c{x 4}')).toBe('ab   c');
    });
});

describe('draw', () => {
    test('draws in white from the top left by default', () => {
        const screen = new Screen();
        const end = draw(screen, 'hi');
        expect(row(screen, 1)).toBe('hi');
        expect(screen.cell(1, 1).fg).toBe(15);
        expect(end).toEqual({ x: 3, y: 1 });
    });

    test('keeps the background already on screen unless told otherwise', () => {
        const screen = new Screen();
        screen.fillRow(2, 4);
        draw(screen, 'a{on blue}b', { y: 2 });
        expect(screen.cell(1, 2).bg).toBe(4);
        expect(screen.cell(2, 2).bg).toBe(1);
    });

    test('options set the start and colours', () => {
        const screen = new Screen();
        draw(screen, 'x', { x: 10, y: 5, fg: 3, bg: 2 });
        expect(screen.cell(10, 5)).toEqual({ ch: 'x', fg: 3, bg: 2, blink: false });
    });

    test('colour tags and blinking', () => {
        const screen = new Screen();
        draw(screen, '{blink red}a{green}b');
        expect(screen.cell(1, 1)).toMatchObject({ fg: 4, blink: true });
        expect(screen.cell(2, 1)).toMatchObject({ fg: 2, blink: false });
    });

    test('{x} {y} and {sp}', () => {
        const screen = new Screen();
        draw(screen, '{y 3}{x 5}a{sp 2}b{x 0}c');
        expect(row(screen, 3)).toBe('c   a  b');
    });

    test('{center} centres the whole line', () => {
        const screen = new Screen();
        draw(screen, '{center}abcd');
        expect(row(screen, 1)).toBe(' '.repeat(38) + 'abcd');
    });

    test('wraps at the right edge', () => {
        const screen = new Screen();
        const end = draw(screen, '{x 79}abc');
        expect(screen.cell(79, 1).ch).toBe('a');
        expect(screen.cell(80, 1).ch).toBe('b');
        expect(screen.cell(1, 2).ch).toBe('c');
        expect(end).toEqual({ x: 2, y: 2 });
    });

    test('stops at the bottom of the screen', () => {
        const screen = new Screen();
        draw(screen, '{y 25}{x 80}ab');
        expect(screen.cell(80, 25).ch).toBe('a');
        expect(row(screen, 1)).toBe('');
    });
});

describe('fixes from the code review', () => {
    test('a centred line too wide for the screen starts at the left edge', () => {
        const screen = new Screen();
        draw(screen, `{center}${'abcdefghij'.repeat(9)}`);
        expect(row(screen, 1)).toBe('abcdefghij'.repeat(8));
        expect(row(screen, 2)).toBe('abcdefghij');
    });

    test('wrap: false cuts text at the right edge', () => {
        const screen = new Screen();
        const end = draw(screen, '{x 79}abc', { wrap: false });
        expect(row(screen, 1)).toBe(' '.repeat(78) + 'ab');
        expect(row(screen, 2)).toBe('');
        expect(end.y).toBe(1);
    });
});

test('escapeMarkup makes text show its braces as they are', () => {
    const screen = new Screen();
    draw(screen, `{green}${escapeMarkup('{red}Bob {{x}}')}`);
    expect(row(screen, 1)).toBe('{red}Bob {{x}}');
    expect(screen.cell(1, 1).fg).toBe(2);
});

test('markup is drawn one character per cell, with "?" for what can\'t fill one', () => {
    const screen = new Screen();
    const end = draw(screen, '{red}Ж😀{green}é!');
    expect(row(screen, 1)).toBe('Ж?é!');
    expect(end.x).toBe(5);
    expect(width('Ж😀é!')).toBe(4);
});
