// The terminal: raw keyboard input and drawing the screen.
//
// Keys are delivered as names ("up", "down", "left", "right", "enter",
// "escape", "backspace", "tab", "home", "end", "pageup", "pagedown",
// "delete") or as
// the typed character. If the mouse is turned on (start({ mouse: true })),
// mouse buttons arrive too, as MouseInput events.
import { Screen, WIDTH, HEIGHT } from './screen.ts';

// A key name or a single typed character.
export type Key = string;

// A mouse button pressed, released or dragged, or the wheel turned, at a
// screen cell (1-based, like the rest of the screen).
export interface MouseInput {
    type: 'mouse';
    action: 'press' | 'release' | 'drag' | 'wheel';
    // For "wheel": "up" or "down". For "release" the terminal doesn't say
    // which button, so it's "none".
    button: 'left' | 'middle' | 'right' | 'up' | 'down' | 'none';
    x: number;
    y: number;
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
}

export type InputEvent = Key | MouseInput;

export const isMouse = (event: InputEvent): event is MouseInput => typeof event !== 'string';

interface Waiter {
    deliver(event: InputEvent): void;
    fail(error: Error): void;
}

// What waiting for a key throws once the player has gone (their
// connection closed): whatever was waiting can tidy up and stop.
export class Disconnected extends Error {
    public override name = 'Disconnected';

    public constructor() {
        super('The player has disconnected.');
    }
}

// Turns on reporting of button presses, releases and drags, in SGR form.
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

const BUTTONS = ['left', 'middle', 'right', 'none'] as const;

// An SGR mouse report: ESC [ < button ; x ; y (M = press or drag, m = release).
function parseMouse(code: number, x: number, y: number, final: string): MouseInput {
    const mods = {
        shift: (code & 4) !== 0,
        alt: (code & 8) !== 0,
        ctrl: (code & 16) !== 0,
    };

    if (code & 64) {
        return {
            type: 'mouse',
            action: 'wheel',
            button: (code & 1) === 0 ? 'up' : 'down',
            x,
            y,
            ...mods,
        };
    }

    const button = BUTTONS[code & 3] ?? 'none';
    if (final === 'm') {
        return { type: 'mouse', action: 'release', button: 'none', x, y, ...mods };
    }

    return {
        type: 'mouse',
        action: code & 32 ? 'drag' : 'press',
        button,
        x,
        y,
        ...mods,
    };
}

// The parts of process.stdin / process.stdout the terminal uses.
export interface TerminalInput {
    readonly isTTY?: boolean;
    setRawMode(mode: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface TerminalOutput {
    readonly isTTY?: boolean;
    readonly columns: number;
    readonly rows: number;
    write(data: string): unknown;
    on(event: 'resize', listener: () => void): unknown;
}

// prettier-ignore
const SEQUENCES: readonly (readonly [string, Key])[] = [
    ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
    ['\x1bOA', 'up'], ['\x1bOB', 'down'], ['\x1bOC', 'right'], ['\x1bOD', 'left'],
    ['\x1b[H', 'home'], ['\x1b[F', 'end'], ['\x1bOH', 'home'], ['\x1bOF', 'end'],
    ['\x1b[1~', 'home'], ['\x1b[4~', 'end'], ['\x1b[7~', 'home'], ['\x1b[8~', 'end'],
    ['\x1b[3~', 'delete'], ['\x1b[5~', 'pageup'], ['\x1b[6~', 'pagedown'],
];

export function parseKeys(input: string): InputEvent[] {
    const keys: InputEvent[] = [];

    let i = 0;
    while (i < input.length) {
        // A whole character, even one outside the Basic Multilingual Plane
        // (which takes two UTF-16 units).
        const ch = String.fromCodePoint(input.codePointAt(i) ?? 0);
        if (ch === '\x1b') {
            const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input.slice(i));
            if (mouse) {
                const [all, code = '0', x = '0', y = '0', final = 'M'] = mouse;
                keys.push(parseMouse(Number(code), Number(x), Number(y), final));
                i += all.length;

                continue;
            }

            const seq = SEQUENCES.find(([s]) => input.startsWith(s, i));
            if (seq) {
                keys.push(seq[1]);
                i += seq[0].length;

                continue;
            }

            // Swallow other escape sequences (function keys etc.).
            const other = /^\x1b(\[[0-9;?]*[ -\/]*[@-~]|O.)/.exec(input.slice(i));
            if (other) {
                i += other[0].length;
                continue;
            }

            keys.push('escape');
            i++;

            continue;
        }

        if (ch === '\x03') {
            keys.push('ctrl-c');
        } else if (ch === '\r' || ch === '\n') {
            keys.push('enter');
            if (ch === '\r' && input.charAt(i + 1) === '\n') {
                i++;
            }
        } else if (ch === '\x7f' || ch === '\b') {
            keys.push('backspace');
        } else if (ch === '\t') {
            keys.push('tab');
        } else if (ch >= ' ') {
            keys.push(ch);
        }

        i += ch.length;
    }

    return keys;
}

export class Terminal {
    public readonly screen = new Screen();
    private readonly input: TerminalInput;
    private readonly output: TerminalOutput;
    private readonly queue: InputEvent[] = [];
    private waiters: Waiter[] = [];
    private active = false;
    private mouse = false;
    private gone = false;
    private lastInputAt = Date.now();
    public onInterrupt: () => void = () => {};

    public constructor({ input = process.stdin, output = process.stdout }: { input?: TerminalInput; output?: TerminalOutput } = {}) {
        this.input = input;
        this.output = output;
    }

    // `mouse` turns on mouse reporting (the game doesn't use the mouse; the
    // editor does).
    public start({ mouse = false }: { mouse?: boolean } = {}): void {
        if (!this.input.isTTY || !this.output.isTTY) {
            throw new Error('Final Quest 2 needs an interactive terminal.');
        }

        const { columns, rows } = this.output;
        if (columns < WIDTH || rows < HEIGHT) {
            throw new Error(`Final Quest 2 needs a terminal of at least ${WIDTH}x${HEIGHT} (this one is ${columns}x${rows}).`);
        }

        this.active = true;
        this.input.setRawMode(true);
        this.input.resume();
        this.input.on('data', (chunk: Buffer | string) => {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            for (const key of parseKeys(text)) {
                if (key === 'ctrl-c') {
                    this.onInterrupt();
                } else {
                    this.push(key);
                }
            }
        });

        this.output.on(
            'resize',
            () => {
                this.refresh();
            },
        );

        // Alternate screen, blinking underline cursor like the DOS one.
        this.output.write('\x1b[?1049h\x1b[0m\x1b[2J\x1b[3 q\x1b[?25l');
        this.mouse = mouse;
        if (mouse) {
            this.output.write(MOUSE_ON);
        }
    }

    // Restores the terminal and leaves the last screen visible.
    public stop(): void {
        if (!this.active) {
            return;
        }

        this.active = false;
        this.flush();

        if (this.mouse) {
            this.output.write(MOUSE_OFF);
        }

        this.output.write('\x1b[0m\x1b[0 q\x1b[?25h\x1b[?1049l');

        const last = this.screen.dump();
        if (last) {
            this.output.write(last + '\n');
        }

        this.input.setRawMode(false);
        this.input.pause();
    }

    // Clears the terminal and draws the whole screen again (after a resize,
    // or when something else has scribbled on it).
    public refresh(): void {
        this.output.write('\x1b[0m\x1b[2J');
        this.screen.invalidate();
        this.flush();
    }

    public flush(): void {
        this.output.write(this.screen.render());
    }

    // When the player last pressed a key or used the mouse (anywhere: on the
    // map, in a menu, in a script), for idle timers like the screensaver.
    public get lastInput(): number {
        return this.lastInputAt;
    }

    protected noteInput(): void {
        this.lastInputAt = Date.now();
    }

    public push(event: InputEvent): void {
        this.noteInput();
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter.deliver(event);
            return;
        }

        this.queue.push(event);
    }

    // Next key press, or null after `timeout` milliseconds. Mouse input is
    // skipped.
    public key(): Promise<Key>;
    public key(timeout: number): Promise<Key | null>;
    public async key(timeout = Infinity): Promise<Key | null> {
        const deadline = Date.now() + timeout;
        for (;;) {
            const event = await this.event(timeout === Infinity ? Infinity : deadline - Date.now());
            if (event === null || !isMouse(event)) {
                return event;
            }
        }
    }

    // Next key press or mouse input, or null after `timeout` milliseconds.
    public event(): Promise<InputEvent>;
    public event(timeout: number): Promise<InputEvent | null>;
    public event(timeout = Infinity): Promise<InputEvent | null> {
        if (this.gone) {
            return Promise.reject(new Disconnected());
        }

        this.flush();
        const queued = this.queue.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }

        return new Promise(
            (resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const waiter: Waiter = {
                    deliver: (event) => {
                        clearTimeout(timer);
                        resolve(event);
                    },
                    fail: (error) => {
                        clearTimeout(timer);
                        reject(error);
                    },
                };

                this.waiters.push(waiter);
                if (timeout !== Infinity) {
                    timer = setTimeout(
                        () => {
                            this.waiters = this.waiters.filter((w) => w !== waiter);
                            resolve(null);
                        },
                        Math.max(0, timeout),
                    );
                }
            },
        );
    }

    // The player has gone (their connection closed). Anything waiting for a
    // key, now or later, gets a Disconnected error instead.
    public disconnect(): void {
        if (this.gone) {
            return;
        }

        this.gone = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter.fail(new Disconnected());
        }
    }

    public get disconnected(): boolean {
        return this.gone;
    }

    // Drops keys typed ahead.
    public drain(): void {
        this.queue.length = 0;
    }

    public sleep(seconds: number): Promise<void> {
        this.flush();
        return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
}
