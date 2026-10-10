/**
 * Seeker 工作台覆盖层（v3 重构，确定性 client UI）：
 * - 挂载：shell.overlay（root 作用域框架级覆盖层）；面板**全局居中**、尺寸为
 *   3:2（宽:高，top/bottom 边距收窄，按视口自适应），整页模态 backdrop 点击外部关闭；
 * - 数据：同源相对 fetch /seeker/api/*（零模型、零会话）；
 * - 视图：列表（搜索/筛选/saved view/无限滚动/刷新，saved view 支持分组列表 ↔
 *   只读看板显示切换，按 workspace+view 记忆）↔ 详情（元数据/markdown
 *   正文/评论/标签/外链），栈内导航；视图 Tab 首位「📥 收件箱」（**当前用户
 *   名下**的待办 + 精确总数，--all 追加 in_review/done，同样支持**分组列表 ↔
 *   只读看板**显示切换，无筛选/搜索/分页）；
 * - 状态：workspace 持久化（localStorage）+ 浏览位置内存恢复；错误卡 + 重试；
 *   ESC / 关闭按钮 / 点击面板外部（全屏模态 backdrop）退出；
 * - 视觉：表面玻璃拟态——安装并启用 dsh-client-ui-aqua 时深度适配其玻璃卡片配方，
 *   否则回退到应用通用毛玻璃（--dsw-alias-bg-mask-drop + blur(10px)）。
 */
import { type ReactNode } from 'react';
/** SessionSummary/SessionListState 的宽松面（只取本插件用到的字段）。 */
export interface SessionListSnapshot {
    ids: readonly string[];
    byId?: Record<string, {
        id?: string;
        cwd?: string;
        /** 本地引用来源计数（ISessions.retain）；mainView = 当前主视图会话。 */
        retainedBy?: Readonly<Record<string, number>>;
    }>;
}
/** 会话导航面：list 读目录快照，openSession 切主视图（由 client/index.tsx 组装）。 */
interface LoadSessions {
    openSession(id: string): void;
    list: {
        getSnapshot(): SessionListSnapshot;
    };
}
export type { LoadSessions };
/** 宽松 workspaces 面（WorkspaceRuntime.list 快照：items 为 WorkspaceView）。 */
interface LooseWorkspaces {
    list: {
        getSnapshot(): {
            items: Array<{
                workspaceId: string;
                path: string;
                title: string;
            }>;
        };
    };
}
/** 宽松模型目录面（ModelDirectoryResolver.directoryFor → per-session ModelDirectory）。 */
interface LooseModelDirectories {
    directoryFor(sessionId: string): {
        load(): Promise<unknown>;
        store: {
            getSnapshot(): {
                groups: Array<{
                    id: string;
                    name: string;
                    models: Array<{
                        id: string;
                        name: string;
                    }>;
                }>;
                status: string;
            };
        };
    };
}
/** 读取当前会话的工作目录（cwd）——「加载」创建的新会话用它作为工作目录，
 * 并把 .seeker/workspace.json 绑定写到该目录，使新会话落在项目所在 workspace。 */
export declare function currentSessionCwd(sessions: LoadSessions): string | undefined;
/** 打开新会话：轮询会话目录直到新 id 出现，再 openSession（避免宿主对未知 id
 *  的 retain 直接抛错）。兜底仍尝试一次，失败静默（调用方已有失败提示）。 */
export declare function openLoadedSession(sessions: LoadSessions, sessionId: string): Promise<void>;
/**
 * shell.overlay 覆盖层条目：打开时渲染全屏工作台，关闭时渲染 null。
 * 层本身 click-through，本条目根部恢复 pointer-events（`>*` 已由框架处理）。
 */
export declare function SeekerOverlayEntry({ sessions, workspaces, modelDirectories }: {
    sessions?: LoadSessions;
    workspaces?: LooseWorkspaces;
    modelDirectories?: LooseModelDirectories;
}): ReactNode;
