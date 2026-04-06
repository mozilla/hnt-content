# Contributing to hnt-content

Please read our [Community Participation Guidelines](CODE_OF_CONDUCT.md) before participating.

For setup, repo structure, and development commands, see [README.md](README.md).

## Code Conventions

Formatting and linting are handled by tooling. Follow these additional conventions.

### Simplicity

Prefer simple, conventional solutions over complex or cutting-edge alternatives. When in doubt, choose the approach that is easiest to read, test, and maintain.

### Testing

Unit tests run in isolation and are fast, making them ideal for covering edge cases thoroughly. Integration tests exercise real dependencies and are slower, so reserve them for critical paths and cross-boundary interactions.

### TSDoc

All non-trivial functions get a minimal `/** ... */` block:

```ts
/** Fetch article metadata from the upstream API. */
```

`@param` and `@returns` are optional; include them when meaning is not obvious from names and types:

```ts
/**
 * Determine whether an article is stale enough to re-crawl.
 * @param lastCrawledAtMs - Epoch-ms timestamp of the last successful crawl.
 * @returns `true` if the article should be re-crawled.
 */
```

Trivial one-liners do not need doc blocks.

## Submitting Changes (HNT team)

Every PR must reference a Jira ticket. Use [Conventional Commits](https://www.conventionalcommits.org/) with the ticket as scope:

- **Branch:** `HNT-<number>-<kebab-case-description>`
- **Commits/PR title:** `<type>(HNT-<number>): <description>`
- **Types:** `feat` | `fix` | `chore` | `refactor` | `test` | `docs` | `ci`
- Subject: lowercase, imperative mood, no trailing period

Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) and link the Jira ticket.

## Submitting Changes (external)

External contributions are welcome. Fork the repo and open a PR against `main`. The Jira scope is not required; use plain Conventional Commits:

```
fix: handle null article body
```

Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) where applicable. Every PR requires at least one approving review from a code owner before merging.

## Resources

- [Community Participation Guidelines](CODE_OF_CONDUCT.md)
- [License](LICENSE) (MPL 2.0)
