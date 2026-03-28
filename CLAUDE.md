# CLAUDE.md

## Running tests

```sh
# All tests (via Turbo)
pnpm test

# Single package
pnpm --filter crawl-agent test

# Single test file (run from package dir)
cd services/crawl-agent
npx vitest run src/app.spec.ts

# Single test case (match by name)
npx vitest run src/app.spec.ts -t "returns 200"
```

## Debugging

Source maps are **not enabled** by default. To debug with breakpoints:

```sh
# From the service directory, run a test under the Node inspector:
cd services/crawl-agent
node --inspect-brk node_modules/vitest/vitest.mjs run --pool forks --poolOptions.forks.singleFork src/app.spec.ts
```

To debug the running service:

```sh
cd services/crawl-agent
node --inspect-brk dist/main.js
```

For CLI-only debugging (no IDE attach), use `console.log` or run with `NODE_DEBUG=*` for Node internals.
