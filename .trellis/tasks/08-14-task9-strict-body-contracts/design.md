# Design: Task 9 Strict Body and Contract Inventory

> **Status: Deferred.** Retained for a later contract-hardening milestone; do not implement now.

## Scope and dependency

Task 9 hardens the existing contract boundary and records parser coverage. It starts implementation only after Task 8's CSRF seam is accepted, so the inventory can describe the actual admission order. Rate limiting is deferred and is not represented in this design.

## Contract strategy

### Request schemas

For each named module (`auth`, `campaign`, `character`, `world`, `turn`, `combat`, `ai`, `archive`, and `rules`):

- make externally accepted object schemas `.strict()`;
- add max lengths to user-controlled strings;
- add max counts and item bounds to arrays;
- bound records and nested payloads using the largest existing normal fixtures and the route's parser budget;
- preserve intentional domain maps such as character sheets, derived data, AI context, and rule content, applying transport bounds without changing their domain meaning.

Where a schema is shared by persistence or internal service code, introduce the narrow external schema or wrapper rather than weakening internal semantics. Do not use client-side stripping as a server validation mechanism.

### Response schemas

Make current sensitive auth/session and platform response envelopes strict, including client-side wrappers. Keep intentionally broad domain data as explicitly bounded `unknown`/record fields where the existing contract requires it. Tests must verify that extra fields in sensitive DTOs fail without exposing secrets.

## Parser inventory

Add a declarative route contract registry next to the existing body-budget implementation. The registry records every current mutating route's method/path family, bodyless status or parser label, strict schema, and required CSRF/admission stage. The inventory test compares route registrations against declarations and fails for an undeclared new mutation.

The registry must not create future bootstrap/invite/admin/maintenance routes. It only establishes the seam those later routes must use.

## Validation strategy

- Contract tests cover unknown keys and boundary values for every named module, including nested payloads.
- HTTP tests prove unknown keys are rejected after admission but before service execution, and oversized bodies are rejected by the explicit parser budget.
- Route inventory tests cover bodyless mutations and all current POST/PUT/PATCH/DELETE routes.
- Existing AI/context/character fixtures and Task 7 security tests are compatibility gates.

## Compatibility and rollback

No data migration or service/domain change is required. If an identified bound rejects a valid existing fixture, adjust only that bound to the documented fixture-supported maximum. Never remove `.strict()` globally to resolve an individual compatibility issue. Future route families consume the registry in their own tasks.
