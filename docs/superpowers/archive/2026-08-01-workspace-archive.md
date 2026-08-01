# 2026-08-01 重构前工作区归档

## 当前基线

- 当前分支：`main`
- 基线提交：`07fc25ae394f42ed0f11b5b314286327fdf7e660`
- `main` 由原 `codex/upload-initial-code` 重命名而来。
- 远程分支 `origin/codex/upload-initial-code` 未修改、未删除、未推送。
- 当前主工作树已清洁：没有已跟踪或未跟踪修改。

## 已归档的旧分支提交

旧分支已删除，但提交由以下本地 tag 保留：

- `archive/pre-refactor/codex-upload-initial-code` → `07fc25ae394f42ed0f11b5b314286327fdf7e660`
- `archive/pre-refactor/worktree-dnd-ui-refactor` → `3b8444ed3a77ef145b474b12e32743327bf6520d`
- `archive/pre-refactor/worktree-st-three-pipeline` → `0d9a2f816c79ea0f82a46044238d3b2f6e11668e`

## 已归档的未提交修改

Git stash 保留了三个工作树的未提交内容：

- 主工作树：`9c7c3605c8651e5899c6ddb92ab2fdec70af6454`
  - stash message: `pre-refactor main worktree uncommitted files 2026-08-01`
- UI 工作树：`bdf00d8883a9e30345f6644c257b99ed917c22bc`
  - stash message: `pre-refactor UI worktree 2026-08-01`
- 管线工作树：`3c0c4d691d801b8bb9d805681482d035c5197cd7`
  - stash message: `pre-refactor pipeline worktree 2026-08-01`

## 被忽略文件归档

无法由 Git stash 完整处理的本地日志、MCP 文件和残留工作树文件已复制到：

```text
G:\Users\admin\desktop\code\dnd-pre-refactor-archive-2026-08-01
```

目录包括：

- `main-ignored/`
- `pipeline-ignored/`
- `pipeline-residual/`

原工作区中的对应日志和 MCP 目录已加入 `.gitignore`；旧工作树目录和旧本地分支已清理。

## 恢复原则

- 恢复提交：使用对应 `archive/pre-refactor/*` tag；
- 恢复未提交修改：使用对应 stash commit；
- 恢复被忽略文件：从外部归档目录复制回原路径；
- 不要使用 `git stash pop` 覆盖新重构代码，应先创建临时恢复分支或临时工作树。
