import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { JOB_FLAGS, JobBoard, OFFERS_PER_DAY, type JobFlags } from '../src/jobs.ts';
import { content, makeGameWith, start, type TestFlags, type TestWorld } from '../src/fixture.ts';
import type { Content } from '../src/game.ts';
import type { Player } from '../src/player.ts';
import { ScriptContext } from '../src/script.ts';
import { pick, screenText, type Step } from '../src/testing.ts';

type Flags = TestFlags & JobFlags;

// Test Quest, with jobs in its players' flags.
const jobContent: Content<Flags, TestWorld> = { ...content, start: { ...start, flags: { ...start.flags, ...JOB_FLAGS } } };

const GIVERS = [
    { id: 'baker', name: 'the baker', town: 'Bunton' },
    { id: 'smith', name: 'the smith', town: 'Anvil' },
];

let random: Mock<() => number> | null = null;
afterEach(() => {
    random?.mockRestore();
    random = null;
});

// A board on a day the test moves, and a player in Test Quest.
function setUp(steps: readonly Step[], flags: Partial<Flags> = {}, player: Partial<Player<Flags>> = {}) {
    let day = '2026-10-28';
    const jobs = new JobBoard<Flags, TestWorld>({ givers: GIVERS, items: ['sack'], today: () => day });
    const news: string[] = [];
    const { game, term } = makeGameWith(jobContent, {
        steps,
        player: { ...structuredClone(jobContent.start), name: 'Hero', ...player, flags: { ...jobContent.start.flags, ...flags } },
        news: (text) => news.push(text),
    });
    const g = new ScriptContext(game);
    return { jobs, g, term, news, nextDay: () => (day = '2026-10-29') };
}

describe('jobs', () => {
    test('asking for work: a delivery to someone else, for $40-$100, taken on', async () => {
        // (The lowest pay, and the first of the others.)
        random = spyOn(Math, 'random').mockReturnValue(0);
        const { jobs, g, term } = setUp([
            () => {
                expect(screenText(term.screen)).toContain("I've a sack that needs taking to the smith in Anvil. There's $40 in it");
                return 'enter';
            },
            'x',
        ]);
        await jobs.talk(g, 'baker');
        expect(term.remaining).toBe(0);
        expect(g.flags).toMatchObject({ jobFor: 'smith', jobFrom: 'baker', jobItem: 'sack', jobPay: 40, jobDay: '2026-10-28', jobOffers: OFFERS_PER_DAY - 1 });
        expect(jobs.job(g)).toMatchObject({ to: { id: 'smith' }, from: { id: 'baker' }, item: 'sack', pay: 40 });
    });

    test('pay goes up $2 a job done, and by $100 at most; the most is $100 more', async () => {
        random = spyOn(Math, 'random').mockReturnValue(0.9999);
        const few = setUp(['enter', 'x'], { jobsDone: 3 });
        await few.jobs.talk(few.g, 'baker');
        expect(few.g.flags.jobPay).toBe(106);
        const many = setUp(['enter', 'x'], { jobsDone: 500 });
        await many.jobs.talk(many.g, 'baker');
        expect(many.g.flags.jobPay).toBe(200);
    });

    test('turning a job down uses up an offer; there are only so many a day', async () => {
        const { jobs, g, term, nextDay } = setUp([...pick(1), 'x', 'x', ...pick(1), 'x']);
        await jobs.talk(g, 'baker');
        expect(g.flags).toMatchObject({ jobFor: '', jobOffers: OFFERS_PER_DAY - 1 });
        g.flags.jobOffers = 0;
        await jobs.talk(g, 'baker');
        expect(screenText(term.screen)).toContain("I've nothing for you today. Come back tomorrow.");
        // A new day, new offers.
        nextDay();
        await jobs.talk(g, 'baker');
        expect(g.flags.jobOffers).toBe(OFFERS_PER_DAY - 1);
        expect(term.remaining).toBe(0);
    });

    test('delivering: paid, counted, in the news, and the job is done', async () => {
        const job = { jobFor: 'smith', jobFrom: 'baker', jobItem: 'sack', jobPay: 50, jobDay: '2026-10-01' };
        const { jobs, g, term, news } = setUp(['x'], job, { gold: 5 });
        expect(jobs.label(g, 'smith')).toBe('Hand over the sack...');
        await jobs.talk(g, 'smith');
        expect(term.remaining).toBe(0);
        expect(screenText(term.screen)).toContain('My sack! I\'ve been waiting for this.');
        expect(g.gold).toBe(55);
        expect(g.flags).toMatchObject({ jobFor: '', jobFrom: '', jobsDone: 1 });
        expect(news).toEqual(['{lightgreen}Hero made a delivery to the smith in Anvil.']);
    });

    test.each([
        [0, 'maxHp', 103],
        [0.3, 'strength', 11],
        [0.6, 'defense', 11],
        [0.9, 'gold', 50 + 25],
    ] as const)('delivering the same day it was taken gives a bonus (random %p: %s)', async (roll, stat, value) => {
        random = spyOn(Math, 'random').mockReturnValue(roll);
        const { jobs, g, term } = setUp(['x'], { jobFor: 'smith', jobFrom: 'baker', jobItem: 'sack', jobPay: 50, jobDay: '2026-10-28' }, { gold: 0 });
        await jobs.talk(g, 'smith');
        expect(screenText(term.screen)).toContain('Delivered the same day!');
        expect(g[stat]).toBe(value);
    });

    test('the giver says to get going, and takes the job back if asked; anyone else, one job at a time', async () => {
        const job = { jobFor: 'smith', jobFrom: 'baker', jobItem: 'sack', jobPay: 50, jobDay: '2026-10-28' };
        const { jobs, g, term } = setUp(['enter', 'escape', ...pick(1), 'x'], job);
        expect(jobs.label(g, 'baker')).toBe('About that sack...');
        await jobs.talk(g, 'baker');
        expect(screenText(term.screen)).toContain('The smith in Anvil is waiting for that sack!');
        expect(g.flags.jobFor).toBe('smith');
        // (Escape keeps the job.)
        await jobs.talk(g, 'baker');
        expect(g.flags.jobFor).toBe('smith');
        await jobs.talk(g, 'baker');
        expect(g.flags).toMatchObject({ jobFor: '', jobFrom: '', jobsDone: 0 });
        expect(term.remaining).toBe(0);

        const busy = setUp(['x'], job);
        const third = new JobBoard<Flags, TestWorld>({ givers: [...GIVERS, { id: 'cook', name: 'the cook', town: 'Bunton' }] });
        await third.talk(busy.g, 'cook');
        expect(screenText(busy.term.screen)).toContain("You're already taking a sack to the smith in Anvil. One job at a time.");
        expect(third.label(busy.g, 'cook')).toBe('Ask about work...');
    });

    test('giver: what they say, then work; their delivery goes straight to handing it over', async () => {
        const offered = setUp([
            () => {
                expect(screenText(offered.term.screen)).toContain('Fresh bread!');
                return 'enter';
            },
            ...pick(1),
            'x',
        ]);
        await offered.jobs.giver('baker', '{white}Fresh bread!')(offered.g);
        expect(offered.term.remaining).toBe(0);
        expect(offered.g.flags.jobOffers).toBe(OFFERS_PER_DAY - 1);

        const leaving = setUp(pick(1));
        await leaving.jobs.giver('baker', (g) => `{white}Hello, ${g.name}.`)(leaving.g);
        expect(screenText(leaving.term.screen)).toContain('Hello, Hero.');
        expect(leaving.g.flags.jobOffers).toBe(0);

        const delivering = setUp(['x'], { jobFor: 'baker', jobFrom: 'smith', jobItem: 'sack', jobPay: 40 });
        await delivering.jobs.giver('baker', 'Fresh bread!')(delivering.g);
        expect(delivering.g.flags.jobsDone).toBe(1);
    });

    test("a giver's own lines; and a board needs two people, something to carry, and known ids", async () => {
        const jobs = new JobBoard<Flags, TestWorld>({ givers: [{ id: 'baker', name: 'the baker', town: 'Bunton', lines: { none: '{white}Go away.' } }, GIVERS[1] ?? { id: '', name: '', town: '' }], today: () => '2026-10-28' });
        const { g, term } = setUp(['x'], { jobOffers: 0, jobOffersDay: '2026-10-28' });
        await jobs.talk(g, 'baker');
        expect(screenText(term.screen)).toContain('Go away.');

        expect(() => new JobBoard({ givers: GIVERS.slice(0, 1) })).toThrow('at least two people');
        expect(() => new JobBoard({ givers: GIVERS, items: [] })).toThrow('something to deliver');
        expect(() => jobs.giver('nobody', '')).toThrow('No one gives jobs as "nobody".');
    });
});
