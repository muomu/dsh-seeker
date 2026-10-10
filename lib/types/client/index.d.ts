/**
 * dsh-seeker browser half（v3 重构，确定性 client UI）：
 * 1) 侧边栏底部（sidebar.footer.action）注册「Seeker」入口按钮——点击切换
 *    工作台覆盖层开关（shell.overlay）。
 * 2) shell.overlay（root 作用域框架级覆盖层）注册工作台条目——打开时渲染
 *    全屏 Seeker 工作台（列表 ↔ 详情，零模型、零会话，/seeker/api 直连）。
 * 3) conversation.input.dock（list/session 作用域）注册「我认领的 issue」栏——
 *    仅在 hero（空白新会话页）渲染一排 issue chip，点击即 /load 建新会话并切换。
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis client entry。inject 声明 slots + sessions + workspaces + modelDirectories
 * + uiWorkspace（硬门控：未声明的服务一读即抛）。workspaces 提供「加载」弹窗的
 * 工作区列表，modelDirectories 提供模型列表，uiWorkspace.openSession 负责切到
 * 新建的会话（dsh 0.1.7-rc.2 起会话导航归 ui-workspace，ISessions 不再有 open）。 */
export declare function apply(ctx: Context): () => void;
export declare const inject: string[];
