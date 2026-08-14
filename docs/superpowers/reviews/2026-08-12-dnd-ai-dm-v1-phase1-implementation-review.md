# DND AI-DM v1 Phase 1 实施审查

审查日期：2026-08-12  
实施计划：[`2026-08-12-dnd-ai-dm-v1-phase1-legacy-removal.md`](../plans/2026-08-12-dnd-ai-dm-v1-phase1-legacy-removal.md)  
实施证据：

- [`phase1-implementation-worker.md`](../validation/phase1-implementation-worker.md)
- [`phase1-fix-worker.md`](../validation/phase1-fix-worker.md)
- [`phase1-final-fix-worker.md`](../validation/phase1-final-fix-worker.md)
- 主线程最终验证：`.pi/phase1-final-validation/`

## 最终结论

> **PASS / 0 Blocker / 0 Major / 3 dispositioned Minor**

Phase 1 已按批准计划完成实施。最终 fresh-context correctness/operability 与 security/data/tests 双 lane 独立 signoff 均达到实施门槛：无 Blocker、无 Major。主线程随后直接重跑所有最终验证门并复核数据、migration 与 staging 状态。

## 审查过程

1. 唯一 writer 按 Task 1-6 串行完成 RED→GREEN；Task 7 跑聚合门。
2. 四个 fresh-context reviewer 分别检查 correctness/architecture、security/data safety、operability/build、tests/client/scope。
3. 首轮发现的 manifest、shutdown、lock fsync、Provider redirect/status、signal window、client proxy/doc 等 Minor 由唯一 fix worker 修复。
4. 三个 fresh-context post-fix reviewer 复审 startup/lifecycle、manifest/lock/Provider 与全局 scope；剩余 instrumentation、exit diagnostics、真实 Node listener、Provider URL boundary、partial lock cleanup、browser proxy Minor 再由唯一 final-fix worker 修复。
5. 最终两个 fresh-context reviewer 对完整当前 tree 独立 signoff。
6. 主线程亲自执行最终全量 tests/typecheck/build/Chromium 和 baseline/hash/staging 检查。

## 已验证的核心实现

- `createPlatformApp` 只接收 `DatabasePort`，显式返回 `{ app, realtimeRuntime }`；生产只有平台组合根。
- legacy server routes/services/db/domain runtime 与冻结的 legacy tests 已删除；production/test-support import guards 和 dist artifact scan 通过。
- legacy client island 已删除；`/admin/:roomId`、`/player/:token` 命中 `NotFoundPage`，不 redirect、不发 legacy 请求。
- Provider transport 每次 attempt 恰好一次 HTTP 请求；无 retry/maxAttempts；保留 timeout、manual redirect、secret redaction、SSE-tolerant parse，并清理 base URL query/hash。
- InstanceLock 在 DB open 前使用 `wx` + 0600 + fsync；stale/corrupt fail closed；partial write 清理自身文件；token-verified release；DB close 后最后释放。
- migration manifest 对 source/dist 做 canonical exact set、normalized-LF SHA-256、duplicate/hash/rogue SQL 严格检查；build 清理 `server/dist` 后复制并验证 001-011。
- ciphertext 存在时 credential gate 只 load key 并 decrypt-all；missing/corrupt/wrong key 或任意坏 envelope 均在 listener 前失败且不写 key/ciphertext。
- startup coordinator 固定顺序：lock → manifest → DB open → migrate → credential → app → listen；shutdown 固定为 stop accepting → realtime close → force connections → DB close → lock release，且各步异常隔离。
- SIGINT/SIGTERM 在 startup 前注册；启动/关闭失败提供粗粒度、无堆栈诊断并以非零码退出。
- existing legacy-bearing sentinel 的 DDL/rows 保持不变；fresh DB 不创建 legacy objects。

## 主线程最终验证

```text
npm test -- --maxWorkers=1
  527 passed / 22 skipped / 0 failed

npm run typecheck
  PASS

npm run typecheck --workspace @dnd/contracts
  PASS

npm run build
  PASS

npm run test:phase4-browser
  15 steps PASS
```

其它直接证据：

- `git diff --cached --name-only`：空。
- migration SQL 集合：精确 001-011；无 012。
- 001-011 raw SHA-256：全部匹配实施前 baseline。
- 最终验证运行前后，默认 `dnd.sqlite*`、`server/dnd.sqlite*`、真实 credential key 和 `.dnd-instance.lock` 全部保持不变。
- 实施前 baseline 相比最终状态，只有 `server/dnd.sqlite-shm` 曾在 14:40Z 被实施前已存在的 `tsx watch` 进程触发的默认 DB 打开重建；`server/dnd.sqlite` 与 WAL hash 均未变化。最终主线程验证前后该 SHM 也保持完全不变。

## Minor disposition

1. `MigrationRunner.ts` 有一处中英混合 docstring：纯文档外观，不影响行为，接受。
2. `server/.dnd-instance.lock` 与 `.tmp-dev-*` 属于 gitignored 环境残留；fail-closed 行为正确。当前 watcher PID 27148 是实施前既有进程，本轮未擅自停止或删除 lock；由用户/运维确认后处理。
3. `defaultListen` export 与 `PlatformListener.server?` 是真实 Node listener 测试的观测 seam，production coordinator 不使用该属性，接受。

## 未纳入范围

- migration 012、platform_instance、enrollment/fingerprint、secure sessions、CSRF/Origin/CORS hardening、maintenance、backup/drop CLI、Phase 7 request/AI drain、production SPA artifact gate均仍属后续阶段。
- `state-change-materializer.test.ts` 同毫秒排序 flake 为既有风险；最终全量测试未复现，本 Phase 未修改该文件。

> **PHASE 1 IMPLEMENTATION APPROVED — PASS / 0 BLOCKER / 0 MAJOR**
