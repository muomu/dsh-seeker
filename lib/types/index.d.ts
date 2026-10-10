/**
 * dsh-seeker host 半区（v3 重构）：注册 /seeker/api 直连路由——面板数据
 * 通道（列表/详情/上下文/saved views/创建）零模型零会话；「加载」(/load)
 * 是唯一会创建会话的操作，把完整 issue 注入为一个新会话的第一条可见用户
 * 消息。client 半区经同源相对 fetch 直连这些路由。
 * @module dsh-seeker
 */
import type { Context } from '@deepseek-ai/cordis';
export { createSeekerRouteHandler, handleSeekerApi, loadIssueSession, SEEKER_API_ROUTE } from './api.ts';
export * from './data.ts';
/** host 入口：注册 /seeker/api 直连路由（webServer 可选服务，探针 + 订阅）。
 * 「加载」需要 agents/sessions/agentDefaultModel 创建会话，并用
 * workspaceRegistry 把新会话挂到项目所在的工作区（GUI 分组）。 */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
