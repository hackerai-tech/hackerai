# Main merge policy

Merge reviewed pull requests directly after their required PR checks pass.
The repository does not require a merge queue or a second queue validation run.

The `main` ruleset requires `CI`, `Desktop PR builds`, and `Review and security`.
Strict status checks require the PR branch to be up to date with `main`. If
another PR lands first, update the branch and let the affected checks finish
before merging. Do not bypass the checks or use an administrator override.

PR CI selects validation from the changed paths. Desktop packaging runs when the
change affects Desktop. The review/security gate checks the applicable processed
CodeQL analysis. AI review and unresolved comments are advisory in this gate;
review available feedback separately and address valid findings. Main and nightly
validation retain the complete test and security plan.

Use the normal squash merge once the current checks and required acceptance are
complete. A passing PR check does not establish Preview, Production, or native
runtime acceptance; follow the verification rules for the affected journey.

If a required check remains expected, inspect its workflow and the PR's current
head before retrying. Do not remove a required check to make a merge pass.
