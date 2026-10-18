export const TARGET_REQUEST_GUIDANCE = `<target_request_limits>
- Implement bounded concurrency and request throttling in scripts and scanners (e.g., asyncio semaphores and request pacing in Python).
- Respect target rate limits and explicit retry instructions. On throttling or transient target errors, reduce concurrency and back off based on target responses. Share restrictions with the parent or active workers and apply them across tools; if the retry conditions are unclear, pause affected requests and report the uncertainty.
</target_request_limits>`;
