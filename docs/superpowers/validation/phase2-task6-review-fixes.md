# Phase 2 Task 6 Independent Review Fixes

This file records the first independent-review fix pass. It is superseded for final test evidence by the present canonical repository file `docs/superpowers/validation/phase2-task6-final-test-hardening.md`.

Summary: provisional pre-header runtime binding closes the final-check/notifier gap; real logout-commit header/frame races are covered; notifier and per-client close/destroy exceptions are isolated; pinned CA explicitly enforces `rejectUnauthorized:true`; expiry/quiescent/rollback, shutdown, SSE abort handling, campaign watermarks, and retry cap coverage were added.

The later final review correctly found remaining test-evidence weaknesses: the original wrong-CA test used a separate dispatcher and malformed PEM, abort cleanup could occur before SSE readiness, several new waits were unbounded, and tracked-stream closure still swallowed arbitrary errors. The final test-hardening and operability passes replace those claims with regression-sensitive shared-dispatcher TLS coverage using a valid unrelated certificate, ready-before-abort cleanup, fully settled tracked-stream outcomes with explicit expected-close arming, bounded waits/reads/cleanup, required runtime registration, repeated invalid-token exactly-once coverage, and restored client mocks.

Historical validation for this pass: focused 8 files / 106 passed; wider 8 files / 50 passed; full 76 files passed / 2 skipped, 647 passed / 22 skipped / 0 failed; all three typechecks passed; staging empty; default artifact hashes unchanged; locks/root key absent. Current final operability results are recorded only in the canonical final hardening file and still require independent re-review.

TDD wording: the initial missing `SessionAuthority` module was a structural/import RED, not a behavioral RED. The original Task 6 was not wholly strict TDD; only actually observed RED results are claimed.
