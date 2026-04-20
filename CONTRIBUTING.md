# Contributing to Mercury

Thanks for improving Mercury.

## Development setup

```bash
npm install
npm run verify
```

For an isolated OpenCode profile:

```bash
npm run dev:sandbox
HOME="$(pwd)/.sandbox/mercury-dev/home" opencode
```

## Project expectations

- Keep changes small and reversible.
- Preserve Mercury's local-first behavior.
- Do not add cloud dependencies for core memory flows.
- Keep `src/` and `dist/` in sync by running `npm run build`.

## Verification

Before opening a PR, run:

```bash
npm run verify
```

That validates:

- source syntax
- built artifact syntax
- plugin contract
- smoke behavior

## Pull requests

- Explain the user-visible outcome first.
- Include any migration or permission changes clearly.
- Mention how you verified the change.

## Release notes

User-facing changes should also be reflected in `CHANGELOG.md`.
