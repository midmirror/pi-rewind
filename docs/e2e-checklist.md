# pi-rewind 人工回验清单（TUI 会话）

前置：`~/.pi/agent/extensions/pi-rewind/` 已就位，`pi` 新会话。

- [ ] 1. 两轮编辑后 `/rewind` → 列表显示各点 diff（+N/-N 行）与文件数；
- [ ] 2. 选中第 1 条 → 确认「代码+会话」 → 磁盘文件回退（`git diff` 检查）、leaf 跳转、输入框回填原始提示、⚠ 警告可见；
- [ ] 3. 受警告语义：第二轮含 `bash` 直接改文件（echo > file）→ rewind 后 bash 改动仍在；
- [ ] 4. fork 恢复：`/tree` 切分支后对新分支 `/rewind`，旧分支快照仍可恢复（全局备份目录共享）；
- [ ] 5. 重启 pi 恢复会话，`/rewind` 历史点仍列出（entry 持久化）；
- [ ] 6. `~/.pi/agent/pi-rewind/backups/` 目录结构符合预期（{hash}@vN 文件，无孤儿堆积）。
