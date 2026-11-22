# cutover 执行记录（2026-11-22）

## 对象

- 工作区：`E:\Workplace\extension\dsh-myteam`
- 旧布局：v1（`.dsh-myteam/manifest.json` schemaVersion 1，团队账本在 `state/teams/*/ledger.jsonl`）
- 执行前状态：**无写者租约**（`state/writer.lock` 不存在）

## 执行

```bash
node tools/myteam-cutover.mjs --root "E:\Workplace\extension\dsh-myteam" \
  --apply --confirm --backup "E:\Workplace\extension\dsh-myteam\.agents\backups\2026-11-22"
```

演练阶段输出：`ready=true`、6 步计划、`blockers=[]`；随后同一命令执行切换。

## 结果

| 项 | 值 |
|---|---|
| 新 manifest | `schemaVersion: 2`、`layoutVersion: 2`、`projectId: prj_291ab0095c77404aa4631894ab30198d` |
| 只读校验 | `seq=3`、`teams=0`、`members=0`、`tasks=0`、`knowledge=0` |
| `migration.json` | 已写入，含 `sourceHashes`（来源团队 `default` 等） |
| 备份 | `E:\Workplace\extension\dsh-myteam\.agents\backups\2026-11-22\.dsh-myteam.bak`（旧 v1 全目录） |

`teams=0` 符合分析结论：源数据里 `b5`、`b5-dogfood` 两个索引条目没有对应账本（索引孤儿），不会被迁移；
`default` 只有规则版本事件，不构成团队。**没有团队/任务丢失**——它们本来就不存在账本。

## 回滚

```powershell
Remove-Item "E:\Workplace\extension\dsh-myteam\.dsh-myteam" -Recurse -Force
Copy-Item "E:\Workplace\extension\dsh-myteam\.agents\backups\2026-11-22\.dsh-myteam.bak" `
          "E:\Workplace\extension\dsh-myteam\.dsh-myteam" -Recurse
```

## 后续

- 用 v2 插件打开该工作区即可看到 v2 项目（当前无团队，可从建队开始）；
- 若要恢复 v1 的团队，回滚后重新分析（索引孤儿需先修复）；
- 备份目录建议在确认无回滚需求后手动删除。