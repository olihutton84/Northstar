/**
 * Materiality.
 *
 * "Could this reasonably affect the company's fundamentals or the market's
 * expectations of them?"
 *
 * This is the dimension that separates a CEO announcing an acquisition from a
 * CEO posting a photo of a factory. It is scored by classifying the post into a
 * material-event taxonomy, then adjusting for specificity: an event type with
 * concrete figures ("$4.2B", "raises FY guidance to $6.10") is more material
 * than the same type stated vaguely.
 *
 * Output: 0..100.
 */
import { clamp } from '../../core/index.js';
import type { MaterialEventType } from '../../domain/types.js';

export interface MaterialityResult {
  /** 0..100 */
  score: number;
  eventType: MaterialEventType;
  matchedPatterns: string[];
  /** Whether the post contains concrete figures. */
  hasFigures: boolean;
  rationale: string;
}

interface EventPattern {
  type: MaterialEventType;
  /** Base materiality, 0..100, before specificity adjustment. */
  base: number;
  patterns: RegExp[];
}

/**
 * Base scores reflect how much an event of that type typically moves
 * expectations, not how often it happens. A guidance change is the single most
 * repriceable ordinary event a company produces, so it sits at the top with
 * M&A and credit events.
 */
const EVENT_PATTERNS: EventPattern[] = [
  { type: 'MERGER_ACQUISITION', base: 95, patterns: [
    /\b(acquir(e|es|ing|ed)|acquisition|merger|merge with|takeover|buyout|to purchase .{0,20}(stake|business|unit))\b/i,
    /\b(definitive agreement|all-cash (deal|offer)|tender offer)\b/i,
  ] },
  { type: 'CREDIT_EVENT', base: 95, patterns: [
    /\b(bankrupt(cy)?|chapter 11|chapter 7|default(s|ed)? on|insolvenc(y|ies)|going concern|debt restructuring)\b/i,
  ] },
  { type: 'GUIDANCE_CHANGE', base: 92, patterns: [
    // Up to three qualifier words may sit between the verb and the noun
    // ("raises ITS FULL-YEAR guidance"), so the gap is bounded rather than
    // enumerated — enumerating them missed the most common phrasing.
    /\b(raise[sd]?|raising|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?|hike[sd]?|lower[sd]?|lowering|cuts?|cutting|slash(?:es|ed)?|trim(?:s|med)?|withdraw[sn]?|reaffirm(?:s|ed)?|update[sd]?)\s+(?:[\w$.,%-]+\s+){0,3}?(guidance|outlook|forecast)\b/i,
    /\b(guidance|outlook|forecast)\s+(raise|cut|increase|reduction|hike|revision)\b/i,
  ] },
  { type: 'REGULATORY_APPROVAL', base: 90, patterns: [
    /\b(fda (approv|clear)|approved by the fda|regulatory approval|ce mark|emergency use authorization|antitrust clearance)\w*/i,
  ] },
  { type: 'EARNINGS_RESULT', base: 88, patterns: [
    /\b(q[1-4]|first|second|third|fourth)[- ]quarter (results|earnings|revenue)\b/i,
    /\b(earnings|eps|revenue|profit)\s+(beat|miss|of|came in|rose|fell|up|down)\b/i,
    /\b(reports?|reported|posts?|posted)\s+(q[1-4]\s+)?(earnings|revenue|results|profit|loss)\b/i,
    /\b(beats?|misses?|missed)\s+(street|analyst|consensus|expectations|estimates)\b/i,
  ] },
  { type: 'REGULATORY_ACTION', base: 88, patterns: [
    /\b(sec|doj|ftc|cftc|finra|eu commission)\b.{0,40}\b(investigat|charg|sues?|sued|subpoena|enforcement|probe|fine)\w*/i,
    /\b(under investigation|formal probe|consent decree|cease and desist)\b/i,
  ] },
  { type: 'SHORT_REPORT', base: 82, patterns: [
    /\b(short (report|seller report)|publishes short|hindenburg|muddy waters|citron)\b/i,
    /\b(accounting (fraud|irregularit)|inflated (revenue|earnings))\w*/i,
  ] },
  { type: 'MAJOR_CONTRACT', base: 78, patterns: [
    /\b(win[s]?|won|award(ed)?|secure[sd]?|lands?)\b.{0,30}\b(contract|deal|order|tender|agreement)\b/i,
    /\b(contract worth|deal valued at|order book)\b/i,
  ] },
  { type: 'LEGAL_ACTION', base: 75, patterns: [
    /\b(lawsuit|class action|sues?|sued|litigation|settlement|verdict|damages award|patent (suit|infringement))\b/i,
  ] },
  { type: 'CAPITAL_RETURN', base: 72, patterns: [
    /\b(buyback|share repurchase|repurchase program|dividend (increase|hike|initiation|cut|suspension)|special dividend)\b/i,
  ] },
  { type: 'CAPITAL_RAISE', base: 70, patterns: [
    /\b(secondary offering|share offering|equity raise|convertible notes|debt offering|dilut(e|ion|ive)|private placement)\b/i,
  ] },
  { type: 'INDEX_CHANGE', base: 70, patterns: [
    /\b(added to|removed from|join(s|ing)?)\b.{0,20}\b(s&p 500|nasdaq[- ]100|russell|dow jones)\b/i,
    /\bindex (inclusion|addition|deletion)\b/i,
  ] },
  { type: 'OPERATIONAL_INCIDENT', base: 68, patterns: [
    /\b(recall|data breach|security breach|hack(ed)?|ransomware|major outage|production halt|plant (fire|explosion|shutdown)|grounded)\b/i,
  ] },
  { type: 'EXECUTIVE_CHANGE', base: 65, patterns: [
    /\b(ceo|cfo|coo|chairman|president)\b.{0,30}\b(resign|step(s|ping)? down|depart|out|fired|terminated|appoint|name[sd]?|hire[sd]?|succeed)\w*/i,
    /\bnames? (new )?(ceo|cfo|coo)\b/i,
  ] },
  { type: 'WORKFORCE_ACTION', base: 60, patterns: [
    /\b(layoffs?|job cuts?|redundanc(y|ies)|workforce reduction|hiring freeze|restructuring plan|strike|union vote)\b/i,
  ] },
  { type: 'PRODUCT_LAUNCH', base: 55, patterns: [
    /\b(launch(es|ed|ing)?|unveil(s|ed|ing)?|announce[sd]?|introduc(e|es|ed|ing)|releases?)\b.{0,30}\b(product|device|model|chip|platform|service|version|generation)\b/i,
  ] },
  { type: 'PARTNERSHIP', base: 52, patterns: [
    /\b(partnership|partners with|collaborat(e|es|ion) with|joint venture|teams? up with|strategic alliance)\b/i,
  ] },
  { type: 'ANALYST_ACTION', base: 45, patterns: [
    /\b(upgrade[sd]?|downgrade[sd]?|initiat(e|es|ed) coverage|price target|reiterat(e|es|ed)|overweight|underweight|outperform|underperform)\b/i,
  ] },
  { type: 'MACRO_POLICY', base: 40, patterns: [
    /\b(tariffs?|export controls?|sanctions?|interest rates?|fed (raises|cuts)|inflation data|trade restrictions?)\b/i,
  ] },
];

const FIGURE_PATTERNS = [
  /\$\s?\d[\d,.]*\s?(b(n|illion)?|m(n|illion)?|k|trillion)?\b/i,
  /\b\d+(\.\d+)?\s?%/,
  /\b\d+(\.\d+)?\s?(bps|basis points)\b/i,
  /\beps of \$?\d/i,
  /\b\d{4}\s+(guidance|outlook)\b/i,
];

export function scoreMateriality(text: string): MaterialityResult {
  const matched: { type: MaterialEventType; base: number; pattern: string }[] = [];

  for (const spec of EVENT_PATTERNS) {
    for (const re of spec.patterns) {
      const m = re.exec(text);
      if (m) {
        matched.push({ type: spec.type, base: spec.base, pattern: m[0].slice(0, 60) });
        break;
      }
    }
  }

  const hasFigures = FIGURE_PATTERNS.some((re) => re.test(text));

  if (matched.length === 0) {
    // No material-event language at all. Commentary can still carry a little
    // materiality if it contains hard numbers, but not much.
    const score = hasFigures ? 25 : 10;
    return {
      score,
      eventType: 'GENERAL_COMMENTARY',
      matchedPatterns: [],
      hasFigures,
      rationale: hasFigures
        ? 'No material-event language, but the post cites specific figures'
        : 'General commentary with no identifiable corporate event',
    };
  }

  matched.sort((a, b) => b.base - a.base);
  const primary = matched[0]!;

  // Specificity adjustment: concrete figures raise materiality, vagueness
  // lowers it. A second distinct event type in the same post also raises it
  // (e.g. an acquisition that also changes guidance).
  let score = primary.base;
  if (hasFigures) score += 6;
  else score -= 8;
  if (matched.length > 1) score += 4;
  if (/\b(rumor|rumour|speculation|reportedly|unconfirmed|could|may|might|exploring|considering)\b/i.test(text)) {
    score -= 15;
  }

  score = Math.round(clamp(score, 0, 100));

  const rationale =
    `Classified as ${primary.type.replace(/_/g, ' ').toLowerCase()}` +
    (hasFigures ? ' with specific figures' : ' without specific figures') +
    (matched.length > 1 ? `; also matched ${matched.length - 1} other event type(s)` : '');

  return {
    score,
    eventType: primary.type,
    matchedPatterns: matched.map((m) => m.pattern),
    hasFigures,
    rationale,
  };
}

/** Weighted aggregate across a cluster, plus the dominant event type. */
export function aggregateMateriality(
  entries: { materiality: number; eventType: MaterialEventType; weight: number }[],
): { score: number; dominantEventType: MaterialEventType } {
  const usable = entries.filter((e) => e.weight > 0);
  if (usable.length === 0) return { score: 0, dominantEventType: 'GENERAL_COMMENTARY' };

  // Materiality is a property of the *event*, not of how many people mentioned
  // it, so the cluster takes the strongest well-supported reading rather than
  // an average that a crowd of vague posts could dilute.
  const best = usable.reduce((a, b) => (b.materiality > a.materiality ? b : a));
  const totalWeight = usable.reduce((a, e) => a + e.weight, 0);
  const weightedMean = usable.reduce((a, e) => a + e.materiality * e.weight, 0) / totalWeight;
  const score = Math.round(clamp(best.materiality * 0.7 + weightedMean * 0.3, 0, 100));

  return { score, dominantEventType: best.eventType };
}
