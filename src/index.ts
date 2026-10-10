/**
 * dsh-seeker host 半区（v3 重构）：注册 /seeker/api 直连路由——面板数据
 * 通道（列表/详情/上下文/saved views/创建）零模型零会话；「加载」(/load)
 * 是唯一会创建会话的操作，把完整 issue 注入为一个新会话的第一条可见用户
 * 消息。client 半区经同源相对 fetch 直连这些路由。
 * @module dsh-seeker
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSeekerRouteHandler, SEEKER_API_ROUTE } from './api.ts'

export { createSeekerRouteHandler, handleSeekerApi, loadIssueSession, SEEKER_API_ROUTE } from './api.ts'
export * from './data.ts'

/** host 入口：注册 /seeker/api 直连路由（webServer 可选服务，探针 + 订阅）。
 * 「加载」需要 agents/sessions/agentDefaultModel 创建会话，并用
 * workspaceRegistry 把新会话挂到项目所在的工作区（GUI 分组）。 */
export const inject = ['webServer', 'agents', 'sessions', 'agentDefaultModel', 'workspaceRegistry']

export function apply(ctx: Context): void {
  let routeRegistered = false
  const tryRegisterRoute = (value: { register(route: unknown): unknown } | undefined): void => {
    if (routeRegistered) return
    const webServer = value ?? (ctx.reflect.get('webServer', false) as { register(route: unknown): unknown } | undefined)
    if (webServer === undefined) return
    webServer.register({
      kind: 'prefix',
      path: SEEKER_API_ROUTE,
      handler: createSeekerRouteHandler(ctx),
    })
    routeRegistered = true
  }
  tryRegisterRoute(undefined)
  ctx.on('internal/service', (name: string, value: unknown) => {
    if (name === 'webServer') tryRegisterRoute(value as { register(route: unknown): unknown })
  })
}
