# Repository privacy rules

- Use Git Bash for Windows shell commands unless the action is Windows-specific.
- Before every commit, inspect the staged diff and run `node scripts/check-privacy.mjs`.
- Before every push, run `node scripts/check-privacy.mjs --history`.
- Do not commit real deployment addresses, account emails, usernames, local absolute paths, credentials, login state, runtime data, or production screenshots. Use example domains and documentation IP addresses.
- Inspect every new screenshot or binary artifact manually. Keep production test evidence under ignored `data/`; only synthetic mock screenshots belong in documentation.
- Use a GitHub noreply commit email. Never bypass a failed privacy hook; resolve the finding first.
- Install the repository hooks in each checkout with `git config core.hooksPath .githooks`.
- When the user requests a code commit, also push it to the configured remote.
