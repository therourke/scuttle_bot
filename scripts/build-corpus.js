#!/usr/bin/env node
// Reads the source .md texts and builds a derived corpus file: a
// backoff Markov word-chain model (order-3 falling back to order-2)
// plus a large pool of clause-length phrase fragments for cut-up
// recombination, and a common-word list used to score generated
// candidates for vividness. This is a personal, non-commercial,
// heavily-transformed remix bot, so we keep a generous derived corpus
// rather than a token statistical skeleton - but we still don't
// persist raw full paragraphs or anything resembling the original
// book structure, only shuffled fragments and transition tables.

const fs = require("fs");
const path = require("path");

// The corpus texts live alongside this script's project folder (one
// level up from scripts/) by default - override with --dir if needed.
const DEFAULT_DIR = path.join(__dirname, "..");

const args = process.argv.slice(2);
const dirFlagIndex = args.indexOf("--dir");
const CORPUS_DIR = dirFlagIndex !== -1 ? args[dirFlagIndex + 1] : DEFAULT_DIR;
const OUT_FILE = path.join(__dirname, "..", "data", "corpus.json");

// The bot's own project files sit in the same folder as the corpus
// texts now - exclude anything that isn't actually corpus material.
const EXCLUDE_FILES = new Set(["readme.md"]);

const MAX_FRAGMENTS = 2500;
const FRAGMENT_MIN_WORDS = 4;
const FRAGMENT_MAX_WORDS = 14;
const COMMON_WORD_COUNT = 150;
const MAX_HIGHLIGHTS = 1200;
const HIGHLIGHT_MAX_CHARS = 260;
const MAX_PROPER_NOUNS = 400;

// The book-title anchors specifically: "Rum, Sodomy, and the Lash".
// These get their own dedicated, guaranteed-sampled pool since they're
// exactly what should be showing up regularly and weren't. "rum" and
// "lash" are matched as exact whole words - both are short/ambiguous
// enough to false-match otherwise ("grumbled", or "lashed the tiller"
// meaning tied, not whipped). "sodom" is a stem, catching
// sodomite/sodomites/sodomitical too.
const TITLE_WORDS_RE = /\b(rum|sodom\w*|lash)\b/i;

// Broader topical anchors - lines mentioning these (in any inflected
// form: pirate/pirates/piracy/piratical/pirating/pirated/...) are the
// "weirder, more on-theme" content we want the bot to surface more
// often. Stems are used (no closing \b) so inflections match too -
// this matters a lot for modern usages like "pirating" a text, which
// an exact-word match would otherwise miss entirely.
const TOPIC_STEMS = [
  "buccaneer", "pirat", "privateer", "freebooter", "corsair", "gallows",
  "hang", "mutin", "plunder", "maroon", "scuttl", "flogg",
];
const TOPIC_PHRASES = [
  "hostis humani generis", "jolly roger", "pieces of eight", "black spot",
  "yo-ho-ho", "shiver my timbers", "dead man's chest", "doubloon",
  "treasure", "parrot", "cutlass",
];
const TOPIC_KEYWORDS_RE = new RegExp(
  `\\b(${TOPIC_STEMS.join("|")})|\\b(${TOPIC_PHRASES.join("|")})\\b`,
  "i"
);
const TOPIC_KEYWORDS_RE_WITH_TITLE = new RegExp(
  `${TITLE_WORDS_RE.source}|${TOPIC_KEYWORDS_RE.source}`,
  "i"
);
const END_TOKEN = "\u0000END";

function readTexts(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .filter((f) => !EXCLUDE_FILES.has(f.toLowerCase()));
  if (files.length === 0) {
    throw new Error(`No .md/.txt files found in ${dir}`);
  }
  console.log(`Corpus source files: ${files.join(", ")}`);
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
}

// Project Gutenberg plaintext files wrap the actual book in a
// license/header block and a license footer - strip both so they
// don't pollute the corpus (and so we don't end up quoting Gutenberg
// boilerplate as if it were the book).
function stripGutenbergBoilerplate(text) {
  const startMatch = text.match(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const endMatch = text.match(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const start = startMatch ? startMatch.index + startMatch[0].length : 0;
  const end = endMatch ? endMatch.index : text.length;
  return text.slice(start, end);
}

function cleanText(raw) {
  let text = raw.replace(/\r\n/g, "\n");

  // Strip Project Gutenberg license header/footer, if present
  text = stripGutenbergBoilerplate(text);

  // Join hyphenated line-wrap breaks from PDF extraction, e.g.
  // "produc-\ntion" -> "production"
  text = text.replace(/([a-z])-\n([a-z])/g, "$1$2");

  // Strip YAML frontmatter
  text = text.replace(/^---[\s\S]*?---\n/, "");

  // Strip HTML footnote markers like <sup>13</sup>
  text = text.replace(/<sup>\d+<\/sup>/g, "");

  // Unescape markdown-escaped punctuation (\( \) \! \[ \])
  text = text.replace(/\\([()!\[\]])/g, "$1");

  // Strip markdown emphasis markers
  text = text.replace(/\*\*/g, "").replace(/\*/g, "");

  // Collapse stray space left behind before punctuation once emphasis
  // markers next to it are removed, e.g. "Pirates *." -> "Pirates ."
  text = text.replace(/ +([.,!?;:])/g, "$1");

  // Strip footnote numbers glued directly onto the end of a word/punctuation
  // e.g. "in 1684.13" -> "in 1684.", "century,25" -> "century,"
  text = text.replace(/([a-zA-Z.,;:!?'")])(\d{1,3})(?=\s|$)/g, "$1");

  return text;
}

const NOTE_PARA_RE = /^\d{1,4}\.\s/;
const CITATION_KEYWORDS = /\bIbid\b|\bpp?\.\s?\d|\bVol\.\s|University Press|Journal of/i;

function isNoiseParagraph(para) {
  if (NOTE_PARA_RE.test(para)) return true;
  if (CITATION_KEYWORDS.test(para)) return true;
  const digitGroups = para.match(/\d+/g) || [];
  if (digitGroups.length >= 4) return true;
  return false;
}

function hasHeavyDigits(sentence) {
  const digitGroups = sentence.match(/\d+/g) || [];
  return digitGroups.length >= 2;
}

const BIBLIOGRAPHY_LEAD_RE = /^[A-Z][A-Za-z.]+(,\s[A-Z][A-Za-z.]+)*:\s/; // "New York: Harper..."
const PUBLICATION_YEAR_RE = /,\s?(1[5-9]\d{2}|20\d{2})\.$/; // "..., 1908."
const ABBREVIATION_CUTOFF_RE = /\s[A-Z]\.$/; // "...Robert C." (mid-name initial, sentence-split artifact)

function isBibliographyLike(sentence) {
  return (
    BIBLIOGRAPHY_LEAD_RE.test(sentence) ||
    PUBLICATION_YEAR_RE.test(sentence) ||
    ABBREVIATION_CUTOFF_RE.test(sentence)
  );
}

function splitSentences(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.split(" ").length >= 8) // drop headings/TOC-like lines
    .filter((p) => !isNoiseParagraph(p));

  const sentences = [];
  for (const para of paragraphs) {
    const matches = para.match(/[^.!?]+[.!?]+["')\]]*/g) || [];
    for (const m of matches) {
      const s = m.trim();
      const words = s.split(" ").length;
      if (
        words >= 4 &&
        words <= 40 &&
        s.length <= 280 &&
        !hasHeavyDigits(s) &&
        !isBibliographyLike(s)
      ) {
        sentences.push(s);
      }
    }
  }
  return sentences;
}

function buildMarkovTable(sentences, order) {
  const table = {};
  const starts = [];

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= order) continue;

    starts.push(words.slice(0, order).join(" "));

    for (let i = 0; i <= words.length - order; i++) {
      const key = words.slice(i, i + order).join(" ");
      const next = words[i + order] || END_TOKEN;
      if (!table[key]) table[key] = [];
      table[key].push(next);
    }
  }

  return { starts, table };
}

// Order-3 for local grammatical coherence, with an order-2 table to
// fall back to once the specific 3-word context runs out - this is
// what gives a stretch of plausible grammar before it goes off the
// rails, rather than pure word salad throughout.
function buildMarkov(sentences) {
  const order3 = buildMarkovTable(sentences, 3);
  const order2 = buildMarkovTable(sentences, 2);
  return {
    order3: { starts: order3.starts, table: order3.table },
    order2: { starts: order2.starts, table: order2.table },
  };
}

const STOPWORDS = new Set(
  "the a an of to and in that is was for on with as it he she they his her their by at from be were are this which or not but had have has if into than then so"
    .split(" ")
);

function buildCommonWords(sentences, count) {
  const freq = new Map();
  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[.,;:!?"'\u2019()]/g, "")
      .split(/\s+/)
      .filter(Boolean);
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  return [...new Set([...STOPWORDS, ...ranked.slice(0, count)])];
}

// Capitalized words/nationalities/institutions that recur constantly
// but aren't the pirate names we're after.
const NAME_BLACKLIST = new Set([
  "The", "This", "That", "These", "Those", "There", "Their", "They",
  "England", "English", "America", "American", "Americans", "Spanish",
  "Spain", "French", "France", "British", "Britain", "Europe", "European",
  "Europeans", "Caribbean", "Christian", "Christianity", "Christians",
  "Catholic", "Catholics", "Protestant", "Protestants", "God", "King",
  "Queen", "Captain", "Sir", "Chapter", "Introduction", "Preface",
  "Contents", "Indies", "West", "East", "North", "South", "Atlantic",
  "Navy", "Royal", "Crown", "Parliament", "Church", "Bible", "New",
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
  "His", "Her", "Its", "World", "Great", "And", "But", "Man", "Men",
  "Life", "Black", "White", "Sea", "War", "Most", "Who", "True", "Long",
  "Well", "Now", "Yet", "All", "Very", "Even", "More", "Much", "Many",
  "Every", "Account", "Serious", "Reflections", "Restoration", "Capt",
  "History", "Adventures", "Farther", "Island", "Pirates", "Pyrates",
]);

function cleanWordToken(raw) {
  return raw.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, "");
}

function isCapitalizedWord(word) {
  return /^[A-Z][a-zA-Z']{2,}$/.test(word);
}

// Cheap named-entity heuristic: a capitalized word that recurs when
// NOT at the start of a sentence is very likely a proper noun. Two
// consecutive capitalized words form an even stronger signal (titles
// plus surnames, first-and-last names) - this is how the actual
// pirates' names surface: Blackbeard, Kidd, Bonny, Read, Roberts,
// Bonnet, Misson, and so on.
function buildProperNouns(sentences, maxNouns) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = cleanWordToken(words[i]);
      if (!isCapitalizedWord(word)) continue;

      const next = i + 1 < words.length ? cleanWordToken(words[i + 1]) : "";
      const nextIsCap = isCapitalizedWord(next);

      const isSentenceStart = i === 0;
      if (!isSentenceStart && !NAME_BLACKLIST.has(word)) bump(word);

      if (nextIsCap && !(NAME_BLACKLIST.has(word) && NAME_BLACKLIST.has(next))) {
        bump(`${word} ${next}`);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNouns)
    .map(([name]) => name);
}

function looksLikeCitation(fragment) {
  return /\(\d|\d:\d|\[\d|http/.test(fragment);
}

// Pull out whole sentences that are already grammatical and mention
// something genuinely on-theme (rum/sodomy/the lash/pirate tradition)
// so the bot can post real, weird lines from the books more often
// instead of only generated recombinations. Deliberately keyword-only
// (not "or has a recognized name") - name-matching against ~400
// extracted proper nouns, many of them common words, was swamping
// this pool and drowning out the specific rum/sodomy/lash content.
function buildHighlights(sentences, maxHighlights) {
  const pool = new Set();

  for (const sentence of sentences) {
    if (sentence.length > HIGHLIGHT_MAX_CHARS) continue;
    if (!TOPIC_KEYWORDS_RE_WITH_TITLE.test(sentence)) continue;
    pool.add(sentence);
  }

  return [...pool].sort(() => Math.random() - 0.5).slice(0, maxHighlights);
}

// "Modern piracy" - digital/political piracy from the Gary Hall essay
// and the Pirate Care excerpts. These two sources are tiny compared
// to the two academic books (which mention "pirate" constantly), so
// without a dedicated guaranteed pool their material gets drowned out
// completely - the same problem rum/sodomy/lash had.
// Deliberately narrow and specific, not thematic - generic words like
// "criminalized" or "Empire" also appear constantly in the two
// historical-piracy books (they're centrally about legal
// criminalization of 18th-century pirates), so using them here just
// pulled in old-book sentences under a "modern piracy" label instead
// of actually isolating the Gary Hall/Pirate Care material.
const MODERN_PIRACY_RE = new RegExp(
  [
    "AAAAARG", "open access", "pirate care", "pirate carer",
    "pirat(?:ing|ed)", "mutual aid", "hacktivis", "digital piracy",
    "file.?sharing", "\\btorrent", "\\bDRM\\b", "Napster", "Pirate Bay",
    "Pirate Party", "phreak", "Fitzpatrick", "\\bSuber\\b",
  ].join("|"),
  "i"
);

function buildModernPiracyQuotes(sentences) {
  const pool = new Set();
  for (const sentence of sentences) {
    if (sentence.length > HIGHLIGHT_MAX_CHARS) continue;
    if (!MODERN_PIRACY_RE.test(sentence)) continue;
    pool.add(sentence);
  }
  return [...pool];
}

// The dedicated "Rum, Sodomy, and the Lash" pool - guaranteed to get
// sampled every post rather than hoping it turns up by chance in a
// larger mixed bag.
function buildTitleQuotes(sentences) {
  const pool = new Set();
  for (const sentence of sentences) {
    if (sentence.length > HIGHLIGHT_MAX_CHARS) continue;
    if (!TITLE_WORDS_RE.test(sentence)) continue;
    pool.add(sentence);
  }
  return [...pool];
}

function buildFragments(sentences, highlights, maxFragments) {
  const pool = new Set();
  // Oversample highlight sentences so cut-up splices are more likely
  // to include on-theme/name-bearing material too, not just any text.
  const weighted = sentences.concat(highlights, highlights, highlights);
  const shuffled = weighted.sort(() => Math.random() - 0.5);

  for (const sentence of shuffled) {
    if (pool.size >= maxFragments) break;
    const words = sentence.replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
    if (words.length < FRAGMENT_MIN_WORDS) continue;

    const len = Math.min(
      words.length,
      FRAGMENT_MIN_WORDS + Math.floor(Math.random() * (FRAGMENT_MAX_WORDS - FRAGMENT_MIN_WORDS + 1))
    );
    const start = Math.floor(Math.random() * (words.length - len + 1));
    const fragment = words.slice(start, start + len).join(" ");

    if (looksLikeCitation(fragment)) continue;
    if (fragment.length < 16 || fragment.length > 120) continue;

    pool.add(fragment);
  }

  return [...pool];
}

function main() {
  console.log(`Reading corpus from: ${CORPUS_DIR}`);
  const texts = readTexts(CORPUS_DIR);
  const cleaned = texts.map(cleanText);
  const sentences = cleaned.flatMap(splitSentences);
  console.log(`Extracted ${sentences.length} usable sentences.`);

  const markov = buildMarkov(sentences);
  const commonWords = buildCommonWords(sentences, COMMON_WORD_COUNT);
  const properNouns = buildProperNouns(sentences, MAX_PROPER_NOUNS);
  const highlights = buildHighlights(sentences, MAX_HIGHLIGHTS);
  const titleQuotes = buildTitleQuotes(sentences);
  const modernPiracyQuotes = buildModernPiracyQuotes(sentences);
  const fragments = buildFragments(sentences, highlights, MAX_FRAGMENTS);

  console.log(`Built order-3 table with ${Object.keys(markov.order3.table).length} keys.`);
  console.log(`Built order-2 fallback table with ${Object.keys(markov.order2.table).length} keys.`);
  console.log(`Found ${properNouns.length} proper nouns/names, e.g.: ${properNouns.slice(0, 20).join(", ")}`);
  console.log(`Built ${highlights.length} highlight sentences (topic-keyword-bearing).`);
  console.log(`Built ${titleQuotes.length} title-quote sentences (rum/sodomy/lash specifically).`);
  console.log(`Built ${modernPiracyQuotes.length} modern-piracy sentences (Gary Hall/Pirate Care).`);
  console.log(`Built ${fragments.length} phrase fragments.`);

  const output = {
    generatedAt: new Date().toISOString(),
    markov,
    fragments,
    commonWords,
    properNouns,
    highlights,
    titleQuotes,
    modernPiracyQuotes,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  console.log(`Wrote ${OUT_FILE}`);
}

main();
