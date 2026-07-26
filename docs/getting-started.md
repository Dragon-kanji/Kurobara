# Getting started

Use this path to verify Kurobara locally without creating a provider account or
spending provider credits.

## Requirements

- Git
- Docker with Compose v2
- Node.js `24.14.0`
- npm `10.9.4`

The versions are pinned because the preview artifacts and checks are qualified
against that exact toolchain.

## Clone and run

```sh
git clone https://github.com/Dragon-kanji/Kurobara.git
cd Kurobara
npm ci
npm run self-host:smoke
```

The smoke test:

1. builds the API, worker, and CLI;
2. starts loopback-only PostgreSQL, Hatchet, API, and worker services;
3. creates a synthetic workspace and API key;
4. imports a synthetic dataset;
5. applies a deterministic enrichment recipe;
6. verifies the result after a PostgreSQL restart;
7. performs a real dump/restore and verifies the result again;
8. removes its temporary stack, volumes, key, and dump.

No external provider or LLM is called.

## What success proves

A successful run proves the local path:

```text
CLI -> HTTP API -> PostgreSQL -> Hatchet -> worker -> durable result -> export
```

It also proves that the checked-out revision can survive an application
database restart and a backup/restore cycle. It does not prove production
hardening, Internet exposure, or the validity of any provider account.

## Run a persistent deterministic stack

Copy the tracked example and replace both placeholder passwords:

```sh
cp deploy/self-host/.env.example deploy/self-host/.env
chmod 600 deploy/self-host/.env

docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  up --detach --build --wait
```

Check the API:

```sh
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
```

Bootstrap the deterministic planning bundle:

```sh
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  --profile tools run --rm bootstrap-planning
```

Create a local API key. The command prints the key once, so redirect it to a
private file rather than copying it into shell history:

```sh
umask 077
mkdir -p .local

docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  --profile tools run --rm bootstrap-api-key |
node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (typeof value.presented_key !== "string") process.exit(1);
    process.stdout.write(`${value.presented_key}\n`);
  });
' > .local/api-key

chmod 600 .local/api-key
```

`.local/` is ignored by Git. Never commit the key.

## Exercise the CLI

Import the example dataset:

```sh
npm run kurobara -- dataset import \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --metadata examples/dataset-import/metadata.json \
  --source examples/dataset-import/source.jsonl
```

Apply and watch the example recipe:

```sh
npm run kurobara -- recipe apply \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --request examples/recipe-apply/request.example.json

npm run kurobara -- recipe watch \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --application-id application_demo_org_website_v1 \
  --timeout-ms 120000
```

All successful CLI responses are JSON. Use the returned IDs rather than
guessing server state.

## Stop the stack

```sh
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  down
```

This preserves volumes. Read [Operations and privacy](./operations.md) before
deleting data or restoring a backup.

## Next

- Use provider keys: [Build B2B lists](./b2b-lists.md)
- Automate the CLI: [Agent integration](./agents.md)
- Understand BYOK behavior: [Providers](./providers.md)
