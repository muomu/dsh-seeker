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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { Button, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchContextCached,
  fetchInbox,
  getIssue,
  listIssues,
  loadIssue,
  type FetchContextResult,
  type InboxResult,
  type IssueDetail,
  type IssueRow,
  type LabelGroup,
  type ProjectRow,
  type SavedViewRow,
  type WorkspaceRow,
} from './api.ts'
import { backToList, clearViewCache, getLoadDefaults, getState, getViewCache, getViewDisplay, openDetail, setLoadDefaults, setOpen, setSavedView, setViewCache, setViewDisplay, setWorkspace, subscribe, type ViewDisplayMode } from './store.ts'

/** Seeker Web 应用根地址（外链跳转；深链路由未探测，issue 编号可复制）。 */
const SEEKER_WEB_ROOT = 'https://app.seeker.tradepass.info'

/** 每页条数（列表模式）。 */
const PAGE_SIZE = 50
/** 搜索模式最大返回（skr 默认 20；搜索不分页，截断提示）。 */
const SEARCH_LIMIT = 20

/** 收件箱（个人 Inbox：当前用户名下待办）的视图 sentinel：作为「视图」Tab 的
 * 特例 id 走 savedView 状态位（localStorage 持久），与 saved view 相同的选中/
 * 恢复语义，但数据源是 /seeker/api/inbox（whoami → issue list --assignee，
 * host 全量取回 + 精确总数），非 skr --view。 */
const INBOX_VIEW = '__inbox__'

const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'closed', 'canceled'] as const
const TYPES = ['story', 'task', 'bug', 'subtask'] as const

/** 看板列：只渲染非终态状态（终态与未知/缺失状态不进看板，见设计共识）。 */
const KANBAN_STATUSES: readonly string[] = ['backlog', 'todo', 'in_progress', 'in_review']

const STATUS_LABEL: Record<string, string> = {
  backlog: '待办池', todo: '待办', in_progress: '处理中', in_review: '待核对',
  done: '已完成', closed: '已关闭', canceled: '已取消',
}
const TYPE_LABEL: Record<string, string> = { story: '故事', task: '任务', bug: '缺陷', subtask: '子任务' }

/** saved view 分组的兜底组：未知状态与缺失 status 的合并去向（垫底）。 */
const OTHER_GROUP = '__other__'

/** MarkdownText 的 chrome 文案。dsh 0.1.7-rc.2 起 `labels` 为必填（代码块复制/
 * 换行工具条与脚注标题都读它），且运行时按 `labels.code.*` 直接取值，缺省会崩。
 * 插件自带中文文案，不引入宿主 conversation locale 命名空间；对象身份必须稳定
 * （MarkdownText 拿它当流式渲染缓存键，新身份会丢弃缓存），故为模块级常量。 */
const MARKDOWN_LABELS = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
  },
  footnotes: '脚注',
}

/* ---------------- 小工具 ---------------- */

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ---------------- 「加载」到新会话 ----------------
 * 点击后：POST /seeker/api/load 让宿主创建新会话并把完整 issue 注入为第一条
 * 可见用户消息 → 返回新 sessionId → 轮询会话目录直到该 id 出现 →
 * ctx.uiWorkspace.openSession(id) 切换到新会话并关闭覆盖层。
 * dsh 0.1.7-rc.2 起：会话导航（原 ctx.sessions.open）已从 ISessions 移到
 * ui-workspace 的 UiWorkspace.openSession；ISessions 只保留目录/引用面。
 */

/** SessionSummary/SessionListState 的宽松面（只取本插件用到的字段）。 */
export interface SessionListSnapshot {
  ids: readonly string[]
  byId?: Record<string, {
    id?: string
    cwd?: string
    /** 本地引用来源计数（ISessions.retain）；mainView = 当前主视图会话。 */
    retainedBy?: Readonly<Record<string, number>>
  }>
}

/** 会话导航面：list 读目录快照，openSession 切主视图（由 client/index.tsx 组装）。 */
interface LoadSessions {
  openSession(id: string): void
  list: { getSnapshot(): SessionListSnapshot }
}
export type { LoadSessions }

/** 宽松 workspaces 面（WorkspaceRuntime.list 快照：items 为 WorkspaceView）。 */
interface LooseWorkspaces {
  list: { getSnapshot(): { items: Array<{ workspaceId: string; path: string; title: string }> } }
}

/** 宽松模型目录面（ModelDirectoryResolver.directoryFor → per-session ModelDirectory）。 */
interface LooseModelDirectories {
  directoryFor(sessionId: string): {
    load(): Promise<unknown>
    store: {
      getSnapshot(): {
        groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
        status: string
      }
    }
  }
}

/** 读取当前主视图会话 id（「加载」弹窗加载模型目录、默认工作区用）。
 *  dsh 0.1.7-rc.2 的 SessionListState 不再有 `current` 字段：当前会话由
 *  ISessions.retain 的引用来源表达——持有 `mainView` 引用的那一行即主视图会话
 *  （与 dsh-client-ui-workspace / ui-session 的 containsCurrent 判定同源）。 */
function currentSessionId(sessions: LoadSessions): string | undefined {
  try {
    const snap = sessions.list.getSnapshot()
    const rows = Object.values(snap.byId ?? {})
    const main = rows.find((row) => (row.retainedBy?.mainView ?? 0) > 0)
    return main?.id
  } catch {
    return undefined
  }
}

/** 读取当前会话的工作目录（cwd）——「加载」创建的新会话用它作为工作目录，
 * 并把 .seeker/workspace.json 绑定写到该目录，使新会话落在项目所在 workspace。 */
export function currentSessionCwd(sessions: LoadSessions): string | undefined {
  try {
    const snap = sessions.list.getSnapshot()
    const current = currentSessionId(sessions)
    if (current === undefined || current === '') return undefined
    return snap.byId?.[current]?.cwd
  } catch {
    return undefined
  }
}

/** 打开新会话：轮询会话目录直到新 id 出现，再 openSession（避免宿主对未知 id
 *  的 retain 直接抛错）。兜底仍尝试一次，失败静默（调用方已有失败提示）。 */
export async function openLoadedSession(sessions: LoadSessions, sessionId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if (sessions.list.getSnapshot().ids.includes(sessionId)) {
        sessions.openSession(sessionId)
        return
      }
    } catch {
      // list 暂不可读，继续轮询
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  // 兜底：即使列表尚未包含，仍尝试切换（部分宿主会即时发现未知会话）。
  try {
    sessions.openSession(sessionId)
  } catch {
    // 切换失败：会话已创建，静默即可（用户可在左侧列表手动打开）
  }
}

/* ---------------- 面板尺寸（3:2，全局居中） ---------------- */

/** 面板宽高比：宽:高 = 3:2。 */
const PANEL_RATIO = 3 / 2

/** 水平边距（左右）与垂直边距（top/bottom）——垂直收窄让面板更饱满。 */
const PANEL_MARGIN_X = 48
const PANEL_MARGIN_Y = 16

/**
 * 计算视口内能容纳的最大 3:2 面板（宽 = 高 × 3/2），并随窗口尺寸变化。
 * 面板整体居中，故只依赖视口大小，不依赖侧边栏宽度。
 */
function usePanelSize(): { width: number; height: number } {
  const compute = (): { width: number; height: number } => {
    const maxW = Math.max(320, window.innerWidth - PANEL_MARGIN_X * 2)
    const maxH = Math.max(320, window.innerHeight - PANEL_MARGIN_Y * 2)
    let width = maxH * PANEL_RATIO
    if (width > maxW) width = maxW
    const height = width / PANEL_RATIO
    return { width: Math.round(width), height: Math.round(height) }
  }
  const [size, setSize] = useState(compute)
  useEffect(() => {
    let raf = 0
    const onResize = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setSize(compute()))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return size
}

/* ---------------- aqua 玻璃拟态深度适配 ---------------- */

/**
 * 运行时皮肤快照：aqua 是否激活 + 是否深色模式。
 * - `dsh-client-ui-aqua`（社区玻璃主题插件）激活时在 <html> 上挂
 *   `data-dsh-aqua`，并在 html 上定义 `--dsh-aqua-*` 玻璃 token；
 * - 明暗切换走 `body[data-ds-dark-theme]`。
 * 两者都能在设置里实时变化，故用 MutationObserver 订阅并驱动重渲染。
 */
interface AquaSkinState {
  aqua: boolean
  dark: boolean
}

const AQUA_SKIN_LISTENERS = new Set<() => void>()
let aquaSkinCache: AquaSkinState | null = null

function readAquaSkin(): AquaSkinState {
  return {
    aqua: document.documentElement.hasAttribute('data-dsh-aqua'),
    dark: document.body.hasAttribute('data-ds-dark-theme'),
  }
}

function subscribeAquaSkin(fn: () => void): () => void {
  AQUA_SKIN_LISTENERS.add(fn)
  if (aquaSkinCache === null) {
    aquaSkinCache = readAquaSkin()
    const mo = new MutationObserver(() => {
      const next = readAquaSkin()
      if (next.aqua !== aquaSkinCache!.aqua || next.dark !== aquaSkinCache!.dark) {
        aquaSkinCache = next
        for (const l of AQUA_SKIN_LISTENERS) l()
      }
    })
    // 观察 html 及其后代（body）上的两个皮肤属性
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dsh-aqua', 'data-ds-dark-theme'],
      subtree: true,
    })
  }
  return () => {
    AQUA_SKIN_LISTENERS.delete(fn)
  }
}

function useAquaSkin(): AquaSkinState {
  return useSyncExternalStore(subscribeAquaSkin, () => {
    if (aquaSkinCache === null) aquaSkinCache = readAquaSkin()
    return aquaSkinCache
  })
}

/* ---------------- 统一玻璃配方 ---------------- */

/** 玻璃表面配方：背景 / 模糊 / 边框 / 阴影。 */
interface GlassRecipe {
  bg: string
  blur: string
  border: string
  shadow: string
}

/**
 * 计算一层玻璃表面（跟随 aqua 皮肤与明暗模式），供面板与看板列/卡片共用，
 * 保证整个工作台是**同一套玻璃风格**（背景填充、磨砂、描边、内高光一致）。
 *
 * - `boost`：磨砂加强系数——玻璃填充向 `--dsw-alias-bg-base` 靠拢的比例（越大越实/越奶）。
 *   面板用较大的 boost（更实更奶的主表面），看板列/卡片用更小的 boost（更通透），
 *   形成「表面 → 列 → 卡片」的分层玻璃；内部层级不再重复 backdrop-filter（嵌套模糊
 *   既昂贵又易产生叠影），仅靠更通透的填充 + 描边 + 内高光与主表面拉开层级。
 */
function glassRecipe(aqua: boolean, dark: boolean, boost: number): GlassRecipe {
  const glassToken = dark ? 'var(--dsh-aqua-glass-card-dark)' : 'var(--dsh-aqua-glass-card-light)'
  return {
    bg: aqua
      ? `color-mix(in srgb, ${glassToken} 100%, var(--dsw-alias-bg-base) ${boost * 100}%)`
      : `color-mix(in srgb, var(--dsw-alias-bg-mask-drop) 100%, var(--dsw-alias-bg-base) ${boost * 100}%)`,
    blur: aqua ? 'blur(var(--dsh-aqua-blur, 20px))' : 'blur(18px)',
    border: aqua
      ? (dark ? '1px solid rgba(148, 180, 220, 0.32)' : '1px solid rgba(19, 45, 83, 0.26)')
      : '1px solid var(--dsw-alias-border-l2)',
    shadow: aqua
      ? (dark ? 'inset 0 1px 0 rgba(255,255,255,0.07)' : 'inset 0 1px 0 rgba(255,255,255,0.5)')
      : 'var(--dsw-shadow-lv3)',
  }
}

/** 主表面磨砂加强系数（面板）——向底色靠拢 25%，更实更奶。 */
const FROST_BOOST_SURFACE = 0.25
/** 看板列：比面板更通透，作为表面上的次级玻璃层。 */
const FROST_BOOST_COLUMN = 0.18
/** 看板卡片：最通透的浮起玻璃层（衬托于列之上）。 */
const FROST_BOOST_CARD = 0.1

/* ---------------- 通用 UI ---------------- */

function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 40 }}>
      <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 28 }}>⚠️</div>
      <div style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 20, textAlign: 'center', maxWidth: 480, wordBreak: 'break-word' }}>
        {message}
      </div>
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" onClick={onRetry}>重试</Button>
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 48 }}>
      <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 24 }}>🗂</div>
      <div style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }}>{text}</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, width: 64, flex: 'none' }}>{label}</span>
      {/* 元数据值用 label-secondary（弱于正文的 label-primary），与描述/正文 token 分离 */}
      <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }}>{value}</span>
    </div>
  )
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'danger' }): ReactNode {
  const tones: Record<string, string> = {
    neutral: 'var(--dsw-alias-interactive-bg-hover)',
    accent: 'var(--dsw-alias-state-business-tertiary)',
    good: 'var(--dsw-alias-state-success-tertiary)',
    warn: 'var(--dsw-alias-state-warn-tertiary)',
    bad: 'var(--dsw-alias-state-error-tertiary)',
    danger: 'var(--dsw-static-red-100)',
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', height: 20,
      borderRadius: 999, fontSize: 12, lineHeight: '20px', whiteSpace: 'nowrap',
      color: tone === 'danger' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)', background: tones[tone],
    }}>
      {children}
    </span>
  )
}

function statusTone(status: string | undefined): 'neutral' | 'good' | 'warn' | 'bad' | 'accent' {
  switch (status) {
    case 'in_progress': return 'accent'
    case 'in_review': return 'warn'
    case 'done': case 'closed': return 'good'
    case 'canceled': return 'bad'
    default: return 'neutral'
  }
}

/** 状态 tone → 主色（分组段带的左侧色条用；比 Pill 的浅色底更醒目）。 */
function toneColor(tone: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'): string {
  switch (tone) {
    case 'accent': return 'var(--dsw-alias-state-business-primary)'
    case 'good': return 'var(--dsw-alias-state-success-primary)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary)'
    case 'bad': return 'var(--dsw-alias-state-error-primary)'
    default: return 'var(--dsw-alias-label-secondary)'
  }
}

function typeTone(type: string | undefined): 'neutral' | 'accent' | 'warn' | 'bad' | 'danger' {
  switch (type) {
    case 'story': return 'accent'
    case 'task': return 'neutral'
    case 'bug': return 'danger'
    case 'subtask': return 'warn'
    default: return 'neutral'
  }
}

/* ---------------- 列表视图 ---------------- */

/** 「加载」小按钮：点击把该 issue 加载到新会话（不触发行/卡片的详情跳转）。 */
function LoadButton({ issueId, loading, onLoad }: { issueId: string; loading: boolean; onLoad: (id: string) => void }): ReactNode {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!loading) onLoad(issueId) }}
      disabled={loading}
      title={loading ? '加载中…' : '加载到新会话'}
      style={{
        flex: 'none', cursor: loading ? 'default' : 'pointer', whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: loading ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 8, padding: '2px 10px', fontSize: 12, lineHeight: '22px',
      }}
    >
      {loading ? '加载中…' : '加载'}
    </button>
  )
}

/** 单条 issue 行（列表平铺与 saved view 分组共用）。groupLead 时顶部加外边距，
 * 让分组段带与组内首条之间透气（不改按钮自身尺寸）。外层是 div：主体为可点
 * 击进详情（独立按钮），右侧为「加载」按钮（互不嵌套）。 */
function IssueRowItem({ it, groupLead = false, onLoad, loading }: {
  it: IssueRow
  groupLead?: boolean
  onLoad: (id: string) => void
  loading: boolean
}): ReactNode {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, boxSizing: 'border-box', width: '100%', padding: '10px 12px',
        marginTop: groupLead ? 8 : 0,
        borderRadius: 10, border: 'none',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <button
        onClick={() => openDetail(it.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
          padding: 0, cursor: 'pointer', textAlign: 'left', border: 'none',
          background: 'transparent', color: 'inherit', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <Pill tone={typeTone(it.type)}>{it.type !== undefined ? TYPE_LABEL[it.type] ?? it.type : '—'}</Pill>
            <span style={{ color: 'var(--dsw-alias-state-business-primary)', fontSize: 12, flex: 'none' }}>{it.id}</span>
            <span style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title ?? '(无标题)'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill tone={statusTone(it.status)}>{it.status !== undefined ? STATUS_LABEL[it.status] ?? it.status : '—'}</Pill>
            {it.priority !== undefined && it.priority !== '' && <Pill tone="neutral">P{it.priority.replace('P', '')}</Pill>}
            {it.labels?.map((l) => <Pill key={l} tone="neutral">{l}</Pill>)}
            {it.assigneeIdentity?.displayName !== undefined && (
              <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>👤 {it.assigneeIdentity.displayName}</span>
            )}
            {it.updatedAt !== undefined && (
              <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>更新 {formatTime(it.updatedAt)}</span>
            )}
          </div>
        </div>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, flex: 'none' }}>›</span>
      </button>
      <LoadButton issueId={it.id} loading={loading} onLoad={onLoad} />
    </div>
  )
}

/** 看板卡片：标题（正文）+ 类型徽标 + 编号 + P 徽标 + 负责人；点击进详情（复用 openDetail）。
 * 玻璃风格与主面板统一（glassRecipe 同源，只降低磨砂加强系数更通透，不再重复 backdrop-filter）；
 * 正文与元数据用不同 token 分离——正文用 label-primary（最醒目），元数据统一 label-tertiary。
 * 外层是 div：主体可点击进详情（独立按钮），右上角「加载」按钮。 */
function KanbanCard({ it, glass, onLoad, loading }: {
  it: IssueRow
  glass: GlassRecipe
  onLoad: (id: string) => void
  loading: boolean
}): ReactNode {
  return (
    <div
      style={{
        // border-box：width 100% + 内边距在 content-box 下会超出列宽，造成列内横向滚动条
        display: 'flex', flexDirection: 'column', gap: 7, boxSizing: 'border-box', width: '100%', marginBottom: 8,
        padding: '10px 12px', borderRadius: 10,
        border: glass.border, background: glass.bg, boxShadow: glass.shadow,
        color: 'var(--dsw-alias-label-primary)',
        transition: 'border-color 120ms ease, transform 120ms ease',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = 'var(--dsw-alias-state-business-primary)'
        el.style.transform = 'translateY(-1px)'
      }}
      // 还原必须写回整条 border 简写：把「1px solid …」赋给 borderColor 是无效值会被忽略
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement
        el.style.border = glass.border
        el.style.transform = ''
      }}
    >
      {/* 首行：正文（左，点击进详情）+ 加载按钮（右） */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <button
          onClick={() => openDetail(it.id)}
          style={{
            flex: 1, minWidth: 0, cursor: 'pointer', textAlign: 'left', border: 'none',
            background: 'transparent', padding: 0, color: 'inherit', fontFamily: 'inherit',
          }}
        >
          <span style={{
            color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 500, lineHeight: 1.4,
            wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {it.title ?? '(无标题)'}
          </span>
        </button>
        <LoadButton issueId={it.id} loading={loading} onLoad={onLoad} />
      </div>
      {/* 元数据：统一 label-tertiary 弱化，编号/P 保留语义色作强调 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <Pill tone={typeTone(it.type)}>{it.type !== undefined ? TYPE_LABEL[it.type] ?? it.type : '—'}</Pill>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, flex: 'none' }}>{it.id}</span>
        {it.priority !== undefined && it.priority !== '' && (
          <span style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' }}>
            P{it.priority.replace('P', '')}
          </span>
        )}
      </div>
      {it.assigneeIdentity?.displayName !== undefined && (
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 }}>👤 {it.assigneeIdentity.displayName}</span>
      )}
    </div>
  )
}

interface ListFilters {
  status: string
  type: string
  project: string
  labels: string[]
}

const EMPTY_FILTERS: ListFilters = { status: '', type: '', project: '', labels: [] }

interface ListViewProps {
  workspace: string
  /** 上下文可为空：workspace 已知即挂载列表，与 context 并行拉取（筛选控件待 ctx 到达后可用）。 */
  ctx: FetchContextResult | null
  /** 搜索词：标题栏搜索框持有（提升到覆盖层）。 */
  search: string
  /** 当前 saved view：收藏夹式 Tab（提升到覆盖层）。 */
  view: string
  onViewChange: (view: string) => void
  /** 暴露当前列表的重新加载，供标题栏「刷新」按钮调用。 */
  reloadRef: React.MutableRefObject<(() => void) | null>
  /** 「加载」回调：把指定 issue 加载到新会话。 */
  onLoad: (id: string) => void
  /** 正在加载的 issue id（对应按钮显示加载中态）。 */
  loadingId: string | null
}

function ListView({ workspace, ctx, search, view, onViewChange, reloadRef, onLoad, loadingId }: ListViewProps): ReactNode {
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS)
  const [items, setItems] = useState<IssueRow[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const seqRef = useRef(0)
  // 收件箱（个人维度）：--all 开关（追加 in_review/done）+ 总数计数（host 全量取回）。
  const [inboxAll, setInboxAll] = useState(false)
  const [inboxTotal, setInboxTotal] = useState(0)

  // 看板玻璃配方：与主面板同源（glassRecipe），列/卡片降低磨砂加强系数更通透，
  // 形成「表面 → 列 → 卡片」分层玻璃；跟随 aqua 皮肤与明暗模式实时刷新。
  const { aqua, dark } = useAquaSkin()
  const columnGlass = glassRecipe(aqua, dark, FROST_BOOST_COLUMN)
  const cardGlass = glassRecipe(aqua, dark, FROST_BOOST_CARD)

  const searchMode = search.trim() !== ''
  const viewLocked = view !== ''
  /** 收件箱模式：视图 Tab 的 INBOX_VIEW 特例——数据源 /seeker/api/inbox
   * （当前用户名下待办），无筛选/搜索/分组/分页，只有 --all 开关与总数计数。 */
  const inboxMode = view === INBOX_VIEW

  /** 只带非空键的列表参数（exactOptionalPropertyTypes 兼容）。 */
  const buildListParams = useCallback((nextFilters: ListFilters, nextWorkspace: string, nextPage: number, isReset: boolean): Parameters<typeof listIssues>[0] => {
    const p: Parameters<typeof listIssues>[0] = { workspace: nextWorkspace }
    if (searchMode) {
      p.query = search
      p.limit = SEARCH_LIMIT
      return p
    }
    if (viewLocked) {
      // saved view：host 全量翻页聚合（按状态分组需要完整集合），无分页参数
      p.view = view
      p.allPages = true
      return p
    }
    if (nextFilters.status !== '') p.status = nextFilters.status
    if (nextFilters.type !== '') p.type = nextFilters.type
    if (nextFilters.project !== '') p.project = nextFilters.project
    if (nextFilters.labels.length > 0) p.labels = nextFilters.labels
    p.limit = PAGE_SIZE
    if (isReset) p.page = nextPage
    return p
  }, [searchMode, viewLocked, search, view])

  const resetAndLoad = useCallback((nextFilters: ListFilters, nextWorkspace: string, reset: boolean): void => {
    const seq = ++seqRef.current
    setError(null)
    if (reset) {
      setItems([])
      setPage(1)
    }
    // 收件箱：独立数据源（/inbox，当前用户名下待办）——无分页/筛选/搜索，只受 all 开关影响
    if (inboxMode) {
      setLoading(true)
      void (async () => {
        try {
          const r: InboxResult = await fetchInbox({ workspace: nextWorkspace, all: inboxAll })
          if (seq !== seqRef.current) return
          setItems(r.items)
          setInboxTotal(r.total)
          setHasMore(false)
        } catch (e) {
          if (seq !== seqRef.current) return
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (seq === seqRef.current) setLoading(false)
        }
      })()
      return
    }
    // saved view：会话缓存命中直接渲染（刷新按钮先失效缓存再重拉）
    if (viewLocked) {
      const cached = getViewCache(nextWorkspace, view)
      if (cached !== null) {
        setItems(cached)
        setHasMore(false)
        setLoading(false)
        return
      }
    }
    setLoading(true)
    void (async () => {
      try {
        const r = await listIssues(buildListParams(nextFilters, nextWorkspace, reset ? 1 : 0, reset))
        if (seq !== seqRef.current) return
        setItems(reset ? r.items : (prev) => [...prev, ...r.items])
        if (viewLocked) setViewCache(nextWorkspace, view, r.items)
        // 搜索模式无分页：一次性给全；列表模式按页判断是否还有更多（view 模式全量，无更多）。
        setHasMore(!searchMode && !viewLocked && r.items.length >= PAGE_SIZE)
      } catch (e) {
        if (seq !== seqRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    })()
  }, [searchMode, viewLocked, view, inboxMode, inboxAll, buildListParams])

  // 首次 / workspace / 搜索 / saved view / 收件箱 all 开关 / 筛选变化 → 重置到第一页
  useEffect(() => {
    resetAndLoad(filters, workspace, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, search, view, filters.status, filters.type, filters.project, filters.labels.join(','), inboxAll])

  // 把当前列表的重新加载暴露给标题栏「刷新」按钮（卸载时清空）
  useEffect(() => {
    reloadRef.current = () => resetAndLoad(filters, workspace, true)
    return () => { reloadRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, workspace, resetAndLoad])

  // 无限滚动：sentinel 进入视口 → 加载下一页（仅列表模式）
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || searchMode || viewLocked || loading || !hasMore) return
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || loading || loadingMore || !hasMore) return
      const seq = seqRef.current
      setLoadingMore(true)
      void (async () => {
        try {
          const next = page + 1
          const p: Parameters<typeof listIssues>[0] = { workspace, limit: PAGE_SIZE, page: next }
          if (filters.status !== '') p.status = filters.status
          if (filters.type !== '') p.type = filters.type
          if (filters.project !== '') p.project = filters.project
          if (filters.labels.length > 0) p.labels = filters.labels
          const r = await listIssues(p)
          if (seq !== seqRef.current) return
          setItems((prev) => [...prev, ...r.items])
          setPage(next)
          setHasMore(r.items.length >= PAGE_SIZE)
        } catch {
          // 加载更多失败：保留已有列表，静默（下次滚动再试）
        } finally {
          if (seq === seqRef.current) setLoadingMore(false)
        }
      })()
    }, { rootMargin: '200px' })
    io.observe(sentinel)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMode, viewLocked, loading, hasMore, loadingMore, page, workspace, filters])

  const updateFilter = (patch: Partial<ListFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }))
  }

  const viewOptions: SavedViewRow[] = ctx?.views ?? []
  const projectOptions: ProjectRow[] = ctx?.projects ?? []
  const labelGroups: LabelGroup[] = ctx?.labels ?? []
  const labelValues = useMemo(() => {
    const all = new Set<string>()
    for (const g of labelGroups) for (const v of g.values ?? []) all.add(v)
    return [...all]
  }, [labelGroups])

  // 视图 Tab：收件箱（当前用户名下待办）+ 默认 + 各 saved view
  const viewTabs = useMemo(
    () => [{ id: INBOX_VIEW, name: '收件箱' }, { id: '', name: '默认（未完成）' }, ...viewOptions.map((v) => ({ id: v.id, name: v.name }))],
    [viewOptions],
  )
  /** 选中 Tab：切 saved view 并清空手动筛选/搜索（与旧下拉框行为一致）。 */
  const selectView = (id: string): void => {
    if (id === view) return
    onViewChange(id)
    setFilters(EMPTY_FILTERS)
  }

  // 按状态分组（saved view 与收件箱共用）：固定 STATUSES 顺序，未知/缺失 status
  // 进垫底「其他」组；只保留非空组，组内保持 host 返回顺序（view 排序在组内保留）。
  const groups = useMemo(() => {
    if (!viewLocked && !inboxMode) return []
    const buckets = new Map<string, IssueRow[]>()
    for (const it of items) {
      const s = it.status ?? ''
      const key = s !== '' && STATUS_LABEL[s] !== undefined ? s : OTHER_GROUP
      const arr = buckets.get(key)
      if (arr === undefined) buckets.set(key, [it])
      else arr.push(it)
    }
    const out: { key: string; label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; items: IssueRow[] }[] = []
    for (const key of [...STATUSES, OTHER_GROUP]) {
      const arr = buckets.get(key)
      if (arr !== undefined && arr.length > 0) {
        out.push({
          key,
          label: key === OTHER_GROUP ? '其他' : (STATUS_LABEL[key] ?? key),
          tone: key === OTHER_GROUP ? 'neutral' : statusTone(key),
          items: arr,
        })
      }
    }
    return out
  }, [items, viewLocked, inboxMode])

  // 折叠状态：默认全展开，不持久化；切换 saved view 时重置
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => { setCollapsed(new Set()) }, [view])
  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 显示模式（分组列表 / 看板）：按 workspace+view 记忆到 localStorage，默认分组列表；
  // 切换 workspace 或 saved view 时重读记忆。
  const [display, setDisplay] = useState<ViewDisplayMode>(() => getViewDisplay(workspace, view))
  useEffect(() => { setDisplay(getViewDisplay(workspace, view)) }, [workspace, view])
  const switchDisplay = (mode: ViewDisplayMode): void => {
    if (mode === display) return
    setDisplay(mode)
    setViewDisplay(workspace, view, mode)
  }

  // 看板列（saved view 与收件箱共用）：仅非终态状态、空列隐藏；与 groups 同源
  // （同一份 items），列内保留 view 排序
  const kanbanColumns = useMemo(() => {
    if (!viewLocked && !inboxMode) return []
    const buckets = new Map<string, IssueRow[]>()
    for (const it of items) {
      const s = it.status ?? ''
      if (s === '' || !KANBAN_STATUSES.includes(s)) continue
      const arr = buckets.get(s)
      if (arr === undefined) buckets.set(s, [it])
      else arr.push(it)
    }
    const out: { key: string; label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; items: IssueRow[] }[] = []
    for (const key of KANBAN_STATUSES) {
      const arr = buckets.get(key)
      if (arr !== undefined && arr.length > 0) {
        out.push({ key, label: STATUS_LABEL[key] ?? key, tone: statusTone(key), items: arr })
      }
    }
    return out
  }, [items, viewLocked, inboxMode])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 工具栏 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: 'none' }}>
        {/* saved view 收藏夹式 Tab */}
        {viewTabs.length > 1 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', overflowX: 'auto', flex: 'none', paddingBottom: 2 }}>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, flex: 'none' }}>视图：</span>
            {viewTabs.map((t) => {
              const active = view === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => selectView(t.id)}
                  title={t.id === INBOX_VIEW
                    ? '收件箱（当前用户名下的待办：backlog/todo/in_progress + 总数）'
                    : t.id === ''
                      ? '默认列表（未完成 issue）'
                      : `saved view：${t.name}`}
                  style={{
                    flex: 'none', height: 26, padding: '0 12px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 12, whiteSpace: 'nowrap',
                    border: active ? '1px solid var(--dsw-alias-state-business-primary)' : '1px solid var(--dsw-alias-border-l2)',
                    background: active ? 'var(--dsw-alias-state-business-tertiary)' : 'transparent',
                    color: active ? 'var(--dsw-alias-label-primary-bluish)' : 'var(--dsw-alias-label-secondary)',
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {t.id === INBOX_VIEW ? '📥 收件箱' : t.name}
                </button>
              )
            })}
          </div>
        )}
        {/* 分组/看板 模式：提示 + 显示切换（saved view 与收件箱共用，按 workspace+view 记忆）；
            收件箱另有 --all 范围开关（追加我名下的 in_review/done，仍排除 closed/canceled） */}
        {(viewLocked || inboxMode) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, flex: 1, minWidth: 0 }}>
              {loading
                ? '加载中…'
                : items.length === 0
                  ? (inboxMode ? '收件箱 · 共 0 条' : '按状态分组 · 共 0 条')
                  : display === 'kanban'
                    ? `看板 · 进行中 ${kanbanColumns.reduce((n, c) => n + c.items.length, 0)} 条 / ${kanbanColumns.length} 列`
                    : inboxMode
                      ? `收件箱 · 共 ${inboxTotal} 条 / ${groups.length} 组`
                      : `按状态分组 · 共 ${items.length} 条 / ${groups.length} 组`}
            </div>
            {inboxMode && (
              <div style={{ display: 'flex', flex: 'none', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2)' }}>
                {([false, true] as const).map((all) => (
                  <button
                    key={String(all)}
                    onClick={() => setInboxAll(all)}
                    title={all
                      ? '追加我名下的 in_review 与 done（仍排除 closed/canceled）'
                      : '我名下的 backlog / todo / in_progress'}
                    style={{
                      height: 24, padding: '0 12px', cursor: 'pointer', fontSize: 12, border: 'none', whiteSpace: 'nowrap',
                      background: inboxAll === all ? 'var(--dsw-alias-state-business-tertiary)' : 'transparent',
                      color: inboxAll === all ? 'var(--dsw-alias-label-primary-bluish)' : 'var(--dsw-alias-label-secondary)',
                      fontWeight: inboxAll === all ? 500 : 400,
                    }}
                  >
                    {all ? '含待核对/已完成' : '进行中'}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flex: 'none', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2)' }}>
              {(['list', 'kanban'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => switchDisplay(m)}
                  title={m === 'list' ? '分组列表' : '看板'}
                  style={{
                    height: 24, padding: '0 12px', cursor: 'pointer', fontSize: 12, border: 'none',
                    background: display === m ? 'var(--dsw-alias-state-business-tertiary)' : 'transparent',
                    color: display === m ? 'var(--dsw-alias-label-primary-bluish)' : 'var(--dsw-alias-label-secondary)',
                    fontWeight: display === m ? 500 : 400,
                  }}
                >
                  {m === 'list' ? '列表' : '看板'}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 筛选：状态 / 类型 / 项目 + 刷新（搜索框已移到标题栏；saved view 下隐藏筛选） */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!viewLocked && (
            <>
              <select
                value={filters.status} disabled={searchMode || ctx === null}
                onChange={(e) => updateFilter({ status: e.target.value })}
                style={{ height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none' }}
              >
                <option value="">全部状态</option>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <select
                value={filters.type} disabled={searchMode || ctx === null}
                onChange={(e) => updateFilter({ type: e.target.value })}
                style={{ height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none' }}
              >
                <option value="">全部类型</option>
                {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              <select
                value={filters.project} disabled={searchMode || ctx === null}
                onChange={(e) => updateFilter({ project: e.target.value })}
                style={{ height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none', maxWidth: 160 }}
              >
                <option value="">全部项目</option>
                {projectOptions.map((p) => <option key={p.key} value={p.key}>{p.name || p.key}</option>)}
              </select>
            </>
          )}
        </div>
        {/* 标签多选 */}
        {labelValues.length > 0 && !viewLocked && !searchMode && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>标签：</span>
            {labelValues.map((lv) => {
              const active = filters.labels.includes(lv)
              return (
                <button
                  key={lv}
                  onClick={() => updateFilter({ labels: active ? filters.labels.filter((x) => x !== lv) : [...filters.labels, lv] })}
                  style={{
                    height: 22, padding: '0 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
                    border: active ? '1px solid var(--dsw-alias-state-business-primary)' : '1px solid var(--dsw-alias-border-l2)',
                    background: active ? 'var(--dsw-alias-state-business-tertiary)' : 'transparent',
                    color: active ? 'var(--dsw-alias-label-primary-bluish)' : 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  {lv}
                </button>
              )
            })}
          </div>
        )}
        {/* 搜索截断提示 */}
        {searchMode && (
          <div style={{ color: 'var(--dsw-alias-state-warn-label)', fontSize: 12 }}>
            搜索不支持分页，最多显示前 {SEARCH_LIMIT} 条结果。
          </div>
        )}
      </div>

      {/* 列表主体 */}
      {(viewLocked || inboxMode) && display === 'kanban'
        ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '8px 16px' }}>
            {error !== null && <ErrorCard message={error} onRetry={() => resetAndLoad(filters, workspace, true)} />}
            {!error && loading && items.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>加载中…</div>
            )}
            {!error && !loading && kanbanColumns.length === 0 && <EmptyState text="没有进行中的 issue" />}
            {!error && !loading && kanbanColumns.length > 0 && (
              /* 看板：非空列均分铺满一屏（无横向滚动），列内独立纵向滚动、列头常驻。
                 列容器用 columnGlass（与主面板同源的玻璃，只更通透），列头再压一层
                 更实的玻璃填充形成层次；不再重复 backdrop-filter（避免嵌套模糊叠影）。 */
              <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12 }}>
                {kanbanColumns.map((col) => (
                  <div key={col.key} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, borderRadius: 12, border: columnGlass.border, background: columnGlass.bg, boxShadow: columnGlass.shadow, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flex: 'none', borderBottom: columnGlass.border, background: 'var(--dsw-alias-interactive-bg-hover)' }}>
                      <span style={{ flex: 'none', width: 3, height: 12, borderRadius: 2, background: toneColor(col.tone) }} />
                      <span style={{ flex: 'none', fontSize: 12, fontWeight: 600 }}>{col.label}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{
                        flex: 'none', fontSize: 11, lineHeight: '18px', padding: '0 8px', borderRadius: 999,
                        color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)',
                      }}>{col.items.length}</span>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '10px 10px 6px' }}>
                      {col.items.map((it) => <KanbanCard key={it.id} it={it} glass={cardGlass} onLoad={onLoad} loading={loadingId === it.id} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
        : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 16px' }}>
            {error !== null && <ErrorCard message={error} onRetry={() => resetAndLoad(filters, workspace, true)} />}
            {!error && items.length === 0 && !loading && <EmptyState text={inboxMode ? '收件箱是空的' : '没有匹配的 issue'} />}
            {(viewLocked || inboxMode)
              ? groups.map((g, gi) => (
                  // 组间距：只加在组与组之间（首组不额外留白，紧贴列表主体 padding）
                  <div key={g.key} style={{ marginTop: gi === 0 ? 0 : 24 }}>
                    {/* 分组段带：固定底色 + 状态色条 + 紧凑标签，与条目行明显区分 */}
                    <button
                      onClick={() => toggleGroup(g.key)}
                      title={collapsed.has(g.key) ? '展开该组' : '折叠该组'}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, boxSizing: 'border-box', width: '100%',
                        padding: '7px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                        border: 'none', background: 'var(--dsw-alias-interactive-bg-hover)',
                        color: 'var(--dsw-alias-label-secondary)',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-bg-elevated)' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
                    >
                      <span style={{ flex: 'none', width: 3, height: 14, borderRadius: 2, background: toneColor(g.tone) }} />
                      <span style={{ flex: 'none', fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>{g.label}</span>
                      <span style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{g.items.length} 条</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                        {collapsed.has(g.key) ? '展开 ▸' : '收起 ▾'}
                      </span>
                    </button>
                    {!collapsed.has(g.key) && g.items.map((it, ii) => <IssueRowItem key={it.id} it={it} groupLead={ii === 0} onLoad={onLoad} loading={loadingId === it.id} />)}
                  </div>
                ))
              : items.map((it) => (
                  <IssueRowItem key={it.id} it={it} onLoad={onLoad} loading={loadingId === it.id} />
                ))}
            {loading && items.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>加载中…</div>}
            {loadingMore && <div style={{ padding: 16, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>加载更多…</div>}
            {!searchMode && !viewLocked && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
            {!searchMode && !viewLocked && !hasMore && items.length > 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>已到底部</div>
            )}
          </div>
        )}
    </div>
  )
}

/* ---------------- 详情视图 ---------------- */

function DetailView({ id, onLoad, loadBusy }: { id: string; onLoad: (id: string) => void; loadBusy: boolean }): ReactNode {
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const load = useCallback((): void => {
    setLoading(true)
    setError(null)
    void getIssue(id)
      .then((r) => setDetail(r.issue))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(load, [load])

  const copyId = (): void => {
    void writeClipboard(id).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    })
  }

  // 详情内的次级玻璃卡（元数据 / 评论）与主面板同源，保持统一玻璃风格。
  const { aqua, dark } = useAquaSkin()
  const detailCardGlass = glassRecipe(aqua, dark, FROST_BOOST_CARD)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 详情头部 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: 'none' }}>
        <Button variant="ghost" size="sm" onClick={backToList}>← 返回列表</Button>
        <span style={{ flex: 1 }} />
        <Button variant="outline" size="sm" onClick={() => window.open(SEEKER_WEB_ROOT, '_blank', 'noopener')}>
          在 Seeker Web 打开
        </Button>
        <Button variant="outline" size="sm" disabled={loadBusy} onClick={() => onLoad(id)}>
          {loadBusy ? '加载中…' : '加载到新会话'}
        </Button>
        <Button variant="ghost" size="sm" onClick={copyId}>
          {copied ? '✓ 已复制' : '复制编号'}
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px' }}>
        {error !== null && <ErrorCard message={error} onRetry={load} />}
        {loading && !error && <div style={{ padding: 24, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>加载中…</div>}
        {!loading && !error && detail !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto' }}>
            {/* 标题 + 徽标 */}
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <Pill tone={typeTone(detail.type)}>{detail.type !== undefined ? TYPE_LABEL[detail.type] ?? detail.type : '—'}</Pill>
                <Pill tone={statusTone(detail.status)}>{detail.status !== undefined ? STATUS_LABEL[detail.status] ?? detail.status : '—'}</Pill>
                {detail.priority !== undefined && detail.priority !== '' && <Pill tone="neutral">优先级 {detail.priority}</Pill>}
                <span style={{ color: 'var(--dsw-alias-state-business-primary)', fontSize: 13 }}>{detail.id}</span>
              </div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.3, color: 'var(--dsw-alias-label-primary)' }}>
                {detail.title ?? '(无标题)'}
              </h1>
            </div>

            {/* 元数据：玻璃卡，值与正文分离（label-secondary） */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6, padding: 12, borderRadius: 12, border: detailCardGlass.border, background: detailCardGlass.bg, boxShadow: detailCardGlass.shadow }}>
              <Field label="项目" value={detail.project !== undefined && detail.project !== '' ? detail.project : '—'} />
              <Field label="负责人" value={detail.assigneeIdentity?.displayName ?? detail.assignee ?? '—'} />
              <Field label="报告人" value={detail.reporterIdentity?.displayName ?? detail.reporter ?? '—'} />
              <Field label="创建" value={formatTime(detail.createdAt) || '—'} />
              <Field label="更新" value={formatTime(detail.updatedAt) || '—'} />
            </div>

            {/* 标签 */}
            {detail.labels !== undefined && detail.labels.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {detail.labels.map((l) => <Pill key={l} tone="accent">{l}</Pill>)}
              </div>
            )}

            {/* 正文 markdown：独立正文 token（label-primary），与元数据分离 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>描述</div>
              <div style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: 1.7 }}>
                {detail.bodyText !== undefined && detail.bodyText !== ''
                  ? <MarkdownText text={detail.bodyText} labels={MARKDOWN_LABELS} />
                  : <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>（无描述）</span>}
              </div>
            </div>

            {/* 评论：玻璃卡 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                评论（{detail.comments?.length ?? 0}）
              </div>
              {(detail.comments ?? []).length === 0 && (
                <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>暂无评论</div>
              )}
              {(detail.comments ?? []).map((c) => (
                <div key={c.id} style={{ padding: 12, borderRadius: 12, border: detailCardGlass.border, background: detailCardGlass.bg, boxShadow: detailCardGlass.shadow }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 500 }}>{c.authorDisplayName ?? '匿名'}</span>
                    {c.kind !== undefined && <Pill tone="neutral">{c.kind}</Pill>}
                    {c.agent !== undefined && <Pill tone="neutral">{c.agent}</Pill>}
                    <span style={{ flex: 1 }} />
                    <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{formatTime(c.createdAt)}</span>
                  </div>
                  <div style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                    {c.bodyText !== undefined && c.bodyText !== ''
                      ? <MarkdownText text={c.bodyText} labels={MARKDOWN_LABELS} />
                      : <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>（空评论）</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 「加载」选择弹窗（工作区 + 模型） ----------------
 * 点击「加载」→ 弹窗选择新会话的工作区（DSH workspace 目录，决定新会话 cwd /
 * GUI 分组）和模型；默认选中持久化记忆的上次选择（localStorage）。
 * 工作区列表来自 ctx.workspaces（WorkspaceView.items），模型列表来自
 * ctx.modelDirectories（per-session ModelDirectory，load() 拉取 groups）。
 */

interface LoadDialogProps {
  issueId: string
  sessions: LoadSessions
  workspaces: LooseWorkspaces
  modelDirectories: LooseModelDirectories
  busy: boolean
  onCancel(): void
  onConfirm(opts: { cwd: string; model: { provider: string; model: string } | undefined }): void
}

/** 模型条目（provider + model 拍平）。 */
interface FlatModel {
  provider: string
  model: string
  label: string
}

/** 模型提供者分组（ModelProviderGroup 宽松面）。 */
interface ModelGroup {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

function LoadDialog({ issueId, sessions, workspaces, modelDirectories, busy, onCancel, onConfirm }: LoadDialogProps): ReactNode {
  const { aqua, dark } = useAquaSkin()
  const glass = glassRecipe(aqua, dark, FROST_BOOST_SURFACE)

  const workspaceItems = workspaces.list.getSnapshot().items
  const fallbackCwd = currentSessionCwd(sessions) ?? workspaceItems[0]?.path ?? ''

  // 工作区默认选中：持久化记忆优先（仍有效时），否则当前会话 cwd / 第一个 workspace。
  const [selWorkspace, setSelWorkspace] = useState<string>(() => {
    const remembered = getLoadDefaults().workspacePath
    if (remembered !== undefined && remembered !== '' && workspaceItems.some((w) => w.path === remembered)) return remembered
    return fallbackCwd
  })
  // 模型默认选中：持久化记忆的 provider/model（模型列表加载后校正）；'' = 默认模型。
  const [selModelKey, setSelModelKey] = useState<string>('')
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])
  const [modelLoading, setModelLoading] = useState(true)
  const [modelError, setModelError] = useState<string | null>(null)

  // 加载当前会话的模型目录（GUI 模型选择器同款数据源）。
  useEffect(() => {
    let alive = true
    const sid = currentSessionId(sessions)
    if (sid === undefined) {
      setModelLoading(false)
      return
    }
    let dir: ReturnType<LooseModelDirectories['directoryFor']> | null = null
    try {
      dir = modelDirectories.directoryFor(sid)
    } catch {
      setModelLoading(false)
      return
    }
    void dir.load()
      .then(() => {
        if (!alive || dir === null) return
        setModelGroups((dir.store.getSnapshot() as { groups: ModelGroup[] }).groups ?? [])
      })
      .catch((e) => {
        if (alive) setModelError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setModelLoading(false)
      })
    return () => { alive = false }
  }, [modelDirectories, sessions])

  const flatModels = useMemo<FlatModel[]>(() => {
    const out: FlatModel[] = []
    for (const g of modelGroups) {
      for (const m of g.models) out.push({ provider: g.id, model: m.id, label: `${g.name} · ${m.name}` })
    }
    return out
  }, [modelGroups])

  const modelKeyOf = (provider: string, model: string): string => `${provider}::${model}`

  // 模型默认选中：持久化记忆的 provider/model（模型列表到达后校正一次）。
  useEffect(() => {
    const d = getLoadDefaults()
    if (d.provider !== undefined && d.model !== undefined) {
      const key = modelKeyOf(d.provider, d.model)
      if (flatModels.some((m) => modelKeyOf(m.provider, m.model) === key)) setSelModelKey(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatModels])

  const confirm = (): void => {
    const cwd = selWorkspace !== '' ? selWorkspace : fallbackCwd
    let model: { provider: string; model: string } | undefined
    if (selModelKey !== '') {
      const [provider, ...rest] = selModelKey.split('::')
      const mid = rest.join('::')
      if (provider !== undefined && mid !== '') model = { provider, model: mid }
    }
    setLoadDefaults({ workspacePath: cwd, ...(model ?? {}) })
    onConfirm({ cwd, model })
  }

  const selectStyle: React.CSSProperties = {
    width: '100%', height: 32, padding: '0 8px', borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none',
  }

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--dsw-alias-bg-mask-2)',
    }}>
      <div style={{
        width: 420, maxWidth: 'calc(100% - 48px)', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', gap: 10,
        borderRadius: 14, padding: 18,
        border: glass.border, background: glass.bg, boxShadow: glass.shadow,
        backdropFilter: glass.blur, WebkitBackdropFilter: glass.blur,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>加载到新会话</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {issueId} 将作为新会话的第一条可见消息，选择会话的工作区与模型。
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>工作区（新会话目录 / GUI 分组）</span>
          <select value={selWorkspace} onChange={(e) => setSelWorkspace(e.target.value)} style={selectStyle}>
            {workspaceItems.length === 0 && <option value="">（无已注册工作区，将沿用当前会话目录）</option>}
            {workspaceItems.map((w) => (
              <option key={w.workspaceId} value={w.path}>{w.title}（{w.path}）</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>模型</span>
          <select value={selModelKey} onChange={(e) => setSelModelKey(e.target.value)} disabled={modelLoading} style={selectStyle}>
            <option value="">默认模型</option>
            {flatModels.map((m) => (
              <option key={modelKeyOf(m.provider, m.model)} value={modelKeyOf(m.provider, m.model)}>{m.label}</option>
            ))}
          </select>
          {modelLoading && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>加载模型中…</span>}
          {!modelLoading && modelError !== null && (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>模型加载失败：{modelError}</span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              height: 30, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)', fontSize: 13,
            }}
          >
            取消
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{
              height: 30, padding: '0 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
              border: 'none', background: 'var(--dsw-alias-state-business-primary)', color: '#fff',
              fontSize: 13, fontWeight: 500,
            }}
          >
            {busy ? '加载中…' : '确认加载'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 覆盖层主体 ---------------- */

function WorkbenchSurface({ sessions, workspaces, modelDirectories }: {
  sessions: LoadSessions
  workspaces: LooseWorkspaces
  modelDirectories: LooseModelDirectories
}): ReactNode {
  const state = useSyncExternalStore(subscribe, getState)
  const [ctx, setCtx] = useState<FetchContextResult | null>(null)
  const [ctxError, setCtxError] = useState<string | null>(null)
  // 搜索词提升到覆盖层（标题栏居中）；saved view 由 store 记忆（localStorage 持久，
  // 下次打开面板恢复最近一次进入的 saved view）
  const [search, setSearch] = useState('')
  const view = state.savedView
  const workspace = state.workspace
  // 列表的重新加载（标题栏「刷新」按钮通过它触发；列表卸载时为空）
  const listReloadRef = useRef<(() => void) | null>(null)
  // 刷新：saved view 会话缓存先失效，再触发当前列表重载
  const refresh = useCallback((): void => {
    clearViewCache(workspace, view)
    listReloadRef.current?.()
  }, [workspace, view])

  // 「加载」操作状态：正在加载的 issue id（对应按钮加载中态）+ 失败提示。
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 「加载」选择弹窗：非 null = 待加载的 issue id（弹窗打开中）。
  const [loadTarget, setLoadTarget] = useState<string | null>(null)
  // 失败提示 toast：5s 后自动消失。
  useEffect(() => {
    if (loadError === null) return
    const t = setTimeout(() => setLoadError(null), 5000)
    return () => clearTimeout(t)
  }, [loadError])

  // 「加载」点击 → 打开选择弹窗（工作区 + 模型，默认持久化记忆），确认后才真正加载。
  const handleLoad = useCallback((issueId: string): void => {
    if (loadingId !== null) return
    setLoadTarget(issueId)
  }, [loadingId])

  // 弹窗确认 → 宿主创建新会话（选中工作区 cwd + 模型）并把 issue 注入为首条
  // 用户消息 → 切到新会话并关闭覆盖层。每次点击都新建会话；失败时提示且不切走。
  // 绑定：把当前选中的 Seeker workspace（state.workspace，即 issue 所属项目的工作区）
  // 作为会话的 workspace 绑定传给 host（写 .seeker/workspace.json）。
  const confirmLoad = useCallback((issueId: string, opts: { cwd: string; model: { provider: string; model: string } | undefined }): void => {
    setLoadTarget(null)
    setLoadingId(issueId)
    setLoadError(null)
    const loadOpts: { workspace?: string; cwd?: string; model?: { provider: string; model: string } } = {}
    if (workspace !== '') loadOpts.workspace = workspace
    if (opts.cwd !== '') loadOpts.cwd = opts.cwd
    if (opts.model !== undefined) loadOpts.model = opts.model
    void loadIssue(issueId, loadOpts)
      .then(async (r) => {
        await openLoadedSession(sessions, r.sessionId)
        setOpen(false)
      })
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoadingId(null))
  }, [sessions, workspace])

  // 拉取上下文（workspace 列表 + 当前 workspace 的项目/标签/views）。
  // 走 client TTL 缓存：重复打开 / 快速切换 workspace 命中即零请求；
  // 首次（workspace 未记忆）由 host 顺带返回第一个 workspace 的元数据并
  // 自动选定，不再二次拉取。
  useEffect(() => {
    let alive = true
    setCtxError(null)
    void fetchContextCached(workspace === '' ? undefined : workspace)
      .then((r) => {
        if (!alive) return
        setCtx(r)
        // 首次：若 workspace 未记忆，取第一个
        if (workspace === '' && r.workspaces[0] !== undefined) setWorkspace(r.workspaces[0].key)
        // 记忆的 saved view 在当前 workspace 已不存在（被删除/换 workspace）→ 回退默认；
        // 收件箱（INBOX_VIEW）不是 saved view，恒有效，不参与存在性校验。
        if (state.savedView !== '' && state.savedView !== INBOX_VIEW && !(r.views ?? []).some((v) => v.id === state.savedView)) {
          setSavedView('')
        }
      })
      .catch((e) => {
        if (alive) setCtxError(e instanceof Error ? e.message : String(e))
      })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  const seekerWorkspaces: WorkspaceRow[] = ctx?.workspaces ?? []
  const showDetail = state.view === 'detail' && state.detailId !== null

  // 面板尺寸：3:2（宽:高），top/bottom 边距收窄，按视口自适应
  const { width: panelWidth, height: panelHeight } = usePanelSize()

  // aqua 深度适配：激活时用 aqua 的玻璃卡片配方（token 实时跟随模糊/磨砂旋钮与
  // 明暗模式），未激活回退到应用的通用毛玻璃配方（--dsw-alias-bg-mask-drop）。
  // 与看板列/卡片共用同一 glassRecipe，保证整机统一玻璃风格；面板用较大的
  // 磨砂加强系数（更实更奶）+ 加大模糊 + 外投影，作为最底层的主表面。
  const { aqua, dark } = useAquaSkin()
  const surface = glassRecipe(aqua, dark, FROST_BOOST_SURFACE)
  const surfaceShadow = aqua
    ? (dark
        ? `${surface.shadow}, 0 10px 36px rgba(2,6,14,0.5)`
        : `${surface.shadow}, 0 10px 36px rgba(19,45,83,0.16)`)
    : 'var(--dsw-shadow-lv3)'

  return (
    <>
      {/* 全屏模态 backdrop：点击面板外部关闭（模态对话框语义）。覆盖层层的直接
          子元素自动恢复 pointer-events，故此处可接收点击。 */}
      <div
        onClick={() => setOpen(false)}
        role="presentation"
        aria-hidden="true"
        title="点击外部关闭 Seeker 工作台"
        style={{
          position: 'absolute', inset: 0,
          background: 'var(--dsw-alias-bg-mask-2)',
        }}
      />
      {/* 居中容器（pointer-events 穿透到 backdrop；面板自身恢复） */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{
          position: 'relative',
          width: panelWidth, height: panelHeight,
          pointerEvents: 'auto',
          background: surface.bg,
          backdropFilter: surface.blur,
          WebkitBackdropFilter: surface.blur,
          border: surface.border,
          borderRadius: 16,
          boxShadow: surfaceShadow,
          display: 'flex', flexDirection: 'column',
          minWidth: 0, minHeight: 0, overflow: 'hidden',
        }}>
        {/* 覆盖层头部：标题 + 居中搜索框 + workspace 切换 + 关闭 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 16px', height: 48, flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 14, fontWeight: 600 }}>Seeker 工作台</span>
          </div>
          {/* 搜索框：标题栏居中；进入 saved view 时隐藏（筛选/搜索被锁定）。
              外层 flex:1 撑杆始终保留，否则右侧控件会塌缩到左侧标题旁。 */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
            {view === '' && (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索标题 / 编号…"
                style={{
                  width: 'min(100%, 420px)', height: 30, padding: '0 10px', borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none',
                }}
              />
            )}
          </div>
          {/* workspace 切换（ctx 未到时禁用，避免选中空值） */}
          <select
            value={workspace}
            disabled={ctx === null}
            onChange={(e) => setWorkspace(e.target.value)}
            style={{ height: 28, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none' }}
          >
            {ctx === null && <option value="">加载中…</option>}
            {ctx !== null && seekerWorkspaces.length === 0 && <option value="">（无 workspace）</option>}
            {ctx !== null && seekerWorkspaces.map((w) => <option key={w.key} value={w.key}>{w.name}（{w.key}）</option>)}
          </select>
          <Button variant="toolbar" size="sm" onClick={refresh} disabled={showDetail || ctx === null}>
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>✕ 关闭</Button>
        </div>

        {/* 主体 */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {ctxError !== null && <ErrorCard message={ctxError} onRetry={() => { setCtxError(null); void fetchContextCached(workspace === '' ? undefined : workspace).then(setCtx).catch((e) => setCtxError(e instanceof Error ? e.message : String(e))) }} />}
          {/* workspace 未知时先等 context（首次打开：ctx 到达后自动选第一个 workspace） */}
          {ctxError === null && workspace === '' && <div style={{ padding: 48, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>加载中…</div>}
          {/* workspace 已知即可挂列表：列表与 context 并行拉取（ctx 未到前筛选控件禁用） */}
          {ctxError === null && workspace !== '' && (
            showDetail && state.detailId !== null
              ? <DetailView id={state.detailId} onLoad={handleLoad} loadBusy={loadingId === state.detailId} />
              : (
                <ListView
                  workspace={workspace}
                  ctx={ctx}
                  search={search}
                  view={view}
                  reloadRef={listReloadRef}
                  onViewChange={(v) => { setSavedView(v); setSearch('') }}
                  onLoad={handleLoad}
                  loadingId={loadingId}
                />
              )
          )}
          {/* 「加载」失败提示：面板底部 toast，5s 自动消失 */}
          {loadError !== null && (
            <div style={{
              position: 'absolute', left: 16, right: 16, bottom: 16,
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--dsw-alias-state-error-primary)',
              color: '#fff', fontSize: 13, boxShadow: 'var(--dsw-shadow-lv3)',
              zIndex: 5,
            }}>
              加载失败：{loadError}
            </div>
          )}
        </div>
        {/* 「加载」选择弹窗：覆盖整个面板（zIndex 6 > toast 5），选工作区 + 模型 */}
        {loadTarget !== null && (
          <LoadDialog
            issueId={loadTarget}
            sessions={sessions}
            workspaces={workspaces}
            modelDirectories={modelDirectories}
            busy={loadingId === loadTarget}
            onCancel={() => setLoadTarget(null)}
            onConfirm={(opts) => confirmLoad(loadTarget, opts)}
          />
        )}
      </div>
      </div>
    </>
  )
}

/* ---------------- 覆盖层入口（shell.overlay 条目） ---------------- */

/**
 * shell.overlay 覆盖层条目：打开时渲染全屏工作台，关闭时渲染 null。
 * 层本身 click-through，本条目根部恢复 pointer-events（`>*` 已由框架处理）。
 */
export function SeekerOverlayEntry({ sessions, workspaces, modelDirectories }: {
  sessions?: LoadSessions
  workspaces?: LooseWorkspaces
  modelDirectories?: LooseModelDirectories
}): ReactNode {
  const open = useSyncExternalStore(subscribe, () => getState().open)

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <WorkbenchSurface
      sessions={sessions ?? { openSession: () => {}, list: { getSnapshot: () => ({ ids: [] }) } }}
      workspaces={workspaces ?? { list: { getSnapshot: () => ({ items: [] }) } }}
      modelDirectories={modelDirectories ?? {
        directoryFor: () => ({ load: async () => {}, store: { getSnapshot: () => ({ groups: [], status: 'error' }) } }),
      }}
    />
  )
}
