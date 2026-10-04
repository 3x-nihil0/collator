/**
 * The pile of documents a keyword search would rank.
 *
 * These are paraphrases of real sources, each carrying the URL it stands for.
 * They exist so the baseline has something to be *wrong about*: a ranked list
 * of prose that never contains the four-dimensional answer.
 */

export interface CorpusDoc {
  id: string;
  title: string;
  source: string;
  url: string;
  /** paraphrase of what this source advises */
  text: string;
  /** the approach the document steers you toward, if any */
  recommends?: { engineId?: string; policyId?: string };
}

export const CORPUS: CorpusDoc[] = [
  {
    id: "so-nocase-unique",
    title: "How to make a case-insensitive unique column in SQLite",
    source: "Stack Overflow (accepted answer, score 300+, 2013)",
    url: "https://stackoverflow.com/questions/20914946/how-to-make-a-case-insensitive-unique-column-in-sqlite",
    text:
      "Declare the email column COLLATE NOCASE and the unique constraint becomes case insensitive. " +
      "For a case insensitive unique column in SQLite this is the standard answer: add COLLATE NOCASE " +
      "to the column definition and the unique index will treat Alice and alice as the same email address.",
    recommends: { engineId: "sqlite/nocase" },
  },
  {
    id: "sqlite-datatypes",
    title: "Datatypes In SQLite - 3.1 Built-in Collating Sequences",
    source: "sqlite.org",
    url: "https://sqlite.org/datatype3.html#collation",
    text:
      "SQLite ships three built-in collating sequences: BINARY, NOCASE and RTRIM. BINARY is the default " +
      "and compares strings byte for byte. NOCASE treats the 26 upper case characters of ASCII as their " +
      "lower case equivalents. RTRIM ignores trailing spaces. Anything else must be registered with " +
      "sqlite3_create_collation.",
    recommends: { engineId: "sqlite/binary" },
  },
  {
    id: "blog-full-unicode-sqlite",
    title: "5 ways to implement case-insensitive search in SQLite with full Unicode support",
    source: "shallowdepth.online (January 2022)",
    url: "https://shallowdepth.online/posts/2022/01/5-ways-to-implement-case-insensitive-search-in-sqlite-with-full-unicode-support/",
    text:
      "COLLATE NOCASE is not enough for international text. Case-insensitive search in SQLite with full " +
      "Unicode support needs a registered custom collation, an ICU extension, a generated column holding " +
      "a normalized value, or a separate search column.",
    recommends: { engineId: "sqlite/nfc_fold" },
  },
  {
    id: "practice-lowercase-email",
    title: "Should I store email addresses in lowercase?",
    source: "Widespread practice / Q&A folklore",
    url: "https://stackoverflow.com/search?q=lowercase+email+unique",
    text:
      "Normalize the email address before you store it. Convert the email address to lowercase on " +
      "registration and on login, and the case sensitivity of the unique column stops mattering. " +
      "Lowercasing the email address is all most applications need.",
    recommends: { policyId: "python.lower" },
  },
  {
    id: "python-casefold",
    title: "str.casefold() - Python 3 documentation",
    source: "docs.python.org",
    url: "https://docs.python.org/3/library/stdtypes.html#str.casefold",
    text:
      "Return a string suitable for caseless comparisons. Casefold is stronger than lower and is " +
      "designed for caseless matching, so it handles characters such as the German sharp s that lower " +
      "leaves alone.",
    recommends: { policyId: "python.casefold" },
  },
  {
    id: "mysql-charsets",
    title: "Unicode Character Sets and Collations",
    source: "dev.mysql.com reference manual",
    url: "https://dev.mysql.com/doc/refman/8.0/en/unicode-charset.html",
    text:
      "MySQL collation names encode their behaviour. The ai suffix means accent insensitive and ci means " +
      "case insensitive. The utf8mb4_0900 family introduced in MySQL 8.0 is NO PAD while older collations " +
      "are PAD SPACE, which changes how trailing spaces behave inside a unique index.",
    recommends: { engineId: "mysql/utf8mb4_0900_ai_ci" },
  },
  {
    id: "uax15-normalization",
    title: "UAX #15 - Unicode Normalization Forms",
    source: "unicode.org",
    url: "https://www.unicode.org/reports/tr15/",
    text:
      "NFC composes sequences into single characters while NFD decomposes them. NFKC additionally applies " +
      "compatibility decomposition, folding fullwidth forms and ligatures. Normalization matters when the " +
      "same visible text arrives from different operating systems.",
  },
  {
    id: "uts39-confusables",
    title: "UTS #39 - Unicode Security Mechanisms, confusable detection",
    source: "unicode.org",
    url: "https://www.unicode.org/reports/tr39/",
    text:
      "Confusable characters are a security problem, not a collation problem. Case folding and " +
      "normalization do not fold Cyrillic a into Latin a. Confusable detection is a separate table and a " +
      "separate algorithm.",
  },
];
