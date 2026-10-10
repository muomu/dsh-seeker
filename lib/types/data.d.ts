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
export interface FetchContextArgs {
    workspace?: string;
}
export interface ListIssuesArgs {
    workspace?: string;
    query?: string;
    /** --all：全部状态（单页语义，配合 limit）。 */
    all?: boolean;
    /** 全量翻页：循环 --page 直到短页，按页序合并返回（仅列表语义；
     *  search 无分页、忽略；见 listIssuesAllPages）。 */
    allPages?: boolean;
    status?: string;
    type?: string;
    project?: string;
    labels?: string[];
    /** 按负责人过滤（id / email / 唯一名）。 */
    assignee?: string;
    /** 优先级过滤（P0|P1|P2|P3，逗号分隔可多值）。 */
    priority?: string;
    /** Saved View UUID：复用其筛选和排序，不能与其他筛选组合。 */
    view?: string;
    limit?: number;
    /** 页码（1-based）。仅列表模式有效（skr issue search 不支持分页）。 */
    page?: number;
}
export interface GetIssueArgs {
    id: string;
}
export interface InboxArgs {
    workspace?: string;
    /** 包含 in_review 与 done（默认只含 backlog/todo/in_progress；仍排除 closed/canceled）。 */
    all?: boolean;
}
export interface InboxResult {
    /** 收件箱总条数（全量取回，即 items.length）。 */
    total: number;
    items: IssueRow[];
}
export interface CreateStoryArgs {
    title: string;
    body: string;
    workspace?: string;
    project?: string;
    labels?: string[];
    priority?: string;
}
/** 拉取工作区上下文：workspace 列表 + 指定 workspace 的项目/标签/saved views。
 * - workspace 已知：ws/project/label/view 四个 skr 调用一波并发
 *   （原串行 ≈4×0.4s → 一波 ≈0.5s）；
 * - workspace 未知：拉 workspace 列表后顺带并行拉第一个 workspace 的元数据
 *   （响应带 `workspace` 字段标明覆盖对象），客户端免二次请求；
 * - 结果按实际覆盖的 workspace 走 TTL 缓存（60s）+ 并发去重。 */
export declare function fetchContextData(args: FetchContextArgs): Promise<unknown>;
/** 列出指定 workspace 的 saved views（供 saved view 选择器）。 */
export declare function listViewsData(workspace?: string): Promise<{
    items: SavedViewRow[];
}>;
/** 列表或搜索（query 存在时走 search；view 存在时走 --view 复用筛选+排序；
 *  allPages 时走全量翻页聚合，返回合并后的完整列表）。 */
export declare function listIssuesData(args: ListIssuesArgs): Promise<{
    items: IssueRow[];
}>;
/** 拉取收件箱（当前用户名下待办，全量翻页取回）。 */
export declare function listInboxData(args: InboxArgs): Promise<InboxResult>;
export interface MineIssuesResult {
    items: IssueRow[];
    /** 当前活跃/绑定 workspace key（供 client「加载」时绑定新会话目录；解析失败缺省）。 */
    workspace?: string;
}
/** 「我认领的 issue」：当前用户作为负责人、当前绑定 workspace、默认未完成范围，
 * backlog 状态排最前、组内按优先级排序取前 10。whoami 失败或列表为空 → 空数组（前端隐藏栏）。 */
export declare function listMineData(): Promise<MineIssuesResult>;
/** 单条详情（含 markdown 正文与评论）。 */
export declare function getIssueData(args: GetIssueArgs): Promise<unknown>;
/** 把 issue get 的原始 JSON 序列化成结构化文本（加载进新会话的第一条消息）。 */
export declare function formatIssueContext(raw: unknown): string;
/** 把指定目录绑定到 Seeker workspace（`skr ws bind <key>`）。
 * cwd 缺省时沿用当前进程目录（与 loadIssueSession 的会话 cwd 一致）。
 * skr 绑定失败（如 workspace 不存在）抛错，由调用方决定是否让加载失败。 */
export declare function bindWorkspaceData(workspace: string, cwd?: string): Promise<void>;
/** 创建 story（body 走临时文件）。保留端点，供未来复用。 */ export declare function createStoryData(args: CreateStoryArgs): Promise<{
    issue: {
        id: string;
        title?: string;
        status?: string;
        priority?: string;
    };
}>;
