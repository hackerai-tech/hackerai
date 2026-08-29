# Third-Party Notices

## Strix skills

HackerAI vendors security-testing skill documents from
[usestrix/strix](https://github.com/usestrix/strix). The upstream revision and
per-file hashes are recorded in `third_party/strix-skills/UPSTREAM.json`.

Strix is Copyright 2025 OmniSecure Inc. and is licensed under the Apache
License, Version 2.0. A copy of the upstream license is included at
`third_party/strix-skills/LICENSE`.

Vendored files under `third_party/strix-skills/skills` are unmodified upstream
copies. HackerAI runtime compatibility and safety instructions are applied by
the local subagent skill registry rather than by changing those files.

The upstream `tooling` category is intentionally not imported. HackerAI agents
use the availability, version, and help output of tools installed in their
sandbox as the source of truth for CLI syntax.
