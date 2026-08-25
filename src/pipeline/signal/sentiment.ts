/**
 * Sentiment.
 *
 * Deliberately a deterministic finance lexicon, NOT a language model.
 *
 * Two reasons:
 *   1. An order must never trace back to generated text. A lexicon is
 *      inspectable, reproducible and auditable: the same post always yields the
 *      same number, and the UI can show exactly which words produced it.
 *   2. Historical replay would be meaningless if the scorer's behaviour drifted
 *      between runs.
 *
 * The lexicon is finance-specific. In general English "miss" is neutral and
 * "beat" is violent; in earnings language they are the two most directional
 * words there are.
 *
 * Output: -100 (maximally negative) .. +100 (maximally positive).
 */
import { clamp } from '../../core/index.js';

export interface SentimentHit {
  term: string;
  polarity: number;
  negated: boolean;
  weight: number;
}

export interface SentimentResult {
  /** -100..+100 */
  score: number;
  hits: SentimentHit[];
  /** 0..1 — proportion of directional terms among content words. */
  density: number;
  positiveTerms: string[];
  negativeTerms: string[];
}

/** term -> polarity (-1..1). Multi-word entries are matched as phrases. */
const LEXICON: Record<string, number> = {
  // strongly positive
  'beats expectations': 1, 'beat expectations': 1, 'record revenue': 0.95, 'record profit': 0.95,
  'raises guidance': 1, 'raised guidance': 1, 'raising guidance': 1, 'guidance raise': 1,
  'fda approval': 1, 'approved by the fda': 1, 'wins contract': 0.9, 'won contract': 0.9,
  'awarded contract': 0.9, 'to acquire': 0.7, 'acquisition of': 0.6, 'buyback': 0.75,
  'share repurchase': 0.75, 'dividend increase': 0.8, 'raises dividend': 0.8,
  'better than expected': 0.9, 'ahead of expectations': 0.85, 'upgraded': 0.7, 'upgrade': 0.65,
  'outperform': 0.6, 'breakthrough': 0.7, 'milestone': 0.5, 'expansion': 0.45, 'partnership': 0.45,
  'strategic partnership': 0.6, 'record quarter': 0.9, 'strong demand': 0.7, 'demand surge': 0.75,
  'accelerating': 0.5, 'profitable': 0.6, 'turnaround': 0.5, 'index inclusion': 0.7,
  'added to the s&p': 0.85, 'beats': 0.8, 'beat': 0.7, 'surges': 0.6, 'soars': 0.65, 'rally': 0.4,
  'growth': 0.35, 'strong': 0.45, 'positive': 0.4, 'gains': 0.35, 'wins': 0.55, 'success': 0.45,
  'launch': 0.3, 'launches': 0.3, 'unveils': 0.3, 'expands': 0.35, 'secures': 0.5, 'approval': 0.6,

  // strongly negative
  'misses expectations': -1, 'missed expectations': -1, 'cuts guidance': -1, 'cut guidance': -1,
  'lowers guidance': -1, 'lowered guidance': -1, 'guidance cut': -1, 'withdraws guidance': -1,
  'sec investigation': -1, 'doj investigation': -1, 'under investigation': -0.9,
  'accounting irregularities': -1, 'restatement': -0.9, 'fraud': -1, 'bankruptcy': -1,
  'chapter 11': -1, 'default': -0.9, 'recall': -0.8, 'product recall': -0.85,
  'class action': -0.7, 'lawsuit': -0.6, 'sued': -0.6, 'fined': -0.7, 'penalty': -0.6,
  'data breach': -0.8, 'security breach': -0.8, 'outage': -0.6, 'layoffs': -0.55,
  'job cuts': -0.55, 'plant closure': -0.6, 'ceo resigns': -0.7, 'cfo resigns': -0.75,
  'steps down': -0.5, 'downgraded': -0.7, 'downgrade': -0.65, 'underperform': -0.6,
  'worse than expected': -0.9, 'below expectations': -0.85, 'short report': -0.8,
  'short seller': -0.6, 'halted': -0.7, 'trading halt': -0.75, 'delisting': -0.95,
  'weak demand': -0.7, 'demand slowdown': -0.7, 'slowdown': -0.5, 'misses': -0.8, 'miss': -0.6,
  'plunges': -0.7, 'tumbles': -0.65, 'slumps': -0.6, 'falls': -0.35, 'decline': -0.4,
  'weak': -0.45, 'negative': -0.4, 'losses': -0.5, 'loss': -0.4, 'warning': -0.6,
  'warns': -0.6, 'delay': -0.45, 'delayed': -0.45, 'halt': -0.6, 'probe': -0.7, 'subpoena': -0.8,
  'concerns': -0.35, 'risk': -0.25, 'cuts': -0.4, 'dropped': -0.35, 'disappointing': -0.7,
};

/** Terms that flip the polarity of a nearby lexicon hit. */
const NEGATORS = ['not', 'no', 'never', 'without', 'denies', 'denied', 'refutes', 'rejects', 'rejected', "isn't", "doesn't", "won't", 'fails to', 'failed to'];

/** Terms that shrink confidence in the claim rather than flipping it. */
const HEDGES = ['reportedly', 'rumor', 'rumour', 'rumored', 'speculation', 'speculating', 'may', 'might', 'could', 'possibly', 'allegedly', 'unconfirmed', 'considering', 'exploring', 'in talks'];

/** Intensity multipliers. */
const INTENSIFIERS: Record<string, number> = {
  massive: 1.4, huge: 1.35, major: 1.25, significant: 1.2, sharply: 1.3, dramatically: 1.35,
  slightly: 0.6, marginally: 0.55, modest: 0.7, slight: 0.6,
};

/**
 * Directional patterns for the phrasings that matter most.
 *
 * Plain phrase entries in the lexicon match by adjacency, so "raises guidance"
 * hits but "raises ITS FULL-YEAR guidance" does not — and a guidance change is
 * the single most repriceable thing a company says. These patterns allow a
 * bounded gap between the verb and the noun, so the common real-world phrasings
 * score the same as the terse ones.
 *
 * Matched spans are consumed before word-level scoring, so nothing double
 * counts.
 */
const PHRASE_PATTERNS: { re: RegExp; polarity: number; label: string }[] = [
  {
    re: /\b(raise[sd]?|raising|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?|hike[sd]?|increase[sd]?)\s+(?:[\w$.,%-]+\s+){0,3}?(guidance|outlook|forecast)\b/gi,
    polarity: 1,
    label: 'raises guidance',
  },
  {
    re: /\b(cuts?|cutting|lower[sd]?|lowering|slash(?:es|ed)?|trim(?:s|med)?|reduce[sd]?|withdraw[sn]?)\s+(?:[\w$.,%-]+\s+){0,3}?(guidance|outlook|forecast)\b/gi,
    polarity: -1,
    label: 'cuts guidance',
  },
  {
    re: /\b(beats?|beat|exceed(?:s|ed)?|tops?|ahead of|above)\s+(?:[\w$.,%-]+\s+){0,2}?(expectations?|consensus|estimates?|forecasts?|street)\b/gi,
    polarity: 0.9,
    label: 'beats expectations',
  },
  {
    re: /\b(miss(?:es|ed)?|below|short of|trail(?:s|ed)?|under)\s+(?:[\w$.,%-]+\s+){0,2}?(expectations?|consensus|estimates?|forecasts?|street)\b/gi,
    polarity: -0.9,
    label: 'misses expectations',
  },
  {
    re: /\brecord\s+(?:[\w$.,%-]+\s+){0,2}?(revenue|profit|earnings|quarter|sales|demand|backlog)\b/gi,
    polarity: 0.9,
    label: 'record results',
  },
];

const PHRASES = Object.keys(LEXICON).filter((k) => k.includes(' ')).sort((a, b) => b.length - a.length);
const WORDS = new Set(Object.keys(LEXICON).filter((k) => !k.includes(' ')));

function normalise(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function scoreSentiment(text: string): SentimentResult {
  const normalised = normalise(text);
  const hits: SentimentHit[] = [];
  let consumed = normalised;

  // Gap-tolerant patterns first: they cover the phrasings that carry the most
  // information and would otherwise be scored a word at a time, or missed.
  for (const pattern of PHRASE_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of [...consumed.matchAll(pattern.re)]) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      const before = consumed.slice(Math.max(0, index - 40), index);
      hits.push({
        term: pattern.label,
        polarity: pattern.polarity,
        negated: hasNegator(before),
        weight: intensityFrom(before),
      });
      consumed =
        `${consumed.slice(0, index)}${' '.repeat(match[0].length)}${consumed.slice(index + match[0].length)}`;
    }
  }

  // Then literal phrases: "beats expectations" must not be scored as "beats".
  for (const phrase of PHRASES) {
    let index = consumed.indexOf(phrase);
    while (index !== -1) {
      const before = consumed.slice(Math.max(0, index - 40), index);
      hits.push({
        term: phrase,
        polarity: LEXICON[phrase]!,
        negated: hasNegator(before),
        weight: intensityFrom(before),
      });
      consumed = `${consumed.slice(0, index)}${' '.repeat(phrase.length)}${consumed.slice(index + phrase.length)}`;
      index = consumed.indexOf(phrase);
    }
  }

  const tokens = consumed.split(/[^a-z0-9$%'&.-]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!.replace(/[.,;:!?]+$/, '');
    if (!WORDS.has(token)) continue;
    const before = tokens.slice(Math.max(0, i - 4), i).join(' ');
    hits.push({
      term: token,
      polarity: LEXICON[token]!,
      negated: hasNegator(before),
      weight: intensityFrom(before),
    });
  }

  if (hits.length === 0) {
    return { score: 0, hits: [], density: 0, positiveTerms: [], negativeTerms: [] };
  }

  const hedged = HEDGES.some((h) => normalised.includes(h));
  const hedgeFactor = hedged ? 0.6 : 1;

  // Mean of effective polarities, not sum: a long post with many mild words
  // must not outscore a short post that says "cuts guidance".
  let total = 0;
  for (const h of hits) {
    total += (h.negated ? -h.polarity : h.polarity) * h.weight;
  }
  const meanPolarity = total / hits.length;

  // A dominant extreme term should still dominate — take the stronger of the
  // mean and 80% of the single most extreme hit.
  const extreme = hits.reduce((max, h) => {
    const effective = (h.negated ? -h.polarity : h.polarity) * h.weight;
    return Math.abs(effective) > Math.abs(max) ? effective : max;
  }, 0);
  const blended = Math.abs(extreme) * 0.8 > Math.abs(meanPolarity) ? extreme * 0.8 : meanPolarity;

  const contentWords = normalised.split(' ').filter((w) => w.length > 2).length;
  const density = contentWords === 0 ? 0 : clamp(hits.length / contentWords, 0, 1);

  const positiveTerms = hits.filter((h) => (h.negated ? -h.polarity : h.polarity) > 0).map((h) => h.term);
  const negativeTerms = hits.filter((h) => (h.negated ? -h.polarity : h.polarity) < 0).map((h) => h.term);

  return {
    score: Math.round(clamp(blended * hedgeFactor * 100, -100, 100)),
    hits,
    density: Number(density.toFixed(4)),
    positiveTerms: [...new Set(positiveTerms)],
    negativeTerms: [...new Set(negativeTerms)],
  };
}

function hasNegator(before: string): boolean {
  return NEGATORS.some((n) => new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(` ${before} `));
}

function intensityFrom(before: string): number {
  for (const [word, factor] of Object.entries(INTENSIFIERS)) {
    if (before.includes(word)) return factor;
  }
  return 1;
}

/**
 * Aggregate sentiment across a cluster of events, weighted by evidence weight.
 * Also reports disagreement, which feeds the uncertainty model.
 */
export function aggregateSentiment(
  entries: { sentiment: number; weight: number }[],
): { score: number; disagreement: number } {
  const usable = entries.filter((e) => e.weight > 0);
  if (usable.length === 0) return { score: 0, disagreement: 0 };

  const totalWeight = usable.reduce((a, e) => a + e.weight, 0);
  const score = usable.reduce((a, e) => a + e.sentiment * e.weight, 0) / totalWeight;

  const directional = usable.filter((e) => Math.abs(e.sentiment) >= 10);
  let disagreement = 0;
  if (directional.length >= 2) {
    const positive = directional.filter((e) => e.sentiment > 0).length;
    const negative = directional.length - positive;
    // 0 when unanimous, 1 when evenly split.
    disagreement = 1 - Math.abs(positive - negative) / directional.length;
  }

  return { score: Math.round(clamp(score, -100, 100)), disagreement: Number(disagreement.toFixed(4)) };
}
