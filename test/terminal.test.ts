import { describe, expect, test } from 'bun:test';
import { Disconnected, Terminal, isMouse, parseKeys } from '../../engine/terminal.ts';
import { caught, FakeInput, FakeOutput, mouse } from '../helpers.ts';

describe('parseKeys', () => {
    test.each([
        ['\x1b[A\x1b[B\x1b[C\x1b[D', ['up', 'down', 'right', 'left']],
        ['\x1bOA\x1bOB\x1bOC\x1bOD', ['up', 'down', 'right', 'left']],
        ['\x1b[H\x1b[F\x1bOH\x1bOF', ['home', 'end', 'home', 'end']],
        ['\x1b[1~\x1b[4~\x1b[7~\x1b[8~', ['home', 'end', 'home', 'end']],
        ['\x1b[3~\x1b[5~\x1b[6~', ['delete', 'pageup', 'pagedown']],
    ])('escape sequences %#', (input, keys) => {
        expect(parseKeys(input)).toEqual(keys);
    });

    test('a lone escape is the Escape key', () => {
        expect(parseKeys('\x1b')).toEqual(['escape']);
        expect(parseKeys('\x1b\x1b')).toEqual(['escape', 'escape']);
    });

    test('other escape sequences are swallowed', () => {
        expect(parseKeys('\x1b[15~a\x1bOPb')).toEqual(['a', 'b']);
    });

    test('Enter in all its forms', () => {
        expect(parseKeys('\r')).toEqual(['enter']);
        expect(parseKeys('\n')).toEqual(['enter']);
        expect(parseKeys('\r\n')).toEqual(['enter']);
        expect(parseKeys('\n\r')).toEqual(['enter', 'enter']);
    });

    test('Backspace, Ctrl-C and other control characters', () => {
        expect(parseKeys('\x7f\b')).toEqual(['backspace', 'backspace']);
        expect(parseKeys('\x03')).toEqual(['ctrl-c']);
        expect(parseKeys('\x01\x02')).toEqual([]);
        expect(parseKeys('\t')).toEqual(['tab']);
    });

    test('mouse presses, drags and releases', () => {
        expect(parseKeys('\x1b[<0;10;5M')).toEqual([mouse(10, 5)]);
        expect(parseKeys('\x1b[<1;1;2M\x1b[<2;3;4M')).toEqual([mouse(1, 2, { button: 'middle' }), mouse(3, 4, { button: 'right' })]);
        expect(parseKeys('\x1b[<32;11;5M')).toEqual([mouse(11, 5, { action: 'drag' })]);
        expect(parseKeys('\x1b[<0;11;5m')).toEqual([mouse(11, 5, { action: 'release', button: 'none' })]);
        expect(parseKeys('\x1b[<3;11;5M')).toEqual([mouse(11, 5, { button: 'none' })]);
    });

    test('the mouse wheel and modifier keys', () => {
        expect(parseKeys('\x1b[<64;7;8M\x1b[<65;7;8M')).toEqual([mouse(7, 8, { action: 'wheel', button: 'up' }), mouse(7, 8, { action: 'wheel', button: 'down' })]);
        expect(parseKeys('\x1b[<28;1;1M')).toEqual([mouse(1, 1, { shift: true, alt: true, ctrl: true })]);
    });

    test('mouse input mixed with keys', () => {
        expect(parseKeys('a\x1b[<0;2;3Mb\x1b[A')).toEqual(['a', mouse(2, 3), 'b', 'up']);
    });

    test('characters outside the Basic Multilingual Plane are one key', () => {
        expect(parseKeys('a😀b')).toEqual(['a', '😀', 'b']);
    });

    test('typed characters', () => {
        expect(parseKeys('aZ 1☺')).toEqual(['a', 'Z', ' ', '1', '☺']);
    });
});

function setup(): { term: Terminal; input: FakeInput; output: FakeOutput } {
    const input = new FakeInput();
    const output = new FakeOutput();
    return { term: new Terminal({ input, output }), input, output };
}

describe('Terminal', () => {
    test("defaults to the process's own streams", () => {
        expect(new Terminal().screen).toBeDefined();
    });

    test('start needs a TTY', () => {
        const { term, input } = setup();
        input.isTTY = false;
        expect(() => {
            term.start();
        }).toThrow('needs an interactive terminal');
    });

    test('start needs 80x25', () => {
        const { term, output } = setup();
        output.rows = 24;
        expect(() => {
            term.start();
        }).toThrow('at least 80x25 (this one is 80x24)');
    });

    test('start takes over the terminal and stop gives it back', () => {
        const { term, input, output } = setup();
        term.start();
        expect(input.rawMode).toBe(true);
        expect(input.paused).toBe(false);
        expect(output.written).toContain('\x1b[?1049h');

        term.screen.text(1, 1, 'bye', 15, 0);
        term.stop();
        expect(input.rawMode).toBe(false);
        expect(input.paused).toBe(true);
        expect(output.written).toContain('\x1b[?1049l');
        expect(output.written.endsWith('\x1b[0m\n')).toBe(true);
        expect(output.written).toContain('bye');

        const length = output.written.length;
        term.stop();
        expect(output.written.length).toBe(length);
    });

    test('stop prints nothing after a blank screen', () => {
        const { term, output } = setup();
        term.start();
        term.stop();
        expect(output.written.endsWith('\x1b[?1049l')).toBe(true);
    });

    test('typed keys arrive through key()', async () => {
        const { term, input } = setup();
        term.start();
        input.emit('data', Buffer.from('a\x1b[A'));
        input.emit('data', '\r');
        expect(await term.key()).toBe('a');
        expect(await term.key()).toBe('up');
        expect(await term.key()).toBe('enter');
    });

    test('key() waits for the next key', async () => {
        const { term, input } = setup();
        term.start();
        const next = term.key();
        input.emit('data', 'x');
        expect(await next).toBe('x');
    });

    test('Ctrl-C calls onInterrupt instead of queueing a key', async () => {
        const { term, input } = setup();
        let interrupted = 0;
        term.onInterrupt = () => {
            interrupted++;
        };
        term.start();
        input.emit('data', '\x03z');
        expect(interrupted).toBe(1);
        expect(await term.key()).toBe('z');
    });

    test('the default onInterrupt does nothing', () => {
        const { term } = setup();
        expect(() => {
            term.onInterrupt();
        }).not.toThrow();
    });

    test('key(timeout) gives null when nothing is pressed', async () => {
        const { term } = setup();
        expect(await term.key(5)).toBeNull();
        expect(await term.key(-10)).toBeNull();
    });

    test("a timed-out wait doesn't take a later key", async () => {
        const { term } = setup();
        await term.key(1);
        term.push('k');
        expect(await term.key()).toBe('k');
    });

    test('key(timeout) still returns a key pressed in time', async () => {
        const { term } = setup();
        const next = term.key(1000);
        term.push('q');
        expect(await next).toBe('q');
    });

    test('key() flushes the screen first', async () => {
        const { term, output } = setup();
        term.screen.text(1, 1, 'shown', 15, 0);
        term.push('x');
        await term.key();
        expect(output.written).toContain('shown');
    });

    test('key() skips mouse input; event() returns it', async () => {
        const { term, input } = setup();
        term.start();
        input.emit('data', '\x1b[<0;2;3Mx\x1b[<0;4;5M');
        expect(await term.key()).toBe('x');
        const event = await term.event();
        expect(isMouse(event) && event.x).toBe(4);
        expect(isMouse('x')).toBe(false);
    });

    test('key(timeout) skips mouse input and still times out', async () => {
        const { term } = setup();
        term.push(mouse(1, 1));
        expect(await term.key(5)).toBeNull();
    });

    test('the mouse is only turned on when asked for', () => {
        const plain = setup();
        plain.term.start();
        plain.term.stop();
        expect(plain.output.written).not.toContain('\x1b[?1000h');

        const { term, output } = setup();
        term.start({ mouse: true });
        expect(output.written).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
        term.stop();
        expect(output.written).toContain('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    });

    test('drain drops keys typed ahead', async () => {
        const { term } = setup();
        term.push('a');
        term.push('b');
        term.drain();
        expect(await term.key(1)).toBeNull();
    });

    test('resizing redraws everything', () => {
        const { term, output } = setup();
        term.start();
        term.flush();
        output.written = '';
        output.emit('resize');
        expect(output.written.startsWith('\x1b[0m\x1b[2J')).toBe(true);
        expect(output.written.length).toBeGreaterThan(2000);
    });

    test('sleep waits and flushes', async () => {
        const { term, output } = setup();
        term.screen.text(1, 1, 'zz', 15, 0);
        const before = Date.now();
        await term.sleep(0.02);
        expect(Date.now() - before).toBeGreaterThanOrEqual(15);
        expect(output.written).toContain('zz');
    });
});

test('refresh clears the terminal and sends the whole screen again', () => {
    const { term, output } = setup();
    term.flush();
    output.written = '';
    term.refresh();
    expect(output.written.startsWith('\x1b[0m\x1b[2J')).toBe(true);
    expect(output.written.length).toBeGreaterThan(2000);
});

describe('disconnecting', () => {
    test('waiting for a key fails with Disconnected, now and later', async () => {
        const { term } = setup();
        const waiting = term.key();
        term.disconnect();
        expect(await caught(waiting)).toBeInstanceOf(Disconnected);
        expect(await caught(term.key())).toEqual(new Disconnected());
        expect(term.disconnected).toBe(true);
        term.disconnect();
    });

    test('a timed wait fails too', async () => {
        const { term } = setup();
        const waiting = term.event(10_000);
        term.disconnect();
        expect(await caught(waiting)).toBeInstanceOf(Disconnected);
    });
});
