## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:
- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

Every feature or behavior-change pull request must update the affected OpenWiki pages in the same pull request. Do not defer documentation to post-merge automation. Run `pnpm docs:build` before handoff; the build also validates internal links.

For documentation drift, run a local or cloud coding agent weekly or manually and submit its catch-up changes as a normal reviewed pull request. GitHub Actions must not generate OpenWiki content or use a self-hosted runner for documentation.
