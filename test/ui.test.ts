import { describe, expect, test } from 'bun:test';
import { askText, choose, prompt, statusBar, textInput, scrollText } from '../../engine/ui.ts';
import { Screen } from '../../engine/screen.ts';
import { FakeTerminal, mouse, row, typed, type Step } from '../helpers.ts';
import type { Key } from '../../engine/terminal.ts';

test('statusBar draws shaded ends and centred white-on-blue text', () => {
    const screen = new Screen();
    statusBar(screen, 'Hello {yellow}there');
    const line = row(screen, 23);
    expect(line.startsWith('░▒')).toBe(true);
    expect(line.endsWith('▒░')).toBe(true);
    expect(line).toContain('Hello there');
    expect(screen.cell(40, 23).bg).toBe(1);
    expect(screen.cell(1, 23)).toMatchObject({ fg: 1, bg: 0 });
    const yellow = line.indexOf('there') + 1;
    expect(screen.cell(yellow, 23).fg).toBe(14);
});

describe('choose', () => {
    const options = ['One', '{red}Two', 'Three'];

    test('Enter picks the highlighted option', async () => {
        const term = new FakeTerminal(['enter']);
        expect(await choose(term, options, { y: 5 })).toBe(0);
        expect(row(term.screen, 6)).toBe('Two');
        expect(term.screen.cell(1, 5).bg).toBe(1);
        expect(term.screen.cell(1, 6).bg).toBe(0);
        expect(term.screen.cursor).toBeNull();
    });

    test('arrows move and wrap around', async () => {
        expect(await choose(new FakeTerminal(['down', 'enter']), options, { y: 1 })).toBe(1);
        expect(await choose(new FakeTerminal(['right', 'right', 'enter']), options, { y: 1 })).toBe(2);
        expect(await choose(new FakeTerminal(['up', 'enter']), options, { y: 1 })).toBe(2);
        expect(await choose(new FakeTerminal(['down', 'down', 'down', 'left', 'enter']), options, { y: 1 })).toBe(2);
        expect(await choose(new FakeTerminal(['x', 'enter']), options, { y: 1 })).toBe(0);
    });

    test('clicking an option picks it', async () => {
        expect(await choose(new FakeTerminal([mouse(3, 6)]), options, { y: 5 })).toBe(1);
        expect(await choose(new FakeTerminal([mouse(12, 4)]), options, { y: 2, x: 10 })).toBe(2);
    });

    test('clicks beside the options, other buttons and releases are ignored', async () => {
        const steps = [mouse(4, 5), mouse(1, 4), mouse(1, 8), mouse(9, 5), mouse(1, 6, { button: 'right' }), mouse(1, 6, { action: 'release', button: 'none' }), 'enter'];
        expect(await choose(new FakeTerminal(steps), options, { y: 5, x: 2 })).toBe(0);
    });

    test('the wheel moves the highlight', async () => {
        expect(await choose(new FakeTerminal([mouse(1, 1, { action: 'wheel', button: 'down' }), 'enter']), options, { y: 1 })).toBe(1);
        expect(await choose(new FakeTerminal([mouse(1, 1, { action: 'wheel', button: 'up' }), 'enter']), options, { y: 1 })).toBe(2);
    });

    test('Escape gives -1', async () => {
        expect(await choose(new FakeTerminal(['escape']), options, { y: 1 })).toBe(-1);
    });

    test('x and selected set the column and starting option', async () => {
        const term = new FakeTerminal(['enter']);
        expect(await choose(term, options, { y: 2, x: 10, selected: 2 })).toBe(2);
        expect(row(term.screen, 4)).toBe(' '.repeat(9) + 'Three');
    });

    test("the cursor sits after the highlighted option's text", async () => {
        const term = new FakeTerminal([
            () => {
                expect(term.screen.cursor).toEqual({ x: 4, y: 3 });
                return 'down';
            },
            () => {
                expect(term.screen.cursor).toEqual({ x: 4, y: 4 });
                return 'enter';
            },
        ]);
        await choose(term, options, { y: 3 });
    });
});

describe('textInput', () => {
    test('typing and Enter', async () => {
        const term = new FakeTerminal(typed('abc'));
        expect(await textInput(term, { x: 1, y: 1, length: 10 })).toBe('abc');
        expect(term.screen.cursor).toBeNull();
    });

    test('Escape also finishes', async () => {
        expect(await textInput(new FakeTerminal(['a', 'escape']), { x: 1, y: 1, length: 10 })).toBe('a');
    });

    test('Backspace deletes, and does nothing when empty', async () => {
        const term = new FakeTerminal(['backspace', 'a', 'b', 'backspace', 'c', 'enter']);
        expect(await textInput(term, { x: 1, y: 1, length: 10 })).toBe('ac');
    });

    test('length includes the cursor cell', async () => {
        expect(await textInput(new FakeTerminal(typed('abcdef')), { x: 1, y: 1, length: 4 })).toBe('abc');
    });

    test('named keys and filtered characters are ignored', async () => {
        const term = new FakeTerminal(['up', '1', 'a', '2', 'enter']);
        const digits = (ch: string): boolean => /\d/.test(ch);
        expect(await textInput(term, { x: 1, y: 1, length: 10, filter: digits })).toBe('12');
    });

    test('starts from a value and draws in the given colours', async () => {
        const term = new FakeTerminal(['!', 'enter']);
        expect(await textInput(term, { x: 5, y: 2, length: 8, value: 'hi', fg: 3, bg: 4 })).toBe('hi!');
        expect(row(term.screen, 2)).toBe('    hi!');
        expect(term.screen.cell(5, 2)).toMatchObject({ fg: 3, bg: 4 });
        expect(term.screen.cell(12, 2).bg).toBe(4);
    });

    test('the cursor follows the text but stays on screen', async () => {
        const term = new FakeTerminal([
            () => {
                expect(term.screen.cursor).toEqual({ x: 80, y: 1 });
                return 'enter';
            },
        ]);
        await textInput(term, { x: 78, y: 1, length: 5, value: 'abcd' });
    });
});

test('prompt shows a label and returns the trimmed answer', async () => {
    const term = new FakeTerminal(typed('  yes '));
    expect(await prompt(term, 3, 'Sure? ')).toBe('yes');
    expect(row(term.screen, 3).startsWith('Sure?   yes')).toBe(true);
});

describe('scrollText', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const top = (term: FakeTerminal): string => row(term.screen, 3).trim();

    test('shows a page with a title and where it is', async () => {
        const term = new FakeTerminal([
            () => {
                expect(row(term.screen, 1).trim()).toBe('Title');
                expect(top(term)).toBe('line 1');
                expect(row(term.screen, 23).trim()).toBe('line 21');
                expect(row(term.screen, 25)).toEndWith('1-21 of 50');
                return 'enter';
            },
        ]);
        await scrollText(term, lines, { title: 'Title' });
    });

    test('keys and the wheel scroll, and stop at the ends', async () => {
        const at = (term: FakeTerminal, expected: string, key: Key): Step => () => {
            expect(top(term)).toBe(expected);
            return key;
        };
        const term = new FakeTerminal();
        term.feed(
            'up',
            at(term, 'line 1', 'down'),
            at(term, 'line 2', 'pagedown'),
            at(term, 'line 23', ' '),
            at(term, 'line 30', 'pageup'),
            at(term, 'line 9', 'end'),
            at(term, 'line 30', 'home'),
            at(term, 'line 1', 'x'),
            mouse(1, 1, { action: 'wheel', button: 'down' }),
            at(term, 'line 4', 'z'),
            mouse(1, 1, { action: 'wheel', button: 'up' }),
            mouse(1, 1),
            at(term, 'line 1', 'q'),
        );
        await scrollText(term, lines);
    });

    test('can start at the bottom, and says when there is nothing', async () => {
        const term = new FakeTerminal([
            () => {
                expect(top(term)).toBe('line 30');
                return 'escape';
            },
        ]);
        await scrollText(term, lines, { from: 'bottom' });
        const empty = new FakeTerminal([
            () => {
                expect(row(empty.screen, 25)).toEndWith('empty');
                return 'escape';
            },
        ]);
        await scrollText(empty, []);
    });
});

test('choose with no options is -1, without waiting for a key', async () => {
    expect(await choose(new FakeTerminal(), [], { y: 1 })).toBe(-1);
});

test('the status bar cuts off a message too long for it, keeping its ends', () => {
    const screen = new Screen();
    screen.put(1, 24, 'z', 7, 0);
    statusBar(screen, 'x'.repeat(120));
    expect(row(screen, 23)).toBe('░▒' + 'x'.repeat(75) + '▒░');
    expect(row(screen, 24)).toBe('z');
});

describe('askText and masks', () => {
    test('askText gives the text on Enter and null on Escape', async () => {
        expect(await askText(new FakeTerminal(typed('hi')), { x: 1, y: 1, length: 10 })).toBe('hi');
        expect(await askText(new FakeTerminal(['h', 'escape']), { x: 1, y: 1, length: 10 })).toBeNull();
    });

    test('a mask hides what is typed', async () => {
        const term = new FakeTerminal([
            ...'abc',
            () => {
                expect(row(term.screen, 1)).toBe('***');
                return 'enter';
            },
        ]);
        expect(await textInput(term, { x: 1, y: 1, length: 10, mask: '*', bg: 0 })).toBe('abc');
    });
});

test('choose can take its colours', async () => {
    const term = new FakeTerminal([
        () => {
            expect(term.screen.cell(1, 1)).toMatchObject({ fg: 11, bg: 1 });
            expect(term.screen.cell(1, 2)).toMatchObject({ fg: 9, bg: 1 });
            return 'enter';
        },
    ]);
    await choose(term, ['One', 'Two'], { y: 1, colors: { normal: [9, 1], selected: [11, 1] } });
});
