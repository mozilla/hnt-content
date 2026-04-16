# Code guidelines

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [README.md](README.md) before making changes to the codebase.

Keep doc blocks and comments as short as possible without sacrificing grammar or readability. Wrap lines at 80 characters (Prettier does not reformat comments, so this must be enforced manually). If a comment has only 1-2 words on the last line, reword it to eliminate the orphan. Only update doc blocks and comments on code you are changing.

## Doc blocks

All non-trivial functions must have a doc block. Add or update them when creating or editing functions. Only trivial one-liners are exempt.

Start with an imperative verb ("Fetch the ...", "Return whether ..."). Keep doc blocks length proportional to the function's complexity; 1-2 lines should be enough for most functions. Do not restate the function declaration (name and arguments), but think about how to make the doc block add value.

## Comments

Comments should add value: explain complex logic, workarounds, or business reasons for decisions.

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

## PR descriptions

- Follow the template in @.github/PULL_REQUEST_TEMPLATE.md.
- **Implementation decisions**: help reviewers understand the reasoning behind non-obvious choices. List only the most important design or implementation decisions. Explain the "why" clearly and concisely; tie decisions to values like reliability, safety, conventions, and avoiding surprises. Remove this section if there are no noteworthy decisions.
- **QA**: for manual verification steps beyond automated tests; omit when the test suite is sufficient.
- Write each paragraph as a single long line; do not hard-wrap prose (heredocs can inject `\r\n`, which GitHub renders as hard line breaks).
