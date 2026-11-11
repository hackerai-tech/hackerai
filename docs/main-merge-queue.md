# Main merge queue

GitHub's merge queue validates a pull request against the current `main` tree
before it lands. Enqueue a ready PR after its required PR checks pass. A newer
`main` commit alone does not require updating the PR branch.

The queue requires `CI`, `Desktop PR builds`, and `Review and security` on its
temporary merge-group commit. CI runs the complete test and CodeQL plan. Desktop
packaging runs when the queued change affects Desktop. The security policy checks
the queue commit's processed CodeQL reports against `main` and rejects new high
or critical findings. The queue merges one PR at a time using squash commits.

If a PR leaves the queue, inspect the checks on its merge-group commit and the
queue event in the PR timeline. Fix a failed check or conflict before enqueuing
again. If a required status remains expected, verify that its workflow handled
the `merge_group` event; do not bypass the gate or repeatedly update the PR
branch to make the missing status disappear.

To recover from a queue outage, first remove the queue rule while retaining the
three required checks and strict latest-code validation. Restore the queue only
after its workflows report on a fresh merge-group commit.
