import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { type ContextFormed } from '@deepseek-ai/dsh-llm';
/**
 * dsh 0.1.7-rc.2 的 MessageSource 是开放可合并的判别联合：每个生产者在自己
 * 的模块里声明自己的 `kind`（不再有共享的 `kind: 'plugin'` 兜底），`form`
 * 与必填字段分离（此处两条注入都是「刚发生的一次性交代」= notice，需带一行
 * summary）。模块增强让 `createUserMessage` 的 source 接受本插件的 kind；
 * 客户端对未知 kind 回退到裸 kind 标签，notice 形态则正常呈现。
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** dsh-seeker 注入的上下文：skr skill 全文 / issue 上下文。 */
        'dsh-seeker': {
            kind: 'dsh-seeker';
        } & ContextFormed;
    }
}
/** 路由前缀（注册到 webServer，longest-prefix 优先于 /api 桥）。 */
export declare const SEEKER_API_ROUTE = "/seeker/api";
/** 「加载」操作：创建新会话并把 issue 注入为其第一条可见用户消息，返回 sessionId。
 * 创建配方对齐宿主 apiproxy 的 composeAgent：create 之前 resolve agent preset
 * （id 写进 meta.agentPreset——session boundary 在异步 setup 开始前就快照 meta），
 * setup 内 installModelSelection + agentPresets.mount。web 部署下工具/AGENTS.md
 * 指令/skill catalog/persona 等模型面行都在 agent preset 层（宿主全局层禁用），
 * 不 mount 的会话到达模型时没有任何工具与 prompt 段；mount 后这些上下文由 preset
 * 层 pre-step 监听器在第一个请求前随首 step 批次注入（先于/随同 issue 消息）。
 * 无 preset roster 的部署（如 headless）不 mount，宿主全局层自然覆盖。
 * @param workspace - 项目所属的 Seeker workspace（see/TPG/VAN）；非空时把会话
 *   工作目录绑定到该 workspace（写 .seeker/workspace.json），使会话的 skr
 *   操作落在正确 workspace。
 * @param cwd - 会话工作目录；缺省沿用当前进程目录。
 * @param model - 会话使用的模型（provider + model id）；缺省用默认模型选择。 */
export declare function loadIssueSession(ctx: Context, issueId: string, opts?: {
    workspace?: string;
    cwd?: string;
    model?: {
        provider: string;
        model: string;
    };
}): Promise<{
    sessionId: string;
}>;
/** 处理一次 /seeker/api 请求（导出供测试）。 */
export declare function handleSeekerApi(method: string, pathname: string, params: URLSearchParams, bodyText: string): Promise<{
    ok: true;
    data: unknown;
} | {
    ok: false;
    error: string;
}>;
/** webServer 路由处理器（注册用）。ctx 用于「加载」操作创建会话。 */
export declare function createSeekerRouteHandler(ctx?: Context): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
