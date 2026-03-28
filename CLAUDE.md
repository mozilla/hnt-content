# Testing

```sh
pnpm test                                        # all tests (via Turbo)
pnpm --filter crawl-agent test                   # single package
pnpm --filter crawl-agent exec vitest run src/app.spec.ts          # single file
pnpm --filter crawl-agent exec vitest run src/app.spec.ts -t "returns 200"  # single test
```

## Debugging tests

**console.log output is hidden by default.** Always add `--reporter=verbose`:

```sh
pnpm --filter crawl-agent exec vitest run src/app.spec.ts --reporter=verbose
```

Node inspector breakpoints:

```sh
NODE_OPTIONS='--inspect-brk' pnpm --filter crawl-agent exec vitest run src/app.spec.ts
```

## Debugging a running service

```sh
NODE_OPTIONS='--inspect-brk' pnpm --filter crawl-agent start
```

## Type checking

Use `tsc --noEmit`, not `vitest typecheck` (not configured in this repo):

```sh
pnpm --filter crawl-agent exec tsc --noEmit
```

# Git conventions

**Branches:** `HNT-<number>-<kebab-case-description>` (e.g. `HNT-2097-scaffold-repo`)

**Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/) with the Jira ticket as scope:

```
<type>(HNT-<number>): <imperative verb> <description>
```

- **type**: `feat` | `fix` | `chore` | `refactor` | `test` | `docs` | `ci`
- **scope**: always the Jira ticket, e.g. `HNT-2097`
- **subject**: lowercase, imperative mood, no period

Examples:
```
feat(HNT-2097): add crawl-agent healthcheck endpoint
fix(HNT-3001): handle null article body from Zyte
chore(HNT-2097): migrate from Jest to Vitest
```
