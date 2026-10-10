/**
 * dsh-seeker host 数据函数层：skr CLI 封装的核心逻辑（参数校验、--json 解析、
 * 错误处理）。供 /seeker/api 直连路由使用（面板数据通道，零模型参与）。
 *
 * 零 @deepseek-ai 运行时依赖，纯函数导出。
 */
import { runSkr } from './skr.ts'

/* ---------------- 输出形状 ---------------- */

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

export interface FetchContextArgs {
  workspace?: string
}

export interface ListIssuesArgs {
  workspace?: string
  query?: string
  /** --all：全部状态（单页语义，配合 limit）。 */
  all?: boolean
  /** 全量翻页：循环 --page 直到短页，按页序合并返回（仅列表语义；
   *  search 无分页、忽略；见 listIssuesAllPages）。 */
  allPages?: boolean
  status?: string
  type?: string
  project?: string
  labels?: string[]
  /** 按负责人过滤（id / email / 唯一名）。 */
  assignee?: string
  /** 优先级过滤（P0|P1|P2|P3，逗号分隔可多值）。 */
  priority?: string
  /** Saved View UUID：复用其筛选和排序，不能与其他筛选组合。 */
  view?: string
  limit?: number
  /** 页码（1-based）。仅列表模式有效（skr issue search 不支持分页）。 */
  page?: number
}

export interface GetIssueArgs {
  id: string
}

export interface InboxArgs {
  workspace?: string
  /** 包含 in_review 与 done（默认只含 backlog/todo/in_progress；仍排除 closed/canceled）。 */
  all?: boolean
}

export interface InboxResult {
  /** 收件箱总条数（全量取回，即 items.length）。 */
  total: number
  items: IssueRow[]
}

export interface CreateStoryArgs {
  title: string
  body: string
  workspace?: string
  project?: string
  labels?: string[]
  priority?: string
}

/* ---------------- 数据函数 ---------------- */

/** 把用户提供的 workspace key/id 规范化成参数数组（无值则不传，用活跃 workspace）。 */
function wsArgs(workspace: string | undefined): string[] {
  return workspace === undefined || workspace === '' ? [] : ['--workspace', workspace]
}

/* ---------------- host 内存缓存（context 元数据，TTL 60s） ----------------
 * context（workspace 列表 + 项目/标签/saved views）变化频率低，缓存后：
 * - 重复打开面板 / 快速切换 workspace 不再每次 spawn 4 次 skr（每次 ≈0.4s）；
 * - 并发同 key 请求共享同一次 skr 调用（inflight 去重）。
 */

interface CtxCacheEntry {
  value: unknown
  expiresAt: number
}

const ctxCache = new Map<string, CtxCacheEntry>()
const ctxInflight = new Map<string, Promise<unknown>>()
const CONTEXT_TTL_MS = 60_000
const CONTEXT_CACHE_MAX = 50

function pruneCtxCache(): void {
  const now = Date.now()
  for (const [key, entry] of ctxCache) {
    if (entry.expiresAt <= now) ctxCache.delete(key)
  }
  if (ctxCache.size > CONTEXT_CACHE_MAX) ctxCache.clear()
}

/** 带 TTL 与并发去重的上下文加载（key 为元数据实际覆盖的 workspace）。 */
async function cachedContext(key: string, loader: () => Promise<unknown>): Promise<unknown> {
  pruneCtxCache()
  const hit = ctxCache.get(key)
  if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value
  const existing = ctxInflight.get(key)
  if (existing !== undefined) return existing
  const promise = loader()
    .then((value) => {
      ctxCache.set(key, { value, expiresAt: Date.now() + CONTEXT_TTL_MS })
      return value
    })
    .finally(() => {
      ctxInflight.delete(key)
    })
  ctxInflight.set(key, promise)
  return promise
}

/** 并行拉取指定 workspace 的项目/标签/saved views（互不依赖，一波并发）。 */
async function fetchWorkspaceMeta(workspace: string): Promise<{ projects: ProjectRow[]; labels: LabelGroup[]; views: SavedViewRow[] }> {
  const wa = wsArgs(workspace)
  const [projects, labels, views] = await Promise.all([
    runSkr(['project', 'list', ...wa]) as Promise<ProjectRow[]>,
    runSkr(['label', 'list', ...wa]) as Promise<LabelGroup[]>,
    runSkr(['view', 'list', ...wa]) as Promise<SavedViewRow[]>,
  ])
  return { projects, labels, views }
}

/** 拉取工作区上下文：workspace 列表 + 指定 workspace 的项目/标签/saved views。
 * - workspace 已知：ws/project/label/view 四个 skr 调用一波并发
 *   （原串行 ≈4×0.4s → 一波 ≈0.5s）；
 * - workspace 未知：拉 workspace 列表后顺带并行拉第一个 workspace 的元数据
 *   （响应带 `workspace` 字段标明覆盖对象），客户端免二次请求；
 * - 结果按实际覆盖的 workspace 走 TTL 缓存（60s）+ 并发去重。 */
export async function fetchContextData(args: FetchContextArgs): Promise<unknown> {
  const { workspace } = args
  if (workspace === undefined || workspace === '') {
    const wsData = (await runSkr(['ws', 'list'])) as { workspaces?: WorkspaceRow[] }
    const workspaces = wsData.workspaces ?? []
    const first = workspaces[0]?.key
    if (first === undefined) return { workspaces, projects: [], labels: [], views: [] }
    return cachedContext(`context:${first}`, async () => {
      const meta = await fetchWorkspaceMeta(first)
      return { workspaces, projects: meta.projects, labels: meta.labels, views: meta.views, workspace: first }
    })
  }
  return cachedContext(`context:${workspace}`, async () => {
    const [wsData, meta] = await Promise.all([
      runSkr(['ws', 'list']) as Promise<{ workspaces?: WorkspaceRow[] }>,
      fetchWorkspaceMeta(workspace),
    ])
    return { workspaces: wsData.workspaces ?? [], projects: meta.projects, labels: meta.labels, views: meta.views, workspace }
  })
}

/** 列出指定 workspace 的 saved views（供 saved view 选择器）。 */
export async function listViewsData(workspace?: string): Promise<{ items: SavedViewRow[] }> {
  const items = (await runSkr(['view', 'list', ...wsArgs(workspace)])) as SavedViewRow[]
  return { items }
}

/** skr issue list 每页上限（CLI 固定 1-100）。 */
const ISSUE_PAGE_LIMIT = 100
/** 全量翻页的并发批大小（一批内的页码并发拉取，满页则继续下一批）。 */
const ISSUE_PAGE_BATCH = 5

/** 组装一次 issue 列表/搜索的 CLI 参数（不含 --limit/--page，由调用方追加）。 */
function buildIssueListArgs(args: ListIssuesArgs, search: boolean, useView: boolean): string[] {
  const argsList: string[] = search
    ? ['issue', 'search', args.query!.trim()]
    : ['issue', 'list']
  argsList.push(...wsArgs(args.workspace))
  if (useView) {
    // saved view：复用其筛选和排序，不能与其他筛选组合。
    argsList.push('--view', args.view!.trim())
  } else {
    if (args.all === true) argsList.push('--all')
    if (args.status !== undefined && args.status !== '') argsList.push('--status', args.status)
    if (args.type !== undefined && args.type !== '') argsList.push('--type', args.type)
    if (args.project !== undefined && args.project !== '') argsList.push('--project', args.project)
    if (Array.isArray(args.labels) && args.labels.length > 0) argsList.push('--labels', args.labels.join(','))
    if (args.assignee !== undefined && args.assignee !== '') argsList.push('--assignee', args.assignee)
    if (args.priority !== undefined && args.priority !== '') argsList.push('--priority', args.priority)
  }
  return argsList
}

/** 拉取指定页码（limit=100，满页 100 条表示还有下一页）。 */
async function fetchIssuePage(argsList: string[], page: number): Promise<IssueRow[]> {
  return (await runSkr([...argsList, '--limit', String(ISSUE_PAGE_LIMIT), '--page', String(page)])) as IssueRow[]
}

/** 全量翻页聚合：page 1 起，满页则按批并发翻剩余页，直到出现短页。
 * 超出末尾的页返回空数组（已实测），故首个短页之后的结果直接丢弃。
 * 单批任一页失败 → 整批失败（错误卡 + 重试兜底）。 */
async function listIssuesAllPages(args: ListIssuesArgs): Promise<{ items: IssueRow[] }> {
  const search = typeof args.query === 'string' && args.query.trim() !== ''
  const useView = typeof args.view === 'string' && args.view.trim() !== ''
  const argsList = buildIssueListArgs(args, search, useView)
  const first = await fetchIssuePage(argsList, 1)
  if (first.length < ISSUE_PAGE_LIMIT) return { items: first }
  const all: IssueRow[] = [...first]
  let batchStart = 2
  for (;;) {
    const pages = Array.from({ length: ISSUE_PAGE_BATCH }, (_, i) => batchStart + i)
    const results = await Promise.all(pages.map((p) => fetchIssuePage(argsList, p)))
    const shortIdx = results.findIndex((r) => r.length < ISSUE_PAGE_LIMIT)
    if (shortIdx === -1) {
      all.push(...results.flat())
      batchStart += ISSUE_PAGE_BATCH
      continue
    }
    all.push(...results.slice(0, shortIdx + 1).flat())
    return { items: all }
  }
}

/** 列表或搜索（query 存在时走 search；view 存在时走 --view 复用筛选+排序；
 *  allPages 时走全量翻页聚合，返回合并后的完整列表）。 */
export async function listIssuesData(args: ListIssuesArgs): Promise<{ items: IssueRow[] }> {
  const search = typeof args.query === 'string' && args.query.trim() !== ''
  const useView = typeof args.view === 'string' && args.view.trim() !== ''
  if (args.allPages === true && !search) {
    return listIssuesAllPages(args)
  }
  const argsList = buildIssueListArgs(args, search, useView)
  if (args.limit !== undefined && args.limit > 0) argsList.push('--limit', String(Math.min(100, args.limit)))
  if (!search && !useView && args.page !== undefined && args.page > 0) {
    argsList.push('--page', String(args.page))
  }
  const items = (await runSkr(argsList)) as IssueRow[]
  return { items }
}

/* ---------------- 收件箱（个人维度 Inbox） ----------------
 * 收件箱 = **当前登录用户**名下、当前/指定 workspace 的待办：whoami 拿
 * displayName → skr issue list --assignee <me> --status …（状态范围对齐
 * skr todo 语义：默认 backlog/todo/in_progress，all 时追加 in_review/done，
 * 仍排除 closed/canceled）。skr issue list 无 total 字段，故**全量翻页取回**
 * （个人待办量小：默认范围通常 <20 条，--all 含 done 可能上百，但属显式
 * 查看已完成），total 即 items.length——计数精确，无截断提示。
 * whoami 失败或用户无 issue → 空数组（前端显示空态）。
 */

/** 收件箱的状态范围（对齐 skr todo：默认不含 in_review/done；all 追加）。 */
const INBOX_STATUSES = 'backlog,todo,in_progress'
const INBOX_STATUSES_ALL = 'backlog,todo,in_progress,in_review,done'

/** 拉取收件箱（当前用户名下待办，全量翻页取回）。 */
export async function listInboxData(args: InboxArgs): Promise<InboxResult> {
  let me: string
  try {
    me = await cachedWhoami()
  } catch {
    return { total: 0, items: [] }
  }
  if (me === '') return { total: 0, items: [] }
  const inboxArgs: ListIssuesArgs = {
    assignee: me,
    status: args.all === true ? INBOX_STATUSES_ALL : INBOX_STATUSES,
    allPages: true,
  }
  if (args.workspace !== undefined && args.workspace !== '') inboxArgs.workspace = args.workspace
  const { items } = await listIssuesData(inboxArgs)
  return { total: items.length, items }
}

/* ---------------- 我认领的 issue（新会话页 hero 栏数据源） ----------------
 * skr whoami 拿当前用户 displayName → skr issue list --assignee（不传
 * --workspace，沿用 skr 的目录绑定/活跃 workspace 解析，与 skr ws bind 写的
 * .seeker/workspace.json 一致）→ host 侧按优先级排序（P0 → P3，同级按
 * updatedAt 倒序）取前 10 条。skr issue list 无排序参数，排序只能在 host 做。
 */

/** hero 栏最多展示的条数。 */
const MINE_TOP_N = 10

/** 优先级排序枚举（P0 最高；未知/缺失排最后）。 */
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

export interface MineIssuesResult {
  items: IssueRow[]
  /** 当前活跃/绑定 workspace key（供 client「加载」时绑定新会话目录；解析失败缺省）。 */
  workspace?: string
}

/* whoami（当前用户 displayName）短 TTL 缓存（60s）+ 并发去重，参照
 * fetchContextData 的 ctxCache 做法——hero 栏每次挂载都会问一次。 */
const WHOAMI_TTL_MS = 60_000
let whoamiCache: { value: string; expiresAt: number } | undefined
let whoamiInflight: Promise<string> | undefined

/** 当前登录用户的 displayName（whoami 结果 60s TTL 缓存，并发共享同一次调用）。 */
async function cachedWhoami(): Promise<string> {
  if (whoamiCache !== undefined && whoamiCache.expiresAt > Date.now()) return whoamiCache.value
  if (whoamiInflight !== undefined) return whoamiInflight
  const promise = (async () => {
    const data = (await runSkr(['whoami'])) as { displayName?: string; customDisplayName?: string }
    const name = data.displayName ?? data.customDisplayName ?? ''
    whoamiCache = { value: name, expiresAt: Date.now() + WHOAMI_TTL_MS }
    return name
  })().finally(() => {
    whoamiInflight = undefined
  })
  whoamiInflight = promise
  return promise
}

/** backlog 状态排最前；组内按优先级（未知/缺失垫底），同级按 updatedAt 倒序。 */
function compareMine(a: IssueRow, b: IssueRow): number {
  const statusOf = (s: string | undefined): number => (s === 'backlog' ? 0 : 1)
  const sa = statusOf(a.status)
  const sb = statusOf(b.status)
  if (sa !== sb) return sa - sb
  const rankOf = (p: string | undefined): number => (p !== undefined && p !== '' ? (PRIORITY_RANK[p] ?? 99) : 99)
  const ra = rankOf(a.priority)
  const rb = rankOf(b.priority)
  if (ra !== rb) return ra - rb
  // ISO 时间字符串可直接字典序比较；缺失排后。
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

/** 「我认领的 issue」：当前用户作为负责人、当前绑定 workspace、默认未完成范围，
 * backlog 状态排最前、组内按优先级排序取前 10。whoami 失败或列表为空 → 空数组（前端隐藏栏）。 */
export async function listMineData(): Promise<MineIssuesResult> {
  let name: string
  try {
    name = await cachedWhoami()
  } catch {
    return { items: [] }
  }
  if (name === '') return { items: [] }
  const [{ items }, ws] = await Promise.all([
    listIssuesData({ assignee: name, limit: ISSUE_PAGE_LIMIT }),
    // 顺带解析当前 workspace key（供「加载」绑定）；失败不拖垮列表。
    runSkr(['ws', 'current']).then((d) => (d as { key?: string }).key).catch(() => undefined),
  ])
  const top = [...items].sort(compareMine).slice(0, MINE_TOP_N)
  return { items: top, ...(ws !== undefined && ws !== '' ? { workspace: ws } : {}) }
}

/** 单条详情（含 markdown 正文与评论）。 */
export async function getIssueData(args: GetIssueArgs): Promise<unknown> {
  if (typeof args.id !== 'string' || args.id.trim() === '') {
    throw new Error('缺少 id 参数')
  }
  return runSkr(['issue', 'get', args.id.trim()])
}

/* ---------------- issue 加载（新会话注入上下文） ----------------
 * 「加载」操作：把完整 issue 详情序列化成一段结构化用户消息，作为新会话的
 * 第一条可见消息（对话起点）。纯函数——只负责把 skr issue get 的原始 JSON
 * 整理成可读文本，不含任何 @deepseek-ai 运行时依赖。
 */

function flat(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  return String(v)
}

function person(identity: { displayName?: string } | undefined, fallback: string | undefined): string {
  return identity?.displayName ?? fallback ?? ''
}

/** 把 issue get 的原始 JSON 序列化成结构化文本（加载进新会话的第一条消息）。 */
export function formatIssueContext(raw: unknown): string {
  const it = (raw ?? {}) as {
    id?: unknown
    title?: unknown
    type?: unknown
    status?: unknown
    priority?: unknown
    project?: unknown
    delivery?: unknown
    labels?: unknown
    assignee?: unknown
    reporter?: unknown
    assigneeIdentity?: { displayName?: string }
    reporterIdentity?: { displayName?: string }
    bodyText?: unknown
    comments?: Array<{ id?: unknown; authorDisplayName?: unknown; kind?: unknown; agent?: unknown; bodyText?: unknown; createdAt?: unknown }>
    createdAt?: unknown
    updatedAt?: unknown
  }
  const lines: string[] = []
  lines.push('【已加载 Issue】')
  lines.push('说明：本消息是仅读取的上下文注入——供你阅读与和用户讨论该 issue。不要自行开工：不要修改代码、不要创建/变更 issue 或其状态、不要执行任何写操作；等用户明确指示后再行动。')
  lines.push(`编号：${flat(it.id) || '—'}`)
  lines.push(`标题：${flat(it.title) || '（无标题）'}`)
  const meta: string[] = []
  if (flat(it.type)) meta.push(`类型：${flat(it.type)}`)
  if (flat(it.status)) meta.push(`状态：${flat(it.status)}`)
  if (flat(it.priority)) meta.push(`优先级：${flat(it.priority)}`)
  if (flat(it.project)) meta.push(`项目：${flat(it.project)}`)
  if (flat(it.delivery)) meta.push(`交付：${flat(it.delivery)}`)
  const assignee = person(it.assigneeIdentity, flat(it.assignee))
  if (assignee) meta.push(`负责人：${assignee}`)
  const reporter = person(it.reporterIdentity, flat(it.reporter))
  if (reporter) meta.push(`报告人：${reporter}`)
  if (flat(it.createdAt)) meta.push(`创建：${flat(it.createdAt)}`)
  if (flat(it.updatedAt)) meta.push(`更新：${flat(it.updatedAt)}`)
  if (meta.length > 0) lines.push(`元数据：${meta.join('；')}`)
  if (Array.isArray(it.labels) && it.labels.length > 0) {
    lines.push(`标签：${it.labels.map((l) => flat(l)).filter(Boolean).join(', ')}`)
  }
  const body = flat(it.bodyText)
  lines.push('')
  lines.push('描述：')
  lines.push(body !== '' ? body : '（无描述）')
  const comments = Array.isArray(it.comments) ? it.comments : []
  if (comments.length > 0) {
    lines.push('')
    lines.push(`评论（${comments.length}）：`)
    for (const c of comments) {
      const author = flat(c.authorDisplayName) || '匿名'
      const when = flat(c.createdAt)
      const kind = flat(c.kind)
      const agent = flat(c.agent)
      const who = [author, kind, agent].filter(Boolean).join(' · ')
      lines.push(`- ${who}${when ? `（${when}）` : ''}`)
      const cb = flat(c.bodyText)
      if (cb !== '') {
        for (const seg of cb.split('\n')) lines.push(`  ${seg}`)
      }
    }
  }
  lines.push('')
  lines.push('（再次强调：仅读取。回复请限于对以上内容的理解/讨论/建议，不要开始实施，等用户指示。）')
  return lines.join('\n')
}

/* ---------------- workspace 绑定（skr ws bind） ----------------
 * 「加载」创建新会话时，把该会话的工作目录绑定到项目所属的 Seeker
 * workspace（see/TPG/VAN）。skr 的 workspace 绑定是目录级状态：`skr ws bind
 * <key>` 在当前目录写入 `.seeker/workspace.json`，之后在该目录运行的 skr
 * 命令默认使用该 workspace（`skr ws current` 报 source=directory）。这样加载
 * 出来的会话在讨论/操作 issue 时，skr 工具会落在正确的 workspace，而不是
 * 跨会话粘住的全局活跃 workspace。
 */

/** 把指定目录绑定到 Seeker workspace（`skr ws bind <key>`）。
 * cwd 缺省时沿用当前进程目录（与 loadIssueSession 的会话 cwd 一致）。
 * skr 绑定失败（如 workspace 不存在）抛错，由调用方决定是否让加载失败。 */
export async function bindWorkspaceData(workspace: string, cwd?: string): Promise<void> {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('缺少 workspace 参数')
  }
  await runSkr(['ws', 'bind', workspace.trim()], cwd !== undefined ? { cwd } : undefined)
}

/** 创建 story（body 走临时文件）。保留端点，供未来复用。 */export async function createStoryData(args: CreateStoryArgs): Promise<{ issue: { id: string; title?: string; status?: string; priority?: string } }> {
  if (typeof args.title !== 'string' || args.title.trim() === '' || typeof args.body !== 'string') {
    throw new Error('缺少 title 或 body 参数')
  }
  const { writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tmp = join(tmpdir(), `seeker-story-${process.pid}-${Date.now()}.md`)
  await writeFile(tmp, args.body, 'utf8')
  try {
    const argsList: string[] = [
      'issue', 'create', '--type', 'story',
      '--title', args.title.trim(),
      '--body-file', tmp,
      '--agent', 'dsh-seeker',
    ]
    argsList.push(...wsArgs(args.workspace))
    if (args.project !== undefined && args.project !== '') argsList.push('--project', args.project)
    if (args.priority !== undefined && args.priority !== '') argsList.push('--priority', args.priority)
    for (const label of args.labels ?? []) {
      if (typeof label === 'string' && label.trim() !== '') argsList.push('--label', label.trim())
    }
    const data = (await runSkr(argsList)) as IssueRow
    return {
      issue: {
        id: data.id,
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
      },
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}
