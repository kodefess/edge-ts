/**
 * Generate harmless English search keywords into src/data/keywords.txt.
 *
 *   just keyword 500
 *   just keyword 300 --offline
 *   node node_modules/tsx/dist/cli.mjs src/scripts/generate-keywords.ts 500 [--offline]
 *
 * How it works:
 *
 * 1. Build a seed phrase, e.g. "how to" + "baking" or "gardening" + "t".
 * 2. Ask search autocomplete (Google, falling back to Bing) for suggestions,
 *    so the keywords are queries people actually type.
 * 3. Keep only suggestions that extend the seed, are 3-12 words, plain
 *    English, contain no URLs, and hit nothing on the blocklist.
 * 4. Deduplicate, shuffle, and write one keyword per line.
 *
 * If autocomplete is unavailable (or --offline is given), keywords are built
 * from local templates instead, so the command always works.
 *
 * The previous file is kept as keywords.backup.txt. If nothing could be
 * generated, keywords.txt is left unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { console, renderMarkup } from "../utils/console";
import { sleep } from "../utils/delay";

const KEYWORDS_FILE = path.resolve(import.meta.dirname, "..", "data", "keywords.txt");
const BACKUP_FILE = path.resolve(import.meta.dirname, "..", "data", "keywords.backup.txt");

const DEFAULT_COUNT = 500;

// ============================================================
// SEEDS
// Edit STARTERS and TOPICS to steer what kind of keywords come out.
// ============================================================

const STARTERS = [
  "how to", "how do i", "what is", "what are", "why does", "can you",
  "best", "easy", "simple", "cheap", "quick", "tips for", "ideas for",
  "beginner", "how long", "how much", "is it", "should i", "do i need",
  "difference between", "ways to", "when to", "where to buy",
  "how often", "what to", "which",
];

const TOPICS = [
  // Food and cooking
  "cooking", "baking", "bread", "sourdough", "pasta", "rice", "soup",
  "salad", "pancakes", "cookies", "chicken", "vegetables", "breakfast",
  "lunch ideas", "meal prep", "coffee", "tea", "smoothie", "spices",
  "kitchen", "air fryer", "slow cooker", "oven", "grilling",
  // Home and garden
  "gardening", "houseplants", "tomatoes", "herbs", "lawn", "compost",
  "cleaning", "laundry", "organizing", "closet", "furniture", "paint",
  "curtains", "home office", "bedroom", "bathroom", "decluttering",
  // Pets and nature
  "dog", "puppy", "cat", "kitten", "aquarium", "bird feeder",
  "hamster", "rabbit", "birdwatching", "stargazing",
  // Hobbies and crafts
  "knitting", "crochet", "sewing", "embroidery", "drawing",
  "watercolor", "photography", "pottery", "woodworking", "origami",
  "calligraphy", "scrapbooking", "candle making", "puzzles", "chess",
  "board games", "guitar", "piano", "ukulele", "singing",
  // Learning and work
  "excel", "spreadsheet", "email", "resume", "job interview",
  "typing", "note taking", "time management", "public speaking",
  "learning spanish", "learning english", "math", "homework",
  "study tips", "presentation", "calendar", "keyboard", "laptop",
  "printer", "wifi", "phone battery", "backup photos",
  // Outdoors and sport
  "hiking", "camping", "cycling", "bike", "running", "walking",
  "swimming", "yoga", "stretching", "picnic", "beach", "road trip",
  "car", "tires", "car wash",
  // Everyday life
  "birthday", "wedding", "gift ideas", "budget", "saving money",
  "grocery list", "moving house", "morning routine", "sleep schedule",
  "water bottle", "backpack", "shoes", "umbrella", "weather",
];

const LETTERS = "abcdefghijklmnoprstuvwy".split("");

// ============================================================
// AUTOCOMPLETE SOURCES (OpenSearch format: ["query", ["s1", "s2"]])
// ============================================================

type Source = { name: string; url: (query: string) => string };

const SOURCES: Source[] = [
  {
    name: "google",
    url: (q) =>
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(q)}`,
  },
  {
    name: "bing",
    url: (q) => `https://www.bing.com/osjson.aspx?mkt=en-US&query=${encodeURIComponent(q)}`,
  },
];

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_CONSECUTIVE_FAILURES = SOURCES.length * 3;

// ============================================================
// OFFLINE TEMPLATES (used without internet or with --offline)
// Every template reads naturally with every activity below.
// ============================================================

const OFFLINE_TEMPLATES = [
  "beginner guide to {t}",
  "how to get better at {t}",
  "tips for {t} at home",
  "common mistakes when starting {t}",
  "what do i need to start {t}",
  "how to make {t} a daily habit",
  "how to stay motivated with {t}",
  "easy ways to enjoy {t} on weekends",
  "is {t} a good hobby for beginners",
  "how much time does {t} take to learn",
  "best books for learning {t}",
  "how to practice {t} with a small budget",
  "fun {t} ideas for a rainy day",
  "how to teach kids {t}",
  "what are the benefits of {t}",
  "how to find time for {t}",
];

const OFFLINE_ACTIVITIES = [
  "gardening", "baking bread", "home cooking", "meal planning",
  "knitting", "crochet", "sewing", "embroidery", "sketching",
  "watercolor painting", "digital drawing", "photography",
  "pottery", "woodworking", "origami", "calligraphy", "journaling",
  "scrapbooking", "candle making", "soap making", "jigsaw puzzles",
  "chess", "playing board games", "playing guitar", "playing piano",
  "playing ukulele", "singing", "learning spanish",
  "learning a new language", "creative writing", "reading more books",
  "birdwatching", "stargazing", "hiking", "camping", "cycling",
  "running", "walking", "swimming", "yoga", "stretching",
  "houseplant care", "composting", "home organizing", "decluttering",
  "coffee brewing", "tea tasting", "touch typing", "public speaking",
  "note taking", "time management", "budget planning",
  "using spreadsheets", "basic coding", "building websites",
  "dog training", "caring for a cat", "keeping an aquarium",
  "bike maintenance", "car care", "model building", "kite flying",
];

// ============================================================
// FILTERS
// ============================================================

/** Plain Latin text only. */
const ALLOWED_CHARS = /^[a-z0-9 '?,.&-]+$/i;

/** Common Indonesian / Malay words, so suggestions stay English. */
const NON_ENGLISH = new RegExp(
  "\\b(itu|apa|adalah|yang|dan|untuk|dengan|dari|ini|di|ke|cara|" +
    "harga|murah|terbaik|bagaimana|kenapa|mengapa|dimana|kapan|bisa|" +
    "tidak|ada|atau|juga|saya|kamu|anda|kami|mereka|resep|membuat|" +
    "bikin|jual|beli|terdekat|gratis|lagu|arti|contoh|jadwal|hari|" +
    "tahun|bulan|kota|rumah|makan|minum|anak|baru|lama|besar|kecil|" +
    "enak|sehat|untuk)\\b",
  "i",
);

const URL_LIKE = /(\.com|\.net|\.org|\.io|www|http)/i;

/** Whole words by default; a trailing * matches a word prefix ("gambl*"). */
const BLOCKED_TERMS = [
  // Adult
  "sex*", "porn*", "nude*", "naked", "xxx", "onlyfans", "escort*",
  "erotic*", "fetish*", "dating", "hookup*", "strip*", "lingerie",
  "bikini", "kiss*", "hot girls", "sexy",
  // Violence and harm
  "kill*", "murder*", "gun*", "weapon*", "knife", "knives", "bomb*",
  "shoot*", "war", "wars", "army", "military", "fight*", "attack*",
  "dead", "death*", "die", "dies", "dying", "suicide*", "self harm",
  "abuse*", "blood*", "hunt*", "poison*", "explosive*", "terror*",
  "crime*", "criminal*", "prison", "jail", "arrest*", "police",
  "hurt*", "injur*", "violen*", "gore", "horror", "scary",
  // Drugs, alcohol, tobacco
  "drug*", "weed", "cannabis", "marijuana", "cbd", "thc", "cocaine",
  "meth*", "vape*", "vaping", "cigar*", "smok*", "tobacco", "nicotine",
  "alcohol*", "beer*", "wine*", "vodka", "whiskey", "cocktail*",
  "drunk", "hangover", "liquor", "kratom", "pill*", "steroid*",
  // Gambling and risky money
  "gambl*", "casino*", "bet", "bets", "betting", "poker", "lottery",
  "slot", "slots", "crypto*", "bitcoin*", "forex", "trading",
  "stock", "stocks", "invest*", "loan*", "debt*", "payday",
  "credit card", "bankrupt*", "tax", "taxes", "irs",
  // Illegal and piracy
  "hack*", "crack*", "pirat*", "torrent*", "free download", "apk",
  "mod apk", "cheat*", "illegal*", "steal*", "stolen", "fake*",
  "counterfeit*", "scam*", "fraud*", "bypass*", "jailbreak*",
  // Politics, religion, news, hate
  "trump", "biden", "election*", "vote*", "voting", "president*",
  "politic*", "government", "congress", "senate", "democrat*",
  "republican*", "protest*", "news", "god", "jesus", "allah",
  "bible", "quran", "church", "mosque", "religio*", "pray*",
  "racis*", "nazi*", "hate", "immigra*", "israel", "palestin*",
  "ukraine", "russia*", "gaza",
  // Medical and body
  "doctor*", "hospital*", "symptom*", "disease*", "cancer", "covid*",
  "virus*", "vaccin*", "pregnan*", "period", "pain", "diet pill*",
  "weight loss", "lose weight", "surgery", "medic*", "therap*",
  "depress*", "anxiety", "adhd", "autism", "std", "hiv", "diabet*",
  "rash", "infect*", "allerg*", "sick", "illness", "pharmac*",
  // Personal data and account actions
  "login", "log in", "sign in", "password*", "account", "address",
  "near me", "phone number", "ssn", "social security", "bank",
  "my location", "track phone", "spy*", "delete account",
  // Media, celebrities, brands that change often
  "lyrics", "movie*", "film*", "song", "songs", "episode*",
  "season", "netflix", "instagram", "tiktok", "twitter", "facebook",
  "youtube", "celebrit*", "net worth", "girlfriend", "boyfriend",
  "wife", "husband", "divorce*", "age of", "height of",
  "cast", "actor*", "actress*", "show", "shows", "tv", "trailer*",
  "anime", "manga", "meme*", "reddit", "spoiler*", "rapper*",
];

function blockedPattern(terms: readonly string[]): RegExp {
  const parts = terms.map((term) => {
    const prefix = term.endsWith("*");
    const word = term
      .replace(/\*+$/, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ /g, "\\s+");

    return `\\b${word}${prefix ? "" : "\\b"}`;
  });

  return new RegExp(parts.join("|"), "i");
}

const BLOCKED = blockedPattern(BLOCKED_TERMS);

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isGoodKeyword(keyword: string): boolean {
  const words = keyword.split(" ");

  return (
    words.length >= 3 &&
    words.length <= 12 &&
    ALLOWED_CHARS.test(keyword) &&
    !NON_ENGLISH.test(keyword) &&
    !URL_LIKE.test(keyword) &&
    !BLOCKED.test(keyword)
  );
}

// ============================================================
// HELPERS
// ============================================================

const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)] as T;

/** Fisher-Yates shuffle in place (like Python's random.shuffle). */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }

  return items;
}

/** One-line spinner on a TTY (like rich's console.status); silent otherwise. */
function createStatus() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = Boolean(process.stdout.isTTY);
  let text = "";
  let frame = 0;

  const render = () => {
    process.stdout.write(`\r${frames[frame % frames.length]} ${text}\x1b[K`);
    frame++;
  };

  const timer = tty ? setInterval(render, 80) : undefined;

  return {
    update(markup: string) {
      text = renderMarkup(markup);
      if (tty) render();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (tty) process.stdout.write("\r\x1b[K");
    },
  };
}

// ============================================================
// AUTOCOMPLETE
// ============================================================

function randomSeed(): string {
  return Math.random() < 0.6
    ? `${pick(STARTERS)} ${pick(TOPICS)}`
    : `${pick(TOPICS)} ${pick(LETTERS)}`;
}

/** Both endpoints answer in OpenSearch format: ["query", ["s1", "s2", ...]] */
async function fetchSuggestions(source: Source, seed: string): Promise<string[]> {
  const response = await fetch(source.url(seed), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!response.ok) {
    throw new Error(`${source.name} HTTP ${response.status}`);
  }

  const data: unknown = JSON.parse(await response.text());
  const list = Array.isArray(data) && data.length > 1 ? data[1] : undefined;

  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

class ConnectionError extends Error {}

/**
 * Add autocomplete keywords to `found` until it holds `count`.
 *
 * Returns normally when done or when the request budget runs out; throws
 * ConnectionError after repeated failures in a row.
 */
async function collectOnline(count: number, found: Set<string>): Promise<void> {
  const maxRequests = Math.floor(count / 2) + 50;
  const maxAttempts = maxRequests * 20;

  const usedSeeds = new Set<string>();
  let sourceIndex = 0;
  let failures = 0;
  let requests = 0;
  let attempts = 0;

  const status = createStatus();

  try {
    while (found.size < count && requests < maxRequests && attempts < maxAttempts) {
      attempts++;
      const seed = randomSeed();

      if (usedSeeds.has(seed)) {
        continue;
      }

      usedSeeds.add(seed);
      requests++;

      const source = SOURCES[sourceIndex % SOURCES.length] as Source;

      status.update(
        `[cyan]${source.name}[/cyan] [dim]·[/dim] ` +
          `${found.size}/${count} keyword ` +
          `[dim]· seed "${seed}"[/dim]`,
      );

      let suggestions: string[];

      try {
        suggestions = await fetchSuggestions(source, seed);
      } catch {
        // Stick with a source while it works; switch on failure.
        failures++;
        sourceIndex++;

        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          throw new ConnectionError("tidak bisa mengambil saran pencarian");
        }

        continue;
      }

      failures = 0;
      const seedWords = seed.split(" ").length;

      for (const raw of suggestions) {
        const keyword = normalize(raw);

        // Skip half-finished queries that only echo the seed.
        if (keyword.split(" ").length > seedWords && isGoodKeyword(keyword)) {
          found.add(keyword);
        }

        if (found.size >= count) {
          break;
        }
      }

      await sleep(150 + Math.random() * 250);
    }
  } finally {
    status.stop();
  }
}

// ============================================================
// OFFLINE
// ============================================================

/** Fill `found` from local templates (always harmless). */
function collectOffline(count: number, found: Set<string>): void {
  const combos = OFFLINE_TEMPLATES.flatMap((template) =>
    OFFLINE_ACTIVITIES.map((activity) => template.replace("{t}", activity)),
  );

  shuffle(combos);

  for (const combo of combos) {
    if (found.size >= count) {
      break;
    }

    const keyword = normalize(combo);

    if (isGoodKeyword(keyword)) {
      found.add(keyword);
    }
  }
}

// ============================================================
// MAIN
// ============================================================

const USAGE =
  "usage: generate-keywords.ts [-h] [--offline] [count]\n\n" +
  "Generate harmless English search keywords into src/data/keywords.txt.\n\n" +
  "positional arguments:\n" +
  `  count       number of keywords (default ${DEFAULT_COUNT})\n\n` +
  "options:\n" +
  "  -h, --help  show this help message and exit\n" +
  "  --offline   skip search autocomplete and use local templates only";

class UsageError extends Error {}

function positiveInt(value: string): number {
  const text = value.trim();
  const number = /^[+-]?\d+$/.test(text) ? Number(text) : 0;

  if (number <= 0) {
    throw new UsageError(`jumlah keyword tidak valid: "${value}". Contoh: just keyword 500`);
  }

  return number;
}

function writeKeywords(keywords: string[]): void {
  fs.mkdirSync(path.dirname(KEYWORDS_FILE), { recursive: true });

  if (fs.existsSync(KEYWORDS_FILE)) {
    fs.copyFileSync(KEYWORDS_FILE, BACKUP_FILE);
  }

  fs.writeFileSync(KEYWORDS_FILE, `${keywords.join("\n")}\n`, "utf8");
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let count: number;
  let offline: boolean;

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        offline: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });

    if (values.help) {
      console.print(USAGE);
      return 0;
    }

    if (positionals.length > 1) {
      throw new UsageError(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);
    }

    count = positionals[0] === undefined ? DEFAULT_COUNT : positiveInt(positionals[0]);
    offline = values.offline;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${USAGE.split("\n")[0]}\ngenerate-keywords.ts: error: ${message}\n`);
    return 2;
  }

  console.print();
  console.markup(
    `[bold white]Generate keyword[/bold white] ` +
      `[dim]· target ${count} · ` +
      `${offline ? "offline" : "autocomplete Google / Bing"}` +
      "[/dim]",
  );
  console.print();

  const found = new Set<string>();
  const startedAt = performance.now();

  if (!offline) {
    try {
      await collectOnline(count, found);
    } catch (error) {
      if (!(error instanceof ConnectionError)) {
        throw error;
      }

      console.markup(
        `[yellow]![/yellow] ${error.message} ` +
          "[dim]· cek koneksi internet, pakai template offline[/dim]",
      );
    }
  }

  const onlineCount = found.size;

  if (found.size < count) {
    collectOffline(count, found);
  }

  const offlineCount = found.size - onlineCount;

  if (found.size === 0) {
    console.markup("[red]✗[/red] Tidak ada keyword yang didapat; keywords.txt tidak diubah.");
    return 1;
  }

  const keywords = shuffle([...found]);

  writeKeywords(keywords);

  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);

  console.markup(
    `[green]✓[/green] ${keywords.length} keyword ditulis ke ` +
      `[bold]src/data/keywords.txt[/bold] ` +
      `[dim]· ${seconds}s[/dim]`,
  );
  console.markup(
    `  [dim]autocomplete ${onlineCount} · template ${offlineCount}` +
      (fs.existsSync(BACKUP_FILE) ? " · backup: keywords.backup.txt" : "") +
      "[/dim]",
  );

  if (keywords.length < count) {
    console.markup(`[yellow]![/yellow] hanya dapat ${keywords.length} dari ${count} keyword`);
  }

  console.print();

  for (const keyword of keywords.slice(0, 6)) {
    console.markup(`  [dim]·[/dim] ${keyword}`);
  }

  console.print();

  return 0;
}

// Run only when executed directly (not when imported, e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
