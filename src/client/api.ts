/**
 * Seeker 工作台 client 数据通道（v3 重构）：同源相对 fetch /seeker/api/*。
 * 零会话、零模型；与 task-status 的 /plugins/* 路由同款做法。
 */

export interface WorkspaceRow {
  id: string
  key: string
  name: string
}

export interface ProjectRow {
  id: string
  key: string
  name: string
  status?: string
}

export interface LabelGroup {
  id: string
  name: string
  values: string[]
}

export interface SavedViewRow {
  id: string
  workspaceId: string
  name: string
  scope?: string
  ordering?: string
  orderDir?: string
}

export interface IssueRow {
  id: string
  type?: string
  title?: string
  status?: string
  priority?: string
  labels?: string[]
  assigneeIdentity?: { displayName?: string }
  assignee?: string
  reporterIdentity?: { displayName?: string }
  reporter?: string
  createdAt?: string
  updatedAt?: string
}

export interface IssueComment {
  id: string
  authorId?: string
  authorDisplayName?: string
  bodyText?: string
  createdAt?: string
  kind?: string
  agent?: string
}

export interface IssueDetail {
  id: string
  workspaceId?: string
  type?: string
  title?: string
  status?: string
  priority?: string
  project?: string
  delivery?: string
  labels?: string[]
  assignee?: string
  reporter?: string
  assigneeIdentity?: { displayName?: string }
  reporterIdentity?: { displayName?: string }
  bodyText?: string
  comments?: IssueComment[]
  createdAt?: string
  updatedAt?: string
}

export interface FetchContextResult {
  workspaces: WorkspaceRow[]
  projects: ProjectRow[]
  labels: LabelGroup[]
  views: SavedViewRow[]
  /** 元数据实际覆盖的 workspace（未指定请求时为第一个 workspace，无则缺省）。 */
  workspace?: string
}

/* ---------------- client 侧 context TTL 缓存 ----------------
 * context（workspace 列表 + 项目/标签/saved views）变化频率低，缓存后：
 * - 重复打开面板 / 快速切换 workspace 零请求（配合 host 60s TTL 缓存）；
 * - 首次打开（未指定 workspace）时 host 顺带返回第一个 workspace 的上下文，
 *   按实际覆盖的 workspace 缓存，避免「选定 workspace 后再拉一次」。
 */

interface CtxCacheEntry {
  value: FetchContextResult
  expiresAt: number
}

const ctxCache = new Map<string, CtxCacheEntry>()
const CTX_CLIENT_TTL_MS = 60_000
const CTX_CACHE_MAX = 20

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value)
  }
  const res = await fetch(url.toString(), { method: 'GET' })
  let body: { ok?: boolean; data?: T; error?: string }
  try {
    body = (await res.json()) as { ok?: boolean; data?: T; error?: string }
  } catch {
    throw new Error(`Seeker API 响应不是合法 JSON（HTTP ${res.status}）`)
  }
  if (body.ok !== true || body.data === undefined) {
    throw new Error(body.error ?? `Seeker API 请求失败（HTTP ${res.status}）`)
  }
  return body.data
}

/** 拉取上下文：workspace 列表 + 指定 workspace 的项目/标签/saved views。 */
export function fetchContext(workspace?: string): Promise<FetchContextResult> {
  return get<FetchContextResult>('/seeker/api/context', { workspace })
}

/** 拉取上下文（命中 client TTL 缓存则直接返回；结果按实际覆盖的 workspace 缓存）。 */
export async function fetchContextCached(workspace?: string): Promise<FetchContextResult> {
  const requested = workspace ?? ''
  const hit = ctxCache.get(requested)
  if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value
  const r = await fetchContext(workspace)
  const key = r.workspace ?? requested
  if (ctxCache.size >= CTX_CACHE_MAX) ctxCache.clear()
  ctxCache.set(key, { value: r, expiresAt: Date.now() + CTX_CLIENT_TTL_MS })
  return r
}

/** 列表或搜索（query 存在走 search；view 存在走 saved view；allPages 走全量翻页）。 */
export function listIssues(params: {
  workspace?: string
  query?: string
  all?: boolean
  /** 全量翻页聚合（saved view 分组用）：host 循环 --page 直到短页。 */
  allPages?: boolean
  status?: string
  type?: string
  project?: string
  labels?: string[]
  view?: string
  limit?: number
  page?: number
}): Promise<{ items: IssueRow[] }> {
  const q: Record<string, string> = {}
  if (params.workspace !== undefined && params.workspace !== '') q.workspace = params.workspace
  if (params.query !== undefined && params.query !== '') q.query = params.query
  if (params.all === true) q.all = 'true'
  if (params.allPages === true) q.allPages = 'true'
  if (params.status !== undefined && params.status !== '') q.status = params.status
  if (params.type !== undefined && params.type !== '') q.type = params.type
  if (params.project !== undefined && params.project !== '') q.project = params.project
  if (params.labels !== undefined && params.labels.length > 0) q.labels = params.labels.join(',')
  if (params.view !== undefined && params.view !== '') q.view = params.view
  if (params.limit !== undefined) q.limit = String(params.limit)
  if (params.page !== undefined) q.page = String(params.page)
  return get<{ items: IssueRow[] }>('/seeker/api/list', q)
}

/** 单条 issue 详情。 */
export function getIssue(id: string): Promise<{ issue: IssueDetail }> {
  return get<{ issue: IssueDetail }>('/seeker/api/issue', { id })
}

/** 「我认领的 issue」（hero 栏数据源）：当前用户 + 当前绑定 workspace，
 * host 侧按优先级排序取前 10；workspace 为当前绑定 key（供「加载」沿用）。 */
export function listMine(): Promise<{ items: IssueRow[]; workspace?: string }> {
  return get<{ items: IssueRow[]; workspace?: string }>('/seeker/api/mine', {})
}

export interface InboxResult {
  /** 收件箱总条数（全量取回，即 items.length）。 */
  total: number
  items: IssueRow[]
}

/** 收件箱（个人维度）：当前登录用户名下、当前 workspace 的待办 + 总数
 * （whoami → issue list --assignee，host 全量翻页取回）；all=true 追加
 * in_review/done（仍排除 closed/canceled）。 */
export function fetchInbox(params: { workspace?: string; all?: boolean }): Promise<InboxResult> {
  const q: Record<string, string> = {}
  if (params.workspace !== undefined && params.workspace !== '') q.workspace = params.workspace
  if (params.all === true) q.all = 'true'
  return get<InboxResult>('/seeker/api/inbox', q)
}

/** 发起 POST /seeker/api/load：宿主创建新会话并把完整 issue 注入为第一条用户消息，
 * 返回新会话 id。 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: { ok?: boolean; data?: T; error?: string }
  try {
    parsed = (await res.json()) as { ok?: boolean; data?: T; error?: string }
  } catch {
    throw new Error(`Seeker API 响应不是合法 JSON（HTTP ${res.status}）`)
  }
  if (parsed.ok !== true || parsed.data === undefined) {
    throw new Error(parsed.error ?? `Seeker API 请求失败（HTTP ${res.status}）`)
  }
  return parsed.data
}

/** 「加载」：创建新会话并注入 issue，把会话工作目录绑定到 project 所属的
 * Seeker workspace（see/TPG/VAN），返回新会话 id。
 * @param id - issue 编号。
 * @param opts.workspace - 项目所属的 Seeker workspace（host 用它写 .seeker/workspace.json）。
 * @param opts.cwd - 会话工作目录（host 用它做会话 meta.cwd 并写入绑定；缺省沿用进程目录）。
 * @param opts.model - 会话使用的模型（host 用它建会话；缺省用默认模型选择）。 */
export function loadIssue(id: string, opts?: { workspace?: string; cwd?: string; model?: { provider: string; model: string } }): Promise<{ sessionId: string }> {
  return post<{ sessionId: string }>('/seeker/api/load', { id, workspace: opts?.workspace, cwd: opts?.cwd, model: opts?.model })
}
