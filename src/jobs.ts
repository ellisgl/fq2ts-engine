// Jobs from townspeople, as LORD II's deliveries: someone in one town hands
// the player a sack or a letter to take to someone in another, for gold.
// One job at a time, a few offers a day, more pay the more jobs a player
// has done, and a small bonus for delivering on the day the job was taken.
// The news says who made deliveries.
//
// A game lists who gives (and receives) jobs, and keeps each player's job
// in their flags: its Flags include JobFlags, and its start's flags
// JOB_FLAGS. Then, for each of them, either `giver` (a script of its own,
// for someone who only had a line to say) or `talk` and `label` (an
// option in a menu they already have):
//
//   const jobs = new JobBoard<Flags>({ givers: [
//       { id: 'bartender', name: 'the bartender', town: 'Port City' },
//       { id: 'healer', name: 'the healer', town: 'Hill Valley' },
//   ] });
//   triggers: { T: jobs.giver('bartender', '{white}"What\'ll it be?"') }

import type { FlagRecord } from './player.ts';
import type { Script, ScriptContext } from './script.ts';
import type { WorldRecord } from './shared.ts';
import { escapeMarkup } from './text.ts';

// A player's job, in their flags. The giver ids are '' with no job.
// (A type, not an interface, so that it's a FlagRecord.)
export type JobFlags = {
    jobFor: string;
    jobFrom: string;
    jobItem: string;
    jobPay: number;
    // The day it was taken (for the same-day bonus).
    jobDay: string;
    // Offers left on jobOffersDay (a new day gives OFFERS_PER_DAY again).
    jobOffers: number;
    jobOffersDay: string;
    jobsDone: number;
};

export const JOB_FLAGS: JobFlags = { jobFor: '', jobFrom: '', jobItem: '', jobPay: 0, jobDay: '', jobOffers: 0, jobOffersDay: '', jobsDone: 0 };

// Unless the game says otherwise.
export const OFFERS_PER_DAY = 4;
export const JOB_ITEMS: readonly string[] = ['sack', 'satchel', 'small bag', 'letter', 'small purse'];

export interface Job {
    to: JobGiver;
    from: JobGiver;
    item: string;
    pay: number;
}

// What a giver says. Each has a default; a giver can have its own.
export interface JobLines {
    // Offering a job (the player then takes it or not).
    offer(job: Job): string;
    // Turned down.
    declined: string;
    // No offers left today.
    none: string;
    // Their delivery has come.
    thanks(job: Job): string;
    // The player still has the job they gave.
    waiting(job: Job): string;
}

export interface JobGiver {
    id: string;
    // As the rest of a sentence has them: "the bartender".
    name: string;
    town: string;
    lines?: Partial<JobLines>;
}

const quote = (text: string): string => `{white}"{yellow}${text}{white}"`;
const a = (item: string): string => `${/^[aeiou]/i.test(item) ? 'an' : 'a'} ${item}`;

export const DEFAULT_LINES: JobLines = {
    offer: ({ to, item, pay }) => quote(`I've ${a(item)} that needs taking to ${to.name} in ${to.town}. There's $${pay} in it when it gets there. Will you take it?`),
    declined: quote('Suit yourself. Maybe another time.'),
    none: quote("I've nothing for you today. Come back tomorrow."),
    thanks: ({ item }) => quote(`My ${item}! I've been waiting for this. Thank you!`),
    waiting: ({ to, item }) => quote(`What are you still doing here? ${to.name.replace(/^./, (c) => c.toUpperCase())} in ${to.town} is waiting for that ${item}!`),
};

interface JobBoardOptions {
    givers: readonly JobGiver[];
    items?: readonly string[];
    offersPerDay?: number;
    // The day, as text (default: the date on this computer's clock).
    today?(): string;
}

const two = (n: number): string => String(n).padStart(2, '0');
function localDay(): string {
    const d = new Date();
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export class JobBoard<F extends FlagRecord & JobFlags, W extends WorldRecord = WorldRecord> {
    private readonly givers: ReadonlyMap<string, JobGiver>;
    private readonly items: readonly string[];
    private readonly offersPerDay: number;
    private readonly today: () => string;

    public constructor({ givers, items = JOB_ITEMS, offersPerDay = OFFERS_PER_DAY, today = localDay }: JobBoardOptions) {
        if (givers.length < 2) {
            throw new Error('Jobs need at least two people: one to give them, and another to take them to.');
        }
        if (!items.length) {
            throw new Error('Jobs need something to deliver.');
        }

        this.givers = new Map(givers.map((giver) => [giver.id, giver]));
        this.items = items;
        this.offersPerDay = offersPerDay;
        this.today = today;
    }

    // The player's job, if they have one (and its people are still about).
    public job(g: ScriptContext<F, W>): Job | null {
        const { jobFor, jobFrom, jobItem, jobPay } = g.flags;
        const to = this.givers.get(jobFor);
        const from = this.givers.get(jobFrom);
        return to && from ? { to, from, item: jobItem, pay: jobPay } : null;
    }

    // What talking to this giver about work is, for a menu of theirs.
    public label(g: ScriptContext<F, W>, id: string): string {
        const job = this.job(g);
        if (job?.to.id === id) {
            return `Hand over the ${job.item}...`;
        }

        return job?.from.id === id ? `About that ${job.item}...` : 'Ask about work...';
    }

    // A script for someone who only had something to say: what they say,
    // then work (or, with their delivery, straight to handing it over).
    public giver(id: string, greeting: string | ((g: ScriptContext<F, W>) => string)): Script<F, W> {
        this.person(id);
        return async (g) => {
            if (this.job(g)?.to.id === id) {
                await this.talk(g, id);
                return;
            }

            g.cls();
            g.print(typeof greeting === 'string' ? greeting : greeting(g), '');
            if ((await g.choice([this.label(g, id), 'Leave...'])) === 0) {
                await this.talk(g, id);
            }
        };
    }

    // Talking to a giver about work: handing over their delivery, or the
    // job they gave, or (with no job) asking for one.
    public async talk(g: ScriptContext<F, W>, id: string): Promise<void> {
        const me = this.person(id);
        const lines = { ...DEFAULT_LINES, ...me.lines };
        const job = this.job(g);
        g.cls();
        if (job?.to.id === id) {
            await this.deliver(g, job, lines);
        } else if (job?.from.id === id) {
            g.print(lines.waiting(job), '');
            if ((await g.choice(['Be on your way...', `Give the ${job.item} back (and the job up)...`])) === 1) {
                this.clear(g);
                g.print('', `{green}You give back the ${job.item}.`);
                await g.key();
            }
        } else if (job) {
            g.print(`{green}You're already taking ${a(job.item)} to ${job.to.name} in ${job.to.town}. One job at a time.`);
            await g.key();
        } else {
            await this.offer(g, me, lines);
        }
    }

    private async offer(g: ScriptContext<F, W>, me: JobGiver, lines: JobLines): Promise<void> {
        const f = g.flags;
        const today = this.today();
        if (f.jobOffersDay !== today) {
            f.jobOffersDay = today;
            f.jobOffers = this.offersPerDay;
        }

        if (f.jobOffers <= 0) {
            g.print(lines.none, '', `{gray}(${this.offersPerDay} offers of work a day.)`);
            await g.key();
            return;
        }

        f.jobOffers -= 1;
        const others = [...this.givers.values()].filter((giver) => giver.id !== me.id);
        const to = others[g.random(others.length) - 1] ?? others[0];
        const item = this.items[g.random(this.items.length) - 1] ?? this.items[0];
        if (!to || item === undefined) {
            return;
        }

        // $40-$100, and $2 more for each job done (up to $100 more).
        const pay = 39 + g.random(61) + Math.min(2 * f.jobsDone, 100);
        const job: Job = { to, from: me, item, pay };
        g.print(lines.offer(job), '');
        if ((await g.choice(['Take the job...', 'Turn it down...'])) !== 0) {
            g.print('', lines.declined);
            await g.key();
            return;
        }

        f.jobFor = to.id;
        f.jobFrom = me.id;
        f.jobItem = item;
        f.jobPay = pay;
        f.jobDay = today;
        g.print('', `{green}You take the ${item}. Take it to {white}${to.name}{green} in {white}${to.town}{green}.`);
        await g.key();
    }

    private async deliver(g: ScriptContext<F, W>, job: Job, lines: JobLines): Promise<void> {
        const f = g.flags;
        const sameDay = f.jobDay === this.today();
        g.gold += job.pay;
        f.jobsDone += 1;
        this.clear(g);
        g.print(`{green}You hand over the ${job.item}.`, '', lines.thanks(job), '', `{green}You're paid {yellow}$${job.pay}{green}.`);
        if (sameDay) {
            g.print('', `{lightcyan}Delivered the same day! ${this.bonus(g, job)}`);
        }
        g.news(`{lightgreen}${escapeMarkup(g.name)} made a delivery to ${job.to.name} in ${job.to.town}.`);
        await g.key();
    }

    // The same-day bonus: one of these, at random.
    private bonus(g: ScriptContext<F, W>, job: Job): string {
        switch (g.random(4)) {
            case 1:
                g.maxHp += 3;
                g.hp += 3;
                return 'You feel tougher: 3 more maximum hitpoints.';
            case 2:
                g.strength += 1;
                return 'Carrying it made you stronger: 1 more strength.';
            case 3:
                g.defense += 1;
                return 'You learned a thing or two on the road: 1 more defence.';
            default: {
                const tip = Math.ceil(job.pay / 2);
                g.gold += tip;
                return `A tip for being so quick: $${tip} more.`;
            }
        }
    }

    private clear(g: ScriptContext<F, W>): void {
        const f = g.flags;
        f.jobFor = '';
        f.jobFrom = '';
        f.jobItem = '';
        f.jobPay = 0;
        f.jobDay = '';
    }

    private person(id: string): JobGiver {
        const giver = this.givers.get(id);
        if (!giver) {
            throw new Error(`No one gives jobs as "${id}".`);
        }
        return giver;
    }
}
