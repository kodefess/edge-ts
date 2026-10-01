setup:
    pnpm install
    mkdir driver/stable
    cp .env.example .env.local
    pnpm build

run:
    pnpm dev