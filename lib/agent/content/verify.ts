/**
 * Deterministic checks that don't trust the model: numbers a reader would take as facts must appear in some read
 * source or the author's material. Pure functions, unit-tested without providers.
 */

/** Lowercase letters, digits and % only, single-spaced. Curly quotes, dashes and punctuation differences vanish. */
export function normalizeForMatch(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim();
}

const NUMBER =
  /(?<![\p{L}\p{N}.,/#@-])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*(?:%|percent\b|million\b|billion\b|thousand\b|[kKmMbB]\b))?/gu;

/** Link targets, inline code and code blocks aren't claims. */
function proseOnly(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ");
}

/**
 * Numbers a reader would take as facts, normalized ("5,000" → "5000", "10.4 million" → "10.4"). Years and small
 * bare counts ("3 steps") are skipped; a small number with a decimal, % or scale ("3 million") is kept.
 */
export function factualNumbers(markdown: string) {
  const found = new Set<string>();
  for (const match of proseOnly(markdown).matchAll(NUMBER)) {
    const [, whole, decimals = "", scale = ""] = match;
    const value = Number(whole.replace(/,/g, ""));
    const bare = !decimals && !scale.trim();
    if (bare && (value <= 10 || (whole.length === 4 && value >= 1900 && value <= 2099)))
      continue;
    found.add(whole.replace(/,/g, "") + decimals);
  }
  return found;
}

/** Every number in the text, normalized the same way, for looking numbers up in evidence. */
function allNumbers(text: string) {
  return new Set(
    [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) =>
      m[0].replace(/,/g, ""),
    ),
  );
}

/** Sentences (and table rows) of a section, each an exact substring of its Markdown. */
export function sentences(markdown: string) {
  return markdown
    .split("\n")
    .flatMap((line) =>
      line.trim().startsWith("|")
        ? [line.trim()]
        : line.split(/(?<=[.!?])\s+(?=[\p{Lu}*_"“(\[])/u),
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

type Token = number | "+" | "-" | "*" | "/" | "(" | ")";

/** Evaluates + - × / and parentheses over numbers; null unless the tokens form one complete expression. */
function evaluate(tokens: Token[]): number | null {
  let i = 0;
  const factor = (): number | null => {
    const token = tokens[i++];
    if (typeof token === "number") return token;
    if (token !== "(") return null;
    const value = expr();
    return tokens[i++] === ")" ? value : null;
  };
  const term = (): number | null => {
    let value = factor();
    while (value !== null && (tokens[i] === "*" || tokens[i] === "/")) {
      const op = tokens[i++];
      const next = factor();
      if (next === null) return null;
      value = op === "*" ? value * next : value / next;
    }
    return value;
  };
  const expr = (): number | null => {
    let value = term();
    while (value !== null && (tokens[i] === "+" || tokens[i] === "-")) {
      const op = tokens[i++];
      const next = term();
      if (next === null) return null;
      value = op === "+" ? value + next : value - next;
    }
    return value;
  };
  const value = expr();
  return value !== null && i === tokens.length && Number.isFinite(value) ? value : null;
}

/**
 * Results of calculations the text shows ("$50 + (1 × $5) = $55", "$149 × 2 = $298"): the inputs are checked like any
 * number, and the result is accepted when the expression before "=" really gives it. Words, link targets and units
 * between the numbers are ignored; "-" and "/" count as operators only between spaces ("add-ons", "$5/month" don't).
 */
export function calculatedNumbers(markdown: string) {
  const results: number[] = [];
  const text = proseOnly(markdown);
  for (const match of text.matchAll(/=\s*\**\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)) {
    const result = Number(match[1].replace(/,/g, ""));
    const before = text.slice(0, match.index).split(/=|[.!?:;](?=\s)|\n/).at(-1) ?? "";
    const tokens: Token[] = [];
    for (const t of before.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[+×*()]|\s[-–\/]\s/g)) {
      const raw = t[0].trim();
      tokens.push(/\d/.test(raw) ? Number(raw.replace(/,/g, "")) : raw === "×" ? "*" : raw === "–" ? "-" : (raw as Token));
    }
    // The expression is the longest tail of the numbers and operators before "=" that evaluates.
    for (let start = 0; start < tokens.length; start++) {
      const value = evaluate(tokens.slice(start));
      if (value !== null && Math.abs(value - result) < 0.005) {
        results.push(result);
        break;
      }
    }
  }
  return results;
}

/** Sentences with a number that appears in no evidence: invented statistics or figures from unread snippets. */
export function unsupportedNumbers(sections: { id: string; markdown: string }[], evidence: string) {
  const known = allNumbers(evidence);
  return sections.flatMap((section) => {
    // A shown calculation's result may be restated anywhere in its section.
    const calculated = calculatedNumbers(section.markdown);
    const derived = (n: string) => calculated.some((value) => Math.abs(value - Number(n)) < 0.005);
    return sentences(section.markdown).flatMap((sentence) => {
      const missing = [...factualNumbers(sentence)].filter((n) => !known.has(n) && !derived(n));
      return missing.length ? [{ sectionId: section.id, sentence, missing }] : [];
    });
  });
}

/** Phrases from the agents' own vocabulary that leak into reader-facing prose ("no source-3 confirms…"). */
export const PROCESS_JARGON =
  /\b(supplied (sources?|evidence|report|data|text)|(sources?|evidence) (supplied|provided|gathered) here|(any|the) sources? (supplied|provided|gathered)|(in|among) the sources here|(the|these|my|our) sources (here|above)|as supplied|in the supplied|the sources gathered|provided sources|the dossier|editorial plan|source-\d+)\b/i;
