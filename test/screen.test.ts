import { describe, expect, test } from 'bun:test';
import { COLORS, HEIGHT, Screen, WIDTH, colorDepth, rgb } from '../src/screen.ts';
import { row } from '../src/testing.ts';

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

        test('256 colours: the CGA colours as the nearest of xterm\'s fixed ones', () => {
            const screen = new Screen('256');
            screen.render();
            // Yellow (255,255,85) is 227; CGA's brown (170,85,0) is 130, not
            // the terminal's own "yellow".
            screen.put(1, 1, 'x', 14, 6);
            screen.put(2, 1, 'y', 208, 232);
            const out = screen.render();
            expect(out).toContain('\x1b[0;38;5;227;48;5;130mx');
            expect(out).toContain('\x1b[0;38;5;208;48;5;232my');
        });

        test('16 colours: the rest as the nearest of the 16, bright backgrounds too', () => {
            const screen = new Screen('16');
            screen.render();
            screen.put(1, 1, 'x', 14, 1, true);
            // 203 (255,95,95) is nearest light red (12), and 63 (95,95,255)
            // light blue (9); 196, pure red, is nearer red (4) than light red.
            screen.put(2, 1, 'y', 203, 63);
            screen.put(3, 1, 'z', 196, 0);
            const out = screen.render();
            expect(out).toContain('\x1b[0;5;93;44mx');
            expect(out).toContain('\x1b[0;91;104my');
            expect(out).toContain('\x1b[0;31;40mz');
        });

        test('true colour draws any of the 256 exactly', () => {
            const screen = new Screen('true');
            screen.render();
            screen.put(1, 1, 'x', 208, 244);
            expect(screen.render()).toContain('\x1b[0;38;2;255;135;0;48;2;128;128;128mx');
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

describe('Unicode on the screen', () => {
    test('put shows a "?" for anything that can\'t fill a cell', () => {
        const screen = new Screen();
        screen.put(1, 1, '😀', 15, 0);
        screen.put(2, 1, 'ж', 15, 0);
        expect([screen.cell(1, 1).ch, screen.cell(2, 1).ch]).toEqual(['?', 'ж']);
    });

    test('text puts one character per cell, accents and all', () => {
        const screen = new Screen();
        screen.text(1, 1, 'Café 中 ☃', 15, 0);
        expect(row(screen, 1)).toBe('Café ? ☃');
        expect(screen.cell(6, 1).ch).toBe('?');
    });
});

describe('colours', () => {
    test('rgb: the CGA 16, then the cube, then the greys', () => {
        expect(rgb(6)).toEqual([170, 85, 0]);
        expect(rgb(16)).toEqual([0, 0, 0]);
        expect(rgb(208)).toEqual([255, 135, 0]);
        expect(rgb(231)).toEqual([255, 255, 255]);
        expect(rgb(232)).toEqual([8, 8, 8]);
        expect(rgb(255)).toEqual([238, 238, 238]);
    });

    test.each([
        [{ FQ2_COLORS: '16', COLORTERM: 'truecolor' }, '16'],
        [{ FQ2_COLORS: '256' }, '256'],
        [{ FQ2_COLORS: 'nonsense', COLORTERM: 'truecolor', TERM: 'xterm' }, 'true'],
        [{ COLORTERM: '24bit', TERM: 'xterm-256color' }, 'true'],
        [{ TERM: 'xterm-256color' }, '256'],
        [{ TERM: 'linux' }, '16'],
        [{}, 'true'],
    ] as const)('colorDepth(%p) is %p', (env, depth) => {
        expect(colorDepth(env)).toBe(depth);
    });
});
