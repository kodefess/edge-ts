# edge-ts

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Selenium](https://img.shields.io/badge/Selenium-WebDriver-43B02A?logo=selenium&logoColor=white)](https://www.selenium.dev/)
[![Microsoft Edge](https://img.shields.io/badge/Microsoft-Edge-0078D7?logo=microsoftedge&logoColor=white)](https://www.microsoft.com/edge)

Simple browser automation using **TypeScript** and **Selenium WebDriver**.

Supports automation with existing Edge profiles and multiple profiles through environment-based configuration.

## Structure

```text
edge-ts/
├── src/
│   └── ...
├── driver/
│   └── stable/
├── .env.example
├── Justfile
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Installation

Requirements:

- [Node.js](https://nodejs.org/)
- [pnpm](https://pnpm.io/)
- [Just](https://just.systems/)
- Microsoft Edge
- Microsoft Edge WebDriver

Clone the repository:

```bash
git clone https://github.com/kodefess/edge-ts.git
cd edge-ts
```

Run the setup:

```bash
just setup
```

This will install dependencies, create the `driver/stable` folder, create `.env` from `.env.example` (an existing `.env` is left untouched), and build the project. Put `msedgedriver.exe` in `driver/stable` and fill in `.env` before running.

## Run

Start the development environment:

```bash
just run
```

Start at a set time instead (24-hour `HH:MM`). The script waits with a countdown and starts at that time; if the time has already passed today, it starts tomorrow:

```bash
just run 10:00
```

You can also set `RUN_AT=10:00` in `.env`; the argument to `just run` takes priority. Keep the terminal open and the PC awake until then.

## Keywords

Fill `src/data/keywords.txt` with real search queries (default 500):

```bash
just keyword 500
```

Keywords are taken from search autocomplete (Google, falling back to Bing), so they are queries people actually type, and each run gives a different mix. Needs an internet connection and takes about 20 seconds for 500. Duplicates, non-English text, URLs and unsafe topics are filtered out. The previous file is kept as `src/data/keywords.backup.txt`; if nothing can be fetched, `keywords.txt` is left unchanged. Edit `STARTERS` and `TOPICS` in `src/scripts/generate-keywords.ts` to steer the topics.

## License

This project is licensed under the **WTFPL license**.

---
