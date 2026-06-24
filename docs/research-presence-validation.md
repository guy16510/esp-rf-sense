# Research-backed presence validation

The research-backed four-node presence pipeline was rebased onto the latest `main` before merge.

Local validation completed successfully:

- Formatting, lint, and TypeScript typecheck
- 59 Node and TypeScript tests, including UDP and replay integration
- Deterministic five-stage presence smoke test
- Four firmware host tests
- 38 Python analysis tests
- Node dashboard build

GitHub Actions provides the final browser E2E and ESP-IDF firmware build gates before merge.
