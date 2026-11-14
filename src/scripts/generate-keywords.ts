/**
 * Collects real search queries into src/data/keywords.txt.
 *
 *   just keyword 500
 *
 * Keywords come from search autocomplete (what people actually type), seeded
 * with random question starters, topics and letters, so every run gives a
 * different mix. The previous keywords.txt is kept as keywords.backup.txt.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pc from "picocolors";
import { console } from "../utils/console";
import { sleep } from "../utils/delay";

const KEYWORDS_FILE = path.resolve(import.meta.dirname, "..", "data", "keywords.txt");
const BACKUP_FILE = KEYWORDS_FILE.replace(/\.txt$/, ".backup.txt");

// ── seeds ───────────────────────────────────────────────────────────────────

const STARTERS = [
  "how to", "how do i", "how do you", "how much does", "how long does",
  "what is", "what are", "what to", "what does", "why does", "why is",
  "can you", "can i", "is it safe to", "is it worth", "should i",
  "where to", "when to", "best way to", "best", "easy", "cheap",
  "tips for", "ideas for", "difference between", "do i need",
];

// Everyday, harmless subjects. Every seed contains one of these, so the
// suggestions stay on safe ground instead of drifting to news, people or worse.
const TOPICS = [
  "cooking", "baking", "chicken", "rice", "coffee", "tea", "garden", "houseplants",
  "dog", "cat", "car", "bike", "running", "workout", "sleep", "skin care", "hair",
  "travel", "flight", "hotel", "camping", "budget", "savings", "credit score",
  "resume", "job interview", "email", "excel", "laptop", "phone", "wifi",
  "printer", "photos", "guitar", "piano", "learn spanish", "math", "wedding",
  "birthday", "christmas", "house", "apartment", "kitchen", "bathroom", "paint",
  "furniture", "laundry", "cleaning", "weather", "moon", "books", "small business",
  "podcast", "website", "recipe", "salad", "soup", "pasta", "bread", "vegetables",
  "fruit", "meditation", "walking", "swimming", "fishing", "hiking", "shoes",
  "jacket", "battery", "solar panels", "knitting", "board games", "puzzle",
  "picnic", "smoothie", "pancakes", "cookies", "pizza", "grill", "lawn", "compost",
  "aquarium", "hamster", "rabbit", "bird feeder", "road trip", "beach", "packing",
  "backpack", "keyboard", "headphones", "bluetooth", "spreadsheet", "calendar",
  "vacuum", "dishwasher", "oven", "air fryer", "oil change", "car tire", "drawing",
  "photography", "journal", "study tips", "origami", "yoga", "sunscreen", "tomatoes",
  "potatoes", "eggs", "cake", "sandwich", "breakfast", "lunch ideas", "dinner ideas",
];

const LETTERS = "abcdefghijklmnoprstuvwy".split("");

const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)] as T;

function randomSeed(): string {
  return Math.random() < 0.6
    ? `${pick(STARTERS)} ${pick(TOPICS)}`
    : `${pick(TOPICS)} ${pick(LETTERS)}`;
}

// ── suggestion sources ──────────────────────────────────────────────────────

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

/** Both endpoints answer in OpenSearch format: ["query", ["s1", "s2", ...]] */
async function fetchSuggestions(source: Source, query: string): Promise<string[]> {
  const response = await fetch(source.url(query), {
    signal: AbortSignal.timeout(8_000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!response.ok) {
    throw new Error(`${source.name} HTTP ${response.status}`);
  }

  const data: unknown = JSON.parse(await response.text());
  const list = Array.isArray(data) ? data[1] : undefined;

  return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
}

// ── filtering ───────────────────────────────────────────────────────────────

/**
 * Anything that could be unsafe, sensitive or against search/rewards rules.
 * Whole words by default (so "war" doesn't block "warm", "bet" doesn't block
 * "better"); a trailing * matches a word prefix ("gambl*" → gambling, gambler).
 */
const BLOCKED_TERMS = [
  // adult
  "sex*", "porn*", "nude*", "nudity", "naked", "xxx", "erotic*", "fetish*", "onlyfans",
  "escort*", "stripper*", "hentai", "nsfw", "horny", "boob*", "breast*", "dating",
  "hookup*", "lingerie",
  // violence & harm
  "kill*", "murder*", "suicid*", "self harm", "die", "dies", "died", "death*", "dead",
  "shoot*", "shot", "gun*", "weapon*", "bomb*", "terror*", "war", "wars", "attack*",
  "abuse*", "rape*", "assault*", "stab*", "blood*", "poison*", "fight*", "hurt*",
  // drugs, alcohol, tobacco
  "drug*", "weed", "cannabis", "marijuana", "thc", "cbd", "cocaine", "meth", "heroin",
  "opioid*", "vape*", "vaping", "smok*", "cigar*", "alcohol*", "beer*", "wine*",
  "vodka", "whiskey", "drunk", "steroid*",
  // gambling & risky money
  "casino*", "bet", "bets", "betting", "gambl*", "poker", "lottery", "crypto*",
  "bitcoin*", "forex", "stock", "stocks", "loan*", "payday",
  // illegal, piracy, cheating
  "hack*", "crack*", "torrent*", "pirat*", "free download", "steal*", "fake",
  "cheat*", "scam*", "illegal*", "jailbreak*", "bypass*", "exploit*", "proxy",
  // politics, religion, news, hate
  "trump", "biden", "election*", "vote*", "voting", "democrat*", "republican*",
  "politic*", "israel*", "palestin*", "gaza", "ukrain*", "russia*", "religio*",
  "islam*", "muslim*", "christian*", "jew*", "god", "gods", "bible", "nazi*",
  "racis*", "police", "arrest*", "prison*", "jail", "lawsuit*",
  // medical
  "cancer*", "disease*", "autis*", "diarrhea", "pregnan*", "abortion*", "std",
  "stds", "hiv", "symptom*", "overdose*", "depress*", "anxiety", "pill", "pills",
  "medication*", "surgery", "uti", "adhd", "infection*", "period", "pee", "poop",
  "toilet", "tears", "injur*", "pain", "epilep*", "seizure*", "mushroom gumm*", "gummies", "replacement", "carpal", "syndrome", "diagnos*",
  // personal data & account actions
  "login", "log in", "sign in", "password*", "account*", "near me", "phone number",
  "address", "ssn",
  // media that pulls in people's names
  "lyrics", "song", "songs", "movie*", "episode*", "season", "cast", "actor*",
  "actress*", "singer*", "rapper*", "net worth", "instagram", "tiktok", "twitter",
];

const BLOCKED = new RegExp(
  `\\b(?:${BLOCKED_TERMS.map((term) =>
    term.endsWith("*")
      ? `${term.slice(0, -1).replace(/ /g, "\\s+")}\\w*`
      : term.replace(/ /g, "\\s+"),
  ).join("|")})\\b`,
  "i",
);

/** Common Indonesian/Malay words: autocomplete sometimes mixes in local queries. */
const NON_ENGLISH =
  /\b(itu|apa|adalah|yang|dan|untuk|harga|contoh|rumah|bagus|terbaik|namanya|cara|pengeluaran|pemasukan|pribadi|bulanan|toko|rawat|jalan|inap|rapat|rangkuman|materi|sakit|putih|mobil|tembok|dasar|emiten|aja|bisa|dengan|di|ke|dari)\b/i;

export function isGoodKeyword(keyword: string): boolean {
  const words = keyword.split(" ");

  return (
    words.length >= 3 &&
    words.length <= 12 &&
    /^[a-z0-9 '?,.&-]+$/i.test(keyword) && // latin text only
    !NON_ENGLISH.test(keyword) &&
    !/\.(com|net|org|io)\b|www|http/.test(keyword) &&
    !BLOCKED.test(keyword)
  );
}

// ── collect ─────────────────────────────────────────────────────────────────

async function collect(count: number): Promise<string[]> {
  const found = new Set<string>();
  const usedSeeds = new Set<string>();
  const maxRequests = Math.ceil(count / 2) + 50;

  let requests = 0;
  let failures = 0;
  let sourceIndex = 0;

  for (let attempts = 0; found.size < count && requests < maxRequests && attempts < maxRequests * 20; attempts++) {
    const seed = randomSeed();

    if (usedSeeds.has(seed)) continue;
    usedSeeds.add(seed);

    const source = SOURCES[sourceIndex % SOURCES.length] as Source;
    requests++;

    try {
      const suggestions = await fetchSuggestions(source, seed);
      failures = 0;

      for (const raw of suggestions) {
        const keyword = raw.trim().replace(/\s+/g, " ").toLowerCase();

        // Skip half-finished queries that only echo the seed ("how do you bluetooth").
        const extendsSeed = keyword.split(" ").length > seed.split(" ").length;

        if (found.size < count && extendsSeed && isGoodKeyword(keyword)) {
          found.add(keyword);
        }
      }
    } catch {
      // Try the other source next time; give up if every source keeps failing.
      sourceIndex++;
      failures++;

      if (failures >= SOURCES.length * 3) {
        throw new Error("Tidak bisa mengambil saran pencarian. Cek koneksi internet.");
      }
    }

    if (process.stdout.isTTY) {
      process.stdout.write(`\r${pc.dim(`  mengumpulkan… ${found.size}/${count}`)}\x1b[K`);
    }

    await sleep(150 + Math.random() * 250);
  }

  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K");
  }

  // Shuffle so related queries from the same seed don't sit next to each other.
  return [...found].sort(() => Math.random() - 0.5);
}

// ── cli ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const arg = process.argv[2]?.trim() || "500";
  const count = Number(arg);

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Jumlah keyword tidak valid: "${arg}". Contoh: just keyword 500`);
  }

  console.print();
  console.dim(`  mengambil ${count} keyword dari saran pencarian…`);

  const keywords = await collect(count);

  if (keywords.length === 0) {
    throw new Error("Tidak ada keyword yang didapat; keywords.txt tidak diubah.");
  }

  if (fs.existsSync(KEYWORDS_FILE)) {
    fs.copyFileSync(KEYWORDS_FILE, BACKUP_FILE);
  }

  fs.writeFileSync(KEYWORDS_FILE, `${keywords.join("\n")}\n`, "utf8");

  console.print(`${pc.green("✓")} ${pc.bold(`${keywords.length} keyword`)} ditulis ke ${pc.dim(path.relative(process.cwd(), KEYWORDS_FILE))}`);

  if (keywords.length < count) {
    console.warning(`  ! hanya dapat ${keywords.length} dari ${count} keyword`);
  }

  if (fs.existsSync(BACKUP_FILE)) {
    console.dim(`  file lama disimpan di ${path.relative(process.cwd(), BACKUP_FILE)}`);
  }

  console.print();
  console.dim("  contoh:");

  for (const keyword of keywords.slice(0, 6)) {
    console.print(`    ${pc.dim("·")} ${keyword}`);
  }

  console.print();
}

// Run only when executed directly (not when imported, e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
