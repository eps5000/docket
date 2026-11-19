# Till

A small point-of-sale checkout. Planning lives in Spec Kit (`specs/`), tickets in Jira project TL.

## Develop
- `pnpm install`, then `pnpm dev`.
- Before a pull request: `pnpm test`, `pnpm lint` and `pnpm typecheck`.
- One branch per ticket, named `tl-<n>-short-name`; squash-merge into `main`.

## Layout
- `src/checkout/`: the checkout flow.
- `specs/`: feature specs, plans and tasks.
- `docs/adr/`: architecture decisions.
