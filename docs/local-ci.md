# Local CI for Sypatia-owned branches

Run `pnpm check:changed` after the last edit or rebase, immediately before every push. It selects the applicable checks for the changed paths. For docs-only changes, that includes formatting, README local-link validation, and changed-code quality. Do not use `--no-verify` or push after a failed check.

Install the documented toolchains and dependencies from [CONTRIBUTING.md](../.github/CONTRIBUTING.md):

```bash
pnpm install
pnpm -C mobile install --frozen-lockfile
```

For changes that touch application code, run the full checks listed in the contributor guide:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions remain paused for CI on this fork. Keep the inherited workflow definitions unchanged and do not enable or dispatch them. Existing release workflows may call shared CI helpers; preserve those calls. This policy does not initiate a release or deployment.
