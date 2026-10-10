/**
 * Seeker 工作台 client 数据通道（v3 重构）：同源相对 fetch /seeker/api/*。
 * 零会话、零模型；与 task-status 的 /plugins/* 路由同款做法。
 */
export interface WorkspaceRow {
    id: string;
    key: string;
    name: string;
}
export interface ProjectRow {
    id: string;
    key: string;
    name: string;
    status?: string;
}
export interface LabelGroup {
    id: string;
    name: string;
    values: string[];
}
export interface SavedViewRow {
    id: string;
    workspaceId: string;
    name: string;
    scope?: string;
    ordering?: string;
    orderDir?: string;
}
export interface IssueRow {
    id: string;
    type?: string;
    title?: string;
    status?: string;
    priority?: string;
    labels?: string[];
    assigneeIdentity?: {
        displayName?: string;
    };
    assignee?: string;
    reporterIdentity?: {
        displayName?: string;
    };
    reporter?: string;
    createdAt?: string;
    updatedAt?: string;
}
export interface IssueComment {
    id: string;
    authorId?: string;
    authorDisplayName?: string;
    bodyText?: string;
    createdAt?: string;
    kind?: string;
    agent?: string;
}
export interface IssueDetail {
    id: string;
    workspaceId?: string;
    type?: string;
    title?: string;
    status?: string;
    priority?: string;
    project?: string;
    delivery?: string;
    labels?: string[];
    assignee?: string;
    reporter?: string;
    assigneeIdentity?: {
        displayName?: string;
    };
    reporterIdentity?: {
        displayName?: string;
    };
    bodyText?: string;
    comments?: IssueComment[];
    createdAt?: string;
    updatedAt?: string;
}
export interface FetchContextResult {
    workspaces: WorkspaceRow[];
    projects: ProjectRow[];
    labels: LabelGroup[];
    views: SavedViewRow[];
    /** 元数据实际覆盖的 workspace（未指定请求时为第一个 workspace，无则缺省）。 */
    workspace?: string;
}
/** 拉取上下文：workspace 列表 + 指定 workspace 的项目/标签/saved views。 */
export declare function fetchContext(workspace?: string): Promise<FetchContextResult>;
/** 拉取上下文（命中 client TTL 缓存则直接返回；结果按实际覆盖的 workspace 缓存）。 */
export declare function fetchContextCached(workspace?: string): Promise<FetchContextResult>;
/** 列表或搜索（query 存在走 search；view 存在走 saved view；allPages 走全量翻页）。 */
export declare function listIssues(params: {
    workspace?: string;
    query?: string;
    all?: boolean;
    /** 全量翻页聚合（saved view 分组用）：host 循环 --page 直到短页。 */
    allPages?: boolean;
    status?: string;
    type?: string;
    project?: string;
    labels?: string[];
    view?: string;
    limit?: number;
    page?: number;
}): Promise<{
    items: IssueRow[];
}>;
/** 单条 issue 详情。 */
export declare function getIssue(id: string): Promise<{
    issue: IssueDetail;
}>;
/** 「我认领的 issue」（hero 栏数据源）：当前用户 + 当前绑定 workspace，
 * host 侧按优先级排序取前 10；workspace 为当前绑定 key（供「加载」沿用）。 */
export declare function listMine(): Promise<{
    items: IssueRow[];
    workspace?: string;
}>;
export interface InboxResult {
    /** 收件箱总条数（全量取回，即 items.length）。 */
    total: number;
    items: IssueRow[];
}
/** 收件箱（个人维度）：当前登录用户名下、当前 workspace 的待办 + 总数
 * （whoami → issue list --assignee，host 全量翻页取回）；all=true 追加
 * in_review/done（仍排除 closed/canceled）。 */
export declare function fetchInbox(params: {
    workspace?: string;
    all?: boolean;
}): Promise<InboxResult>;
/** 「加载」：创建新会话并注入 issue，把会话工作目录绑定到 project 所属的
 * Seeker workspace（see/TPG/VAN），返回新会话 id。
 * @param id - issue 编号。
 * @param opts.workspace - 项目所属的 Seeker workspace（host 用它写 .seeker/workspace.json）。
 * @param opts.cwd - 会话工作目录（host 用它做会话 meta.cwd 并写入绑定；缺省沿用进程目录）。
 * @param opts.model - 会话使用的模型（host 用它建会话；缺省用默认模型选择）。 */
export declare function loadIssue(id: string, opts?: {
    workspace?: string;
    cwd?: string;
    model?: {
        provider: string;
        model: string;
    };
}): Promise<{
    sessionId: string;
}>;
