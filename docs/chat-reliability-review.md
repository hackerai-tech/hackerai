# Chat-history reliability and performance

## Changes

- Regeneration iterates backwards only through trailing assistant messages and
  hidden continuations, stopping at the visible request. It no longer collects
  the entire conversation before finding that boundary. Existing ownership,
  summary invalidation, file cleanup, and transactional deletion remain intact.
- Prompt-note injection uses the `by_user_and_category_and_updated` index instead
  of collecting and sorting every general note. It stops at the existing plan
  token budget or 100 notes, whichever comes first. Invalid token counts fall
  back to an estimate. Notes outside this prompt prefix are not deleted.
- Image URL prefetch reserves IDs before awaiting network requests, including
  queued batches. Batches run sequentially per prefetch pass, and a failed batch
  no longer discards successful batches. Lazy non-image fetching is unchanged.
- History-query failures propagate to an error boundary around the components
  that own the subscriptions. They no longer masquerade as an empty account or
  missing task. Intentional unauthenticated/not-owned results remain unchanged.
- Loading lasting 15 seconds offers a connection/reload notice, without
  interrupting short authentication refreshes or automatically reloading a task.
- Sidebar rows are memoized, use off-screen content visibility, and mount their
  share dialogs only when opened. Containment is disabled for open menus/dialogs
  and dragging. The intrinsic content height excludes the row's padding.
- Sidebar pagination observes its scroll container and synchronously locks a
  load request until the next pagination update.

## Reference

Reviewed [t3code's sidebar at b438447f](https://github.com/pingdotgg/t3code/blob/b438447f67b6b61bbe6f564d8b78fd90702117c5/apps/web/src/components/Sidebar.tsx).
Its memoized rows and off-screen `content-visibility` informed the sidebar
changes. HackerAI already uses LegendList transcript virtualization, paginated
message loading, stable timeline rows, and isolated composer state; those systems
were retained rather than replaced.

## Regression coverage

- A synthetic 10,000-message history reads four records to regenerate a trailing
  assistant/hidden-continuation/assistant chain, deleting only those three rows.
- Synthetic 10,000-note accounts stop after 5 or 15 notes at 1,000 tokens per
  note; tiny/invalid counts are bounded by the 100-note cap.
- Fifty streaming rerenders produce one pending image-URL request; a 101-image
  case exercises batch ordering, partial failure, cache retention, and retries.
- Query failures surface as failures; the history boundary can retry after
  recovery. Loading notices delay recovery UI and clean up their timers.
- Pagination tests verify the scroll root and duplicate-callback suppression.
- Chromium verification with 1,000 synthetic tasks using the actual sidebar
  components and application CSS: the list retained its 40,012px scroll height
  from top to bottom; the last row was visible and keyboard activation selected
  `/c/chat-999`; the task menu and delayed Reload notice displayed correctly;
  no share dialogs mounted while closed. Backend and drag state were mocked.

## Manual verification before production confidence

1. In an authenticated preview, open an established account's task history.
   Scroll through multiple pages, open old tasks, and rapidly switch tasks.
   Check that the selected transcript, unread indicators, and scroll position
   remain correct on desktop and mobile.
2. Exercise keyboard navigation, task menus, pinning, project moves, sharing,
   and dragging after scrolling far down the sidebar. Menus/dialogs must remain
   visible and interactive. The isolated browser fixture mocks backend and drag
   state, so it cannot replace this authenticated check.
3. Delay or disconnect the backend: loading should offer Reload after 15 seconds.
   For an actual query error, restore connectivity and use Try Again/Refresh
   Page. Do not confuse missing-history errors with a legitimately empty account.
4. Regenerate a long task with hidden continuations, including summary reset.
   Only the latest response chain should disappear; earlier requests must remain.
5. Open an image-heavy task while streaming. Confirm URL batches are not
   duplicated for pending images, and completed images survive another batch's
   failure. Send a new prompt from an account with many notes and check context.
6. Deploy the Convex schema/index and functions with the frontend release.
   Reproduce the customer incident and correlate the existing diagnostics before
   claiming that their account-specific problem is resolved.

## Remaining limits

These changes address concrete code risks, not a proven root cause for a
particular account. Large branch/copy operations and exceptionally large trailing
response chains can still exceed one mutation's resource limits; converting them
to resumable batched operations requires a separate transactional design. CSS
content visibility defers layout/painting, not React mounts or all subscriptions;
the sidebar still retains previously loaded pages. Provider latency and account
authentication/authorization must be checked against live diagnostic evidence.
