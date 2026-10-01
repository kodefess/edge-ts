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

This will install dependencies, create the WebDriver directory, create `.env.local`, and build the project.

## Run

Start the development environment:

```bash
just run
```

## License

This project is licensed under the **WTFPL license**.

---
