/**
 * 随包 skill：给模型看的「人类动作怎么走」。
 *
 * 卡片只能由「本会话加载了某个 kind 的 skill」后调用 propose_action 触发，
 * 所以这段文字不是装饰：没有它，动作卡片永远不会出现。
 */
export const inject = ['skills']

export const MYTEAM_HUMAN_ACTIONS_SKILL = `---
name: myteam-human-actions
description: 在 myteam 项目里发起需要人类确认的动作（解散团队、队长接管）。先预览影响面，再提议一张动作卡片让人类点确认。
---

# myteam 人类动作

解散团队与队长接管是**人类专属**动作，模型不能直接执行，也不能代替人类确认。

## 什么时候用

- 用户说「解散这个团队 / 把这个团队关掉」；
- 用户说「把队长换给某个会话 / 由我接管」。

## 步骤

1. 先调用预览工具拿到影响面（只读，不写事件）：
   - 解散：\`myteam_preview_disband\`，参数 \`teamId\`；
   - 接管：\`myteam_preview_takeover\`，参数 \`teamId\`、\`toSessionId\`。
2. 把返回里的 \`summary\` 与 \`impact\` 简要讲给用户听。
3. 调用 \`propose_action\`，参数：
   - \`action\`：\`myteam.human\`
   - \`title\`：一句话说明要做什么
   - \`brief\`：影响面摘要（来自预览）
   - \`details\`：\`{ "action": "disband" | "takeover", "teamId": "...", "toSessionId": "...", "summary": "...", "targetHash": "..." }\`
4. 人类点确认后，宿主会用同一个 \`targetHash\` 重算并执行；**你不要**再调用任何写工具。

## 边界

- 预览之后项目状态变了，确认会被拒绝——这时重新预览、重新提议；
- 不要在子代理里提议卡片，也不会生效；
- 不要伪造 \`targetHash\` 或 \`summary\`。
`

export function apply(ctx: {
  skills?: { register(skill: unknown): () => void }
}): (() => void) | undefined {
  if (ctx.skills === undefined) return undefined
  return ctx.skills.register({
    name: 'myteam-human-actions',
    description: '发起需要人类确认的 myteam 动作（解散团队、队长接管）：先预览影响面，再提议动作卡片。',
    content: MYTEAM_HUMAN_ACTIONS_SKILL,
    source: 'custom',
    invocation: { modelInvocable: true, userInvocable: true },
  })
}

export default apply