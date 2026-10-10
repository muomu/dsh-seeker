/**
 * Seeker 工作台 client 状态（v3 重构）：模块级内存 store。
 * - open：覆盖层是否打开（侧边栏按钮 ↔ 覆盖层组件跨槽位共享）；
 * - 浏览位置：workspace / 列表 or 详情 / 详情 id —— 关闭再打开恢复（内存态，
 *   刷新丢失）；workspace 与 savedView 另由 localStorage 持久记忆。
 * - saved view 全量结果：会话缓存（workspace+view 键），手动刷新失效。
 * 零依赖：useSyncExternalStore 直接订阅。
 */
import type { IssueRow } from './api.ts';
export interface WorkbenchState {
    open: boolean;
    /** 当前 workspace key（localStorage 持久）。 */
    workspace: string;
    /** 最近一次进入的 saved view id；'' 表示默认列表（localStorage 持久）。 */
    savedView: string;
    /** 当前视图：list | detail。 */
    view: 'list' | 'detail';
    /** detail 视图下的 issue id。 */
    detailId: string | null;
}
export type ViewDisplayMode = 'list' | 'kanban';
/** 读取指定 workspace+view 的记忆显示模式（默认分组列表；view 为空恒为列表）。 */
export declare function getViewDisplay(workspace: string, view: string): ViewDisplayMode;
/** 记忆指定 workspace+view 的显示模式（列表为默认，直接移除条目）。 */
export declare function setViewDisplay(workspace: string, view: string, mode: ViewDisplayMode): void;
export interface LoadDefaults {
    /** 会话工作区目录（DSH workspace path，新会话 cwd）。 */
    workspacePath?: string;
    /** 模型提供者 route id。 */
    provider?: string;
    /** 模型 id。 */
    model?: string;
}
/** 读取上次「加载」的选择（可能为空对象）。 */
export declare function getLoadDefaults(): LoadDefaults;
/** 记忆本次「加载」的选择（供下次弹窗默认选中）。 */
export declare function setLoadDefaults(defaults: LoadDefaults): void;
type Listener = () => void;
/** 打开/关闭覆盖层。 */
export declare function setOpen(open: boolean): void;
/** 切换 workspace（同时重置浏览位置到列表）。 */
export declare function setWorkspace(workspace: string): void;
/** 记录最近进入的 saved view（'' = 默认列表；localStorage 持久，下次打开恢复）。 */
export declare function setSavedView(savedView: string): void;
/** 打开详情视图（记忆浏览位置）。 */
export declare function openDetail(id: string): void;
/** 返回列表视图。 */
export declare function backToList(): void;
export declare function getState(): WorkbenchState;
export declare function subscribe(fn: Listener): () => void;
/** 读取会话缓存（view 为空或未命中返回 null）。 */
export declare function getViewCache(workspace: string, view: string): IssueRow[] | null;
/** 写入会话缓存（超上限整体清空，简单 FIFO 语义）。 */
export declare function setViewCache(workspace: string, view: string, items: IssueRow[]): void;
/** 失效指定 workspace+view 的缓存（刷新按钮调用）。 */
export declare function clearViewCache(workspace: string, view: string): void;
export {};
