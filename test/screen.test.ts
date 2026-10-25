import { describe, expect, test } from 'bun:test';
import { COLORS, HEIGHT, Screen, WIDTH } from '../../engine/screen.ts';
import { row } from '../helpers.ts';

describe('Screen', () => {
    test('starts blank, light gray on black', () => {
        const screen = new Screen();
        expect(screen.cell(1, 1)).toEqual({ ch: ' ', fg: 7, bg: 0, blink: false });
        expect(screen.cell(WIDTH, HEIGHT)).toEqual({ ch: ' ', fg: 7, bg: 0, blink: false });
        expect(screen.cursor).toBeNull();
    });

    test('put and cell', () => {
        const screen = new Screen();
        screen.put(3, 4, 'x', 14, 1, true);
        expect(screen.cell(3, 4)).toEqual({ ch: 'x', fg: 14, bg: 1, blink: true });
    });

    test('put ignores cells off the screen', () => {
        const screen = new Screen();
        for (const [x, y] of [[0, 1], [1, 0], [WIDTH + 1, 1], [1, HEIGHT + 1]] as const) {
            screen.put(x, y, 'x', 1, 1);
        }
        expect(row(screen, 1)).toBe('');
    });

    test('inside', () => {
        const screen = new Screen();
        expect(screen.inside(1, 1)).toBe(true);
        expect(screen.inside(WIDTH, HEIGHT)).toBe(true);
        expect(screen.inside(0, 1)).toBe(false);
        expect(screen.inside(1, HEIGHT + 1)).toBe(false);
    });

    test('text writes one colour and clips at the right edge', () => {
        const screen = new Screen();
        screen.text(78, 2, 'abcd', 4, 1);
        expect(row(screen, 2)).toBe(' '.repeat(77) + 'abc');
        expect(screen.cell(78, 2)).toEqual({ ch: 'a', fg: 4, bg: 1, blink: false });
    });

    test('fillRow and clear', () => {
        const screen = new Screen();
        screen.text(1, 3, 'hello', 15, 0);
        screen.fillRow(3, 1);
        expect(row(screen, 3)).toBe('');
        expect(screen.cell(5, 3).bg).toBe(1);
        screen.text(1, 3, 'hello', 15, 0);
        screen.clear(2);
        expect(row(screen, 3)).toBe('');
        expect(screen.cell(80, 25).bg).toBe(2);
    });

    describe('render', () => {
        test('sends every cell the first time, then only changes', () => {
            const screen = new Screen();
            const first = screen.render();
            expect(first).toContain('\x1b[1;1H');
            expect(screen.render()).toBe('\x1b[?25l');
            screen.put(5, 2, 'Q', 15, 1);
            const second = screen.render();
            expect(second).toContain('\x1b[2;5H');
            expect(second).toContain('Q');
            expect(second.endsWith('\x1b[0m\x1b[?25l')).toBe(true);
        });

        test('does not move the cursor between neighbouring cells', () => {
            const screen = new Screen();
            screen.render();
            screen.text(1, 1, 'ab', 15, 0);
            const out = screen.render();
            expect(out.match(/\x1b\[\d+;\d+H/g)).toEqual(['\x1b[1;1H']);
        });

        test('uses true colour by default', () => {
            const screen = new Screen();
            screen.render();
            screen.put(1, 1, 'x', 14, 1, true);
            expect(screen.render()).toContain('\x1b[0;5;38;2;255;255;85;48;2;0;0;170m');
        });

        test('invalidate sends everything again', () => {
            const screen = new Screen();
            screen.render();
            screen.invalidate();
            expect(screen.render().length).toBeGreaterThan(WIDTH * HEIGHT);
        });

        test('shows the cursor where asked', () => {
            const screen = new Screen();
            screen.cursor = { x: 7, y: 3 };
            expect(screen.render().endsWith('\x1b[3;7H\x1b[?25h')).toBe(true);
        });
    });

    describe('dump', () => {
        test('is empty for a blank screen', () => {
            expect(new Screen().dump()).toBe('');
        });

        test('keeps rows up to the last drawn one, trimming blank ends', () => {
            const screen = new Screen();
            screen.text(1, 1, 'top', 15, 0);
            screen.text(3, 3, 'end', 15, 0);
            const lines = screen.dump().replace(/\x1b\[[0-9;]*m/g, '').split('\n');
            expect(lines).toHaveLength(3);
            expect(lines[0]).toContain('top');
            expect(lines[1]).toBe('');
            expect(lines[2]).toBe('  end');
            expect(screen.dump().endsWith('end\x1b[0m')).toBe(true);
        });

        test('keeps blank cells with a background', () => {
            const screen = new Screen();
            screen.put(10, 1, ' ', 7, 4);
            expect(screen.dump()).toContain('48;2;170;0;0m');
        });
    });

    test('COLORS has the 16 CGA colours in order', () => {
        expect(COLORS).toHaveLength(16);
        expect(COLORS[0]).toBe('black');
        expect(COLORS[14]).toBe('yellow');
        expect(COLORS[15]).toBe('white');
    });
});

describe('fixes from the code review', () => {
    test('putting what is already there changes nothing to send', () => {
        const screen = new Screen();
        screen.put(1, 1, 'a', 3, 4);
        screen.render();
        screen.put(1, 1, 'a', 3, 4);
        expect(screen.render()).toBe('\x1b[?25l');
    });

    test('a cell changed and changed back is not sent again', () => {
        const screen = new Screen();
        screen.render();
        screen.put(1, 1, 'a', 3, 4);
        screen.put(1, 1, ' ', 7, 0);
        expect(screen.render()).toBe('\x1b[?25l');
    });
});
