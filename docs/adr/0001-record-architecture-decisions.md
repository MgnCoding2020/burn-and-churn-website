# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

This project is a security portfolio piece: a reviewer should be able to see not only what was built but why, and what each choice costs. Decisions made in chat or in commit messages are hard to find later. The program's change-control process (hub CM-3) also expects significant changes to be recorded with their reasoning.

## Decision

Significant technical and design decisions are recorded as short, numbered markdown files in `docs/adr/`, using this shape: Status, Date, Context, Decision, Consequences. A record is never rewritten after acceptance. A changed decision gets a new record, and the old one is marked "Superseded by ADR-NNNN".

A decision needs a record when it adds a dependency, a cloud resource, a permission, or a security control, or when it changes the plan in `README.md`.

## Consequences

- Reviewers can trace each control to the reason for it.
- Records add a small cost to each significant change; the PR that makes the change includes its record.
