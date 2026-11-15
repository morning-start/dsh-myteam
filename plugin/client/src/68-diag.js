
    /** CHG-76 C：无人可领的一键修复（诊断 fix: assignable / roleSwap / spawnRole）
     *  - assignable 非空 → 每个空闲队员一个「一键指派 <队员>」（assignTask）
     *  - roleSwap 非空 → 「改用已有人角色」下拉（选中即 updateTask patch.requiredRole）
     *  - 都没有但有 spawnRole → 纯提示「去召唤 <角色> 成员」（不自动执行）
     *  离线/只读：按钮 disabled + title 用既有只读文案。 */

    /** 剪贴板（建队指令复制；不可用时降级 execCommand） */