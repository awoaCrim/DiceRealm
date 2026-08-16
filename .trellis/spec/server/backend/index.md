# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |
| [AI Structured Turn Output](./ai-structured-output.md) | Provider-neutral turn-resolution contract and safe diagnostics | Active |
| [Turn Entry Projection](./turn-entry-projection.md) | Audience projection and per-turn entry lookup | Active |
| [Schema Reset Boundary](./schema-reset-boundary.md) | Safe removal of a persisted feature without silent database mutation | Active |
| [Runtime Contract & State Safety](./runtime-contract-state-safety.md) | Context visibility, typed state changes, campaign revision CAS, AI stale-result rejection, and mutation provenance | Active |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
