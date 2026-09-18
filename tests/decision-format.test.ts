import { describe, it, expect } from 'vitest';
import { parseDecision, stripMarks } from '../src/client/decision-format.js';

/**
 * The text a real parked job carried, hard wraps and all. Everything this
 * parser has to get right is in here: two questions, a bold lead on each, an
 * (a)/(b)/(c) list run together in one sentence, a recommendation naming an
 * option, an assumed default, and identifiers that must survive intact.
 */
const REAL = `- **Is there real incoming Bizum traffic on this account inside the pull window?**
  Question 2 is unanswerable with \`bizumIn === 0\`, and \`MAX_HISTORICAL_DAYS=730\` only
  helps if the traffic already happened. Options: (a) accept \`INCONCLUSIVE\` and let Phase
  0b carry near-real-time detection; (b) seed one — have someone send a €1 Bizum with a
  deliberately chosen concept string like \`P2-2026-09\` the day before the pull;
  (c) pull first and decide after. **Recommend (b)**: a single seeded Bizum answers both
  halves of question 2 *and* tests whether a prescribed concept code survives the feed
  intact, which is the one thing no amount of historical data can tell you. It costs one
  of the ~4 daily fetches.
- **If Enable Banking's KYB refuses an individual, stop or escalate?** I have assumed
  stop — record the answer against §6.9, mark PSD2 off the table, and treat §3.2 + §3.3
  as the whole ingestion story exactly as §3.4 prescribes. The alternative is registering
  an entity to satisfy KYB, which is a real-world cost well beyond a days-long spike.
  Confirm before the implement stage starts, because it changes whether a refusal is a
  completed feature or a blocker.`;

describe('parseDecision', () => {
  it('splits a real parked detail into one card per question', () => {
    const parsed = parseDecision(REAL);
    expect(parsed).not.toBeNull();
    expect(parsed!.questionCount).toBe(2);
    expect(parsed!.cards).toHaveLength(2);
    expect(parsed!.preamble).toEqual([]);
  });

  it('lifts the question out of the block', () => {
    const [first, second] = parseDecision(REAL)!.cards;
    expect(first.question).toBe(
      'Is there real incoming Bizum traffic on this account inside the pull window?'
    );
    expect(second.question).toBe(
      "If Enable Banking's KYB refuses an individual, stop or escalate?"
    );
  });

  it('re-joins the hard wraps and keeps identifiers intact', () => {
    const [first] = parseDecision(REAL)!.cards;
    expect(first.context[0]).toContain('unanswerable with bizumIn === 0');
    expect(first.context[0]).toContain('MAX_HISTORICAL_DAYS=730');
    expect(first.context.join(' ')).not.toContain('\n');
  });

  it('pulls the alternatives out as options', () => {
    const [first] = parseDecision(REAL)!.cards;
    expect(first.options.map((o) => o.label)).toEqual(['a', 'b', 'c']);
    expect(first.options[0].text).toBe(
      'accept INCONCLUSIVE and let Phase 0b carry near-real-time detection'
    );
    expect(first.options[1].text).toContain('send a €1 Bizum');
    expect(first.options[2].text).toBe('pull first and decide after');
  });

  it('separates the recommendation and the option it names', () => {
    const [first] = parseDecision(REAL)!.cards;
    expect(first.recommendation?.kind).toBe('recommends');
    expect(first.recommendation?.option).toBe('b');
    // The lead-in is the callout's label, so the body starts at the reasoning.
    expect(first.recommendation?.text).toMatch(/^a single seeded Bizum/);
    // The sentence after it is context, not part of the recommendation.
    expect(first.recommendation?.text).not.toContain('daily fetches');
    expect(first.context.join(' ')).toContain('daily fetches');
  });

  it('marks an assumed default as assumed rather than recommended', () => {
    const [, second] = parseDecision(REAL)!.cards;
    expect(second.recommendation?.kind).toBe('assumes');
    // An assumed default keeps its lead-in: "stop" is the decision itself.
    expect(second.recommendation?.text).toMatch(/^I have assumed stop/);
    // Section numbers must not be read as sentence ends.
    expect(second.recommendation?.text).toContain('§3.4 prescribes.');
    expect(second.context.join(' ')).toContain('The alternative is registering');
  });

  it('never loses what the model wrote', () => {
    const parsed = parseDecision(REAL)!;
    const rendered = parsed.cards
      .flatMap((c) => [c.question, ...c.context, ...c.options.map((o) => o.text), c.recommendation?.text ?? ''])
      .join(' ');
    for (const phrase of [
      'near-real-time detection',
      'deliberately chosen concept string',
      'pull first and decide after',
      'no amount of historical data can tell you',
      'mark PSD2 off the table',
      'completed feature or a blocker',
    ]) {
      expect(rendered).toContain(phrase);
    }
  });

  it('keeps text written before the first question', () => {
    const parsed = parseDecision('Two things blocked this.\n\n- **Ship it now?** I think yes.')!;
    expect(parsed.preamble).toEqual(['Two things blocked this.']);
    expect(parsed.cards).toHaveLength(1);
  });

  it('treats an unlisted detail as a single question', () => {
    const parsed = parseDecision(
      'Should the cache be per-user or global? Per-user doubles memory but avoids leaks.'
    )!;
    expect(parsed.questionCount).toBe(1);
    expect(parsed.preamble).toEqual([]);
    expect(parsed.cards[0].question).toBe('Should the cache be per-user or global?');
    expect(parsed.cards[0].context).toEqual(['Per-user doubles memory but avoids leaks.']);
  });

  it('does not promote deeper bullets into questions of their own', () => {
    const parsed = parseDecision(
      '- **Which store?**\n    - sqlite\n    - a flat file\n- **Which port?** 4220 is free.'
    )!;
    expect(parsed.questionCount).toBe(2);
  });

  it('returns null when nothing is question-shaped, so the caller can fall back', () => {
    expect(parseDecision('- rebase hit a conflict in src/app.ts\n- left it alone')).toBeNull();
    expect(parseDecision('')).toBeNull();
    expect(parseDecision('   ')).toBeNull();
  });

  it('keeps a block with no question as a plain note', () => {
    const parsed = parseDecision('- **Merge now?** It is green.\n- Unrelated: the lockfile moved.')!;
    expect(parsed.questionCount).toBe(1);
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[1].question).toBe('');
    expect(parsed.cards[1].context).toEqual(['Unrelated: the lockfile moved.']);
  });

  it('ignores a lone or out-of-order marker rather than inventing a list', () => {
    const one = parseDecision('- **Go?** Only option (a) is on the table here.')!;
    expect(one.cards[0].options).toEqual([]);
    const jumbled = parseDecision('- **Go?** We could (a) wait or (c) ship.')!;
    expect(jumbled.cards[0].options).toEqual([]);
  });
});

describe('stripMarks', () => {
  it('drops code and bold marks', () => {
    expect(stripMarks('use `npm run build` and **stop**')).toBe('use npm run build and stop');
  });

  it('leaves underscores alone so identifiers survive', () => {
    expect(stripMarks('set MAX_HISTORICAL_DAYS=730')).toBe('set MAX_HISTORICAL_DAYS=730');
  });

  it('strips single-asterisk emphasis without touching maths', () => {
    expect(stripMarks('both halves *and* the code')).toBe('both halves and the code');
    expect(stripMarks('2 * 3 * 4')).toBe('2 * 3 * 4');
  });
});
