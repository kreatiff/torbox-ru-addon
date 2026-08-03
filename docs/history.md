# Project history

This repo was built by Claude Code (an AI coding agent) working from a spec the repo owner
wrote by hand. This document is the record of how that happened — kept as committed markdown
rather than a GitHub wiki page because the session doing this work didn't have write access to
the wiki (see the note at the bottom).

## The initial prompt

The repo already contained [`torbox-ru-addon-spec.md`](../torbox-ru-addon-spec.md) — a
484-line build spec written by the repo owner, covering the problem, the environment, the
domain rules, the data model, every component, a locked build order, testing expectations,
non-goals, and known traps. The session that produced everything else in this repo opened
with a single instruction:

> your task is defined in this filer torbox-ru-addon-spec.md

(quoted verbatim, typo included). Everything from that point on was Claude Code reading the
spec and acting on it.

## How the plan came together

The spec's own closing section (§10, "First response") anticipated exactly this situation and
was explicit about sequencing:

> Before writing code: restate the architecture in your own words, list anything in this spec
> that's underspecified or that you disagree with, and propose the exact file tree. Then stop
> and wait for my go-ahead.

Claude Code treated that as a real instruction rather than a formality: it entered plan mode,
delegated an independent design review to a sub-agent (asked to critique the proposed module
boundaries, the data-access-layer choice, and surface any gaps in the spec itself, without
seeing Claude's own draft first), then merged that review with its own analysis into a single
document — restated architecture, two places it disagreed with the spec, a tiered list of
underspecified items with proposed defaults, a table of tooling decisions the spec explicitly
left open, and a full proposed file tree. That document was approved (with the note that
Tier-1 open items didn't need to be resolved all at once) and is now committed as
[`torbox-ru-addon-plan.md`](../torbox-ru-addon-plan.md).

## Build environment constraints discovered along the way

The sandbox this was built in turned out to have no outbound network path to either
`api.torbox.app` or Docker Hub (an organization-level egress policy denies both at the proxy).
That shaped how Milestones 1-2 got verified:

- **No live TorBox API access**, ever, from this session. `src/torbox/schemas.ts` is a
  best-effort reconstruction of the response shape from the spec's own data model and general
  knowledge of the API, not a live-verified one. The zod-at-every-boundary discipline the spec
  asked for (§5.1) is exactly what makes this safe to ship anyway: a wrong field name degrades
  to a loud, logged parse failure instead of silent bad data.
- **No Docker image ever got built.** `docker-compose.yml`/`Dockerfile` are validated for
  syntax (`docker compose config`) but the actual `linux/arm64` build is unverified until it
  runs on the real Oracle Cloud host.
- Everything else — migrations, the full DB layer, the ingest pipeline's branching logic,
  `expandRule`, the materialization path from hand-written SQL rules to real `mappings` rows —
  **was** verified, against a real Postgres 16 instance (installed directly in the sandbox via
  apt, since even `postgres:16` from Docker Hub was unreachable). See
  [`milestones.md`](./milestones.md) for exactly what was and wasn't verified per milestone.

## Timeline

1. Read the spec, entered plan mode, produced and got sign-off on the design checkpoint above.
2. **Milestone 1** (ingest only): TorBox client, full §4 schema via migrations, ingest
   pipeline. Committed, pushed.
3. Asked to also commit the plan document itself (it had only existed as an in-session plan-mode
   artifact until then) — added as `torbox-ru-addon-plan.md` with a status callout noting what
   had since shipped or deviated from the original proposal.
4. Given the go-ahead for **Milestone 2** (two hand-written SQL rules, verify `expandRule`).
   While implementing, found that `continuous` numbering doesn't actually need the extractor
   cascade the way the original plan assumed — it's pure position/offset arithmetic — so it
   shipped alongside `sequential`/`manual` instead of waiting for Milestone 5. Verified
   end-to-end against real hand-written SQL using the actual torrent examples from spec §1.
   Committed, pushed.
5. Asked how to proceed into Milestone 3, given that milestone's own success criterion ("confirm
   actual playback... in real Stremio and AIOStreams") needs the repo owner's real TorBox
   account and deployed instance, not something achievable from the build sandbox.
6. Asked instead to record this history, the decisions made, and milestone status in the repo's
   GitHub wiki. Wiki write access turned out not to be available to this session (GitHub wikis
   have no REST/GraphQL API — they're a separate git repo, `<repo>.wiki.git`, and neither a
   direct git push nor this session's repo-access mechanism could reach it). This `docs/`
   directory is the resulting alternative: the same content, committed to the main repo instead,
   copyable into the wiki by hand in a couple of minutes if still wanted there.

## See also

- [`torbox-ru-addon-spec.md`](../torbox-ru-addon-spec.md) — the original spec, unmodified.
- [`torbox-ru-addon-plan.md`](../torbox-ru-addon-plan.md) — the full pre-code design checkpoint.
- [`decisions.md`](./decisions.md) — every decision made, with spec cross-references.
- [`milestones.md`](./milestones.md) — status of all six build-order milestones.
- [`../README.md`](../README.md) — current setup/run/test instructions.
