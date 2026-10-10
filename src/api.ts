/**
 * host 直连路由 /seeker/api/*：面板数据操作的确定性通道（列表/详情/上下文/
 * 视图/创建/加载）。列表/详情/上下文/视图/创建不经过模型与会话；「加载」
 * （/load）是唯一会创建会话的操作——按标准 agent preset 组合建新会话
 * （工具/AGENTS.md 指令/skill catalog/persona，对齐宿主 apiproxy 配方），
 * 先以 agent.inject（非唤醒）注入 skr CLI 内置 skill 全文（inbox 批次语义
 * 保证排在 issue 之前），再把 issue 完整详情 followup 为用户消息并立即
 * 开始执行。
 *
 * 注册方式与 genui 的资源路由一致：webServer 为可选服务，探针 + internal/
 * service 订阅。路由逻辑（handleSeekerApi）独立导出，便于冒烟测试。
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  bindWorkspaceData,
  createStoryData,
  fetchContextData,
  formatIssueContext,
  getIssueData,
  listInboxData,
  listIssuesData,
  listMineData,
  listViewsData,
  type CreateStoryArgs,
  type FetchContextArgs,
  type GetIssueArgs,
  type InboxArgs,
  type ListIssuesArgs,
} from './data.ts'
import { readBundledSkill } from './skr.ts'

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
      kind: 'dsh-seeker'
    } & ContextFormed
  }
}

/** 路由前缀（注册到 webServer，longest-prefix 优先于 /api 桥）。 */
export const SEEKER_API_ROUTE = '/seeker/api'

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(payload)
}

function ok(res: ServerResponse, data: unknown): void {
  json(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  json(res, status, { ok: false, error: message })
}

/** 读取 POST body（限量 2MB）。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body 过大（>2MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function boolOf(value: string | null): boolean | undefined {
  if (value === null) return undefined
  return value === 'true' || value === '1'
}

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
export async function loadIssueSession(
  ctx: Context,
  issueId: string,
  opts?: { workspace?: string; cwd?: string; model?: { provider: string; model: string } },
): Promise<{ sessionId: string }> {
  if (typeof issueId !== 'string' || issueId.trim() === '') {
    throw new Error('缺少 id 参数')
  }
  const [raw, skrSkill] = await Promise.all([getIssueData({ id: issueId.trim() }), readBundledSkill('skr')])
  const text = formatIssueContext(raw)

  const agents = ctx.agents
  const sessions = ctx.sessions
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error('会话服务不可用（agents/sessions/agentDefaultModel 未注入）')
  }
  // 模型选择：弹窗显式选择优先，否则用默认模型选择（弹窗默认「默认模型」）。
  const selection =
    opts?.model !== undefined && opts.model.provider !== '' && opts.model.model !== ''
      ? { provider: opts.model.provider, model: opts.model.model }
      : defaultModel.currentSelection()
  const cwd = opts?.cwd ?? process.cwd()
  // 先绑定会话工作目录到项目所属的 Seeker workspace（写 .seeker/workspace.json）。
  // 绑定放在建会话之前：workspace 无效/绑定失败时直接失败，不留孤儿会话。
  if (opts?.workspace !== undefined && opts.workspace.trim() !== '') {
    await bindWorkspaceData(opts.workspace, cwd)
  }
  const sessionId = SessionId(`seeker-load-${randomUUID()}`)
  // Agent preset：create 之前解析（id 必须进 meta——session boundary 在异步 setup
  // 开始前就快照 meta，setup 内才发现的 preset 永远到不了 header）；resolve 失败
  // 直接抛错，不建会话。无 roster 的部署（如 headless）agentPresets 未注入，
  // 保持不 mount——那时宿主全局层自然覆盖每个会话。
  const presets = ctx.get('agentPresets') as AgentPresetsLoose | undefined
  const agentPreset = presets !== undefined ? (await presets.resolve(undefined)).id : undefined
  const handle = await agents.create({
    sessionId,
    meta: { cwd, ...(agentPreset !== undefined ? { agentPreset } : {}) },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      // mount 失败会回滚整个创建（不留半成品组合）；幂等单飞，并发加载安全。
      if (presets !== undefined && agentPreset !== undefined) {
        await presets.mount(agentCtx, agentPreset)
      }
    },
  })
  const agent = handle.agent
  // 把新会话挂到项目所在的工作区（workspaceRegistry，GUI 左侧分组）：
  // workspaceRegistry.create(cwd) 幂等——项目目录已注册则复用记录，未注册则新建；
  // attachSession 要求会话 header.cwd 与 workspace.path 一致（正是 cwd），
  // 满足后新会话即出现在项目工作区分组下，不再「未分组」。
  // attach 失败时清理刚创建的会话（dispose）再抛错，不留孤儿会话。
  // attach 必须在唤醒驱动之前完成：agent 开始执行后再 dispose 会造成竞态。
  const registry = (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryLoose }).workspaceRegistry
  if (registry !== undefined) {
    try {
      const ws = await registry.create(cwd)
      await ws.attachSession(agent.session.id)
    } catch (error) {
      await handle.dispose().catch(() => {})
      throw error
    }
  }
  // 会话标题：显式 rename 为「<id>｜<标题>」——rename 会 pin 住标题，
  // 后续用户消息不再触发自动标题生成。放在唤醒驱动之前：避免自动生成抢先调度
  // （即便抢先，rename 也会 supersede 在途的自动生成，双保险）。
  // session-title 为可选服务：未注入的部署跳过即可，不影响加载。
  const titles = ctx.get('sessionTitle') as SessionTitleLoose | undefined
  if (titles !== undefined) {
    const issueTitle = flatTitle((raw as { title?: unknown }).title)
    // 标题是装饰性操作：rename 失败（如服务已 dispose）不影响加载本身，
    // 会话已创建，这里抛错会留孤儿会话——吞掉即可（标题退化为自动生成）。
    try {
      titles.rename(agent.session, `${issueId.trim()}｜${issueTitle !== '' ? issueTitle : '（无标题）'}`)
    } catch {
      // 忽略：标题服务不可用时让自动生成兜底。
    }
  }
  // skr skill 上下文：agent.inject 是非唤醒的 next-step 上下文，先于 followup
  // （next-turn）被同一首批次 claim——skill 全文排在 issue 消息之前进入第一个请求。
  // skr skill 不在 dsh 的 skill 发现目录里（skr skill install 不支持 dsh），
  // 目录 catalog 不会列它，这里直接注入全文。
  if (skrSkill !== undefined) {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `【skr Skill】以下是 skr CLI 内置 skill 的全文，是你用 skr 操作 Seeker issue 的规矩与命令参考：\n\n${skrSkill}` }],
      source: {
        kind: 'dsh-seeker',
        form: 'notice',
        summary: boundContextSummary('注入 skr skill 上下文'),
      },
    }))
  }
  // 把 issue 作为用户消息入队并唤醒驱动（agent.followup = send(…, 'next-turn', true)）：
  // 会话创建后立即开始执行，而不是只把 issue 写进 transcript 等用户手动继续。
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-seeker',
      form: 'notice',
      summary: boundContextSummary(`加载 issue ${issueId.trim()}`),
    },
  }))
  return { sessionId: agent.session.id }
}

/** dsh-workspace 的宽松面（宿主保证类型，这里避免引入类型依赖）。 */
interface WorkspaceRegistryLoose {
  /** 幂等：已注册目录复用记录，未注册则新建。 */
  create(path: string, title?: string): Promise<{ attachSession(sessionId: string): Promise<void> }>
}

/** dsh-session-title 的宽松面（宿主保证类型，这里避免引入类型依赖）。
 * rename 追加 session/title 事件并 pin 住标题（自动生成停止调度）；
 * 标题归一化为空或会话不 live 时抛错。 */
interface SessionTitleLoose {
  rename(session: unknown, title: string): unknown
}

/** issue title 归一化为单行文本（标题进会话名，去掉换行避免刷屏）。 */
function flatTitle(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, ' ').trim()
}

/** dsh-agent-presets 的宽松面（宿主保证类型，这里避免引入类型依赖）。
 * 对齐 apiproxy composeAgent：resolve 在 create 前（id 进 meta.agentPreset），
 * mount 在 setup 内（失败回滚整个创建）。 */
interface AgentPresetsLoose {
  /** 解析 preset（undefined = roster 默认）；未知/不可用 id 抛错。 */
  resolve(id?: string): Promise<{ id: string }>
  /** 把 agent 的作用域 parent 到 preset 的 standing mount（幂等单飞）。 */
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** 处理一次 /seeker/api 请求（导出供测试）。 */
export async function handleSeekerApi(
  method: string,
  pathname: string,
  params: URLSearchParams,
  bodyText: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    if (method === 'GET' && pathname === `${SEEKER_API_ROUTE}/context`) {
      const data = await fetchContextData({ workspace: params.get('workspace') ?? undefined } as FetchContextArgs)
      return { ok: true, data }
    }
    if (method === 'GET' && pathname === `${SEEKER_API_ROUTE}/views`) {
      const data = await listViewsData(params.get('workspace') ?? undefined)
      return { ok: true, data }
    }
    if (method === 'GET' && pathname === `${SEEKER_API_ROUTE}/mine`) {
      const data = await listMineData()
      return { ok: true, data }
    }
    if (method === 'GET' && pathname === `${SEEKER_API_ROUTE}/inbox`) {
      const data = await listInboxData({
        workspace: params.get('workspace') ?? undefined,
        all: boolOf(params.get('all')),
      } as InboxArgs)
      return { ok: true, data }
    }
    if (method === 'GET' && pathname === `${SEEKER_API_ROUTE}/list`) {
      const data = await listIssuesData({
        workspace: params.get('workspace') ?? undefined,
        query: params.get('query') ?? undefined,
        all: boolOf(params.get('all')),
        allPages: boolOf(params.get('allPages')),
        status: params.get('status') ?? undefined,
        type: params.get('type') ?? undefined,
        project: params.get('project') ?? undefined,
        view: params.get('view') ?? undefined,
        limit: params.get('limit') !== null ? Number(params.get('limit')) : undefined,
        page: params.get('page') !== null ? Number(params.get('page')) : undefined,
      } as ListIssuesArgs)
      return { ok: true, data }
    }
    if (method === 'GET' && pathname === `${SEEKER_API_ROUTE}/issue`) {
      const id = params.get('id')
      if (id === null || id.trim() === '') {
        return { ok: false, error: '缺少 id 参数（?id=SEE-xxx）' }
      }
      const data = await getIssueData({ id } as GetIssueArgs)
      return { ok: true, data: { issue: data } }
    }
    if (method === 'POST' && pathname === `${SEEKER_API_ROUTE}/create`) {
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyText)
      } catch {
        return { ok: false, error: 'create 请求体不是合法 JSON' }
      }
      const a = (parsed ?? {}) as CreateStoryArgs
      const data = await createStoryData(a)
      return { ok: true, data }
    }
    return { ok: false, error: `未支持的路由：${method} ${pathname}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** webServer 路由处理器（注册用）。ctx 用于「加载」操作创建会话。 */
export function createSeekerRouteHandler(ctx?: Context): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      fail(res, 405, '仅支持 GET / POST')
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      fail(res, 400, 'URL 解析失败')
      return
    }
    if (!url.pathname.startsWith(`${SEEKER_API_ROUTE}/`)) {
      fail(res, 404, '未找到')
      return
    }
    let bodyText = ''
    if (req.method === 'POST') {
      try {
        bodyText = await readBody(req)
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : String(error))
        return
      }
    }
    // 「加载」是唯一需要 ctx（创建会话）的路由，单独处理；其余委托给无 ctx 的
    // handleSeekerApi（数据通道，便于冒烟测试）。
    if (req.method === 'POST' && url.pathname === `${SEEKER_API_ROUTE}/load`) {
      if (ctx === undefined) {
        fail(res, 503, '加载需要会话服务（host 未注入 agents/sessions）')
        return
      }
      let parsed: { id?: string; workspace?: string; cwd?: string; model?: { provider?: string; model?: string } }
      try {
        parsed = JSON.parse(bodyText) as { id?: string; workspace?: string; cwd?: string; model?: { provider?: string; model?: string } }
      } catch {
        fail(res, 400, 'load 请求体不是合法 JSON')
        return
      }
      try {
        const loadOpts: { workspace?: string; cwd?: string; model?: { provider: string; model: string } } = {}
        if (parsed.workspace !== undefined && parsed.workspace.trim() !== '') loadOpts.workspace = parsed.workspace
        if (parsed.cwd !== undefined && parsed.cwd.trim() !== '') loadOpts.cwd = parsed.cwd
        if (
          parsed.model !== undefined &&
          typeof parsed.model.provider === 'string' && parsed.model.provider !== '' &&
          typeof parsed.model.model === 'string' && parsed.model.model !== ''
        ) {
          loadOpts.model = { provider: parsed.model.provider, model: parsed.model.model }
        }
        const data = await loadIssueSession(ctx, parsed.id ?? '', loadOpts)
        ok(res, data)
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : String(error))
      }
      return
    }
    const result = await handleSeekerApi(req.method, url.pathname, url.searchParams, bodyText)
    if (result.ok) {
      ok(res, result.data)
    } else {
      fail(res, 400, result.error)
    }
  }
}
