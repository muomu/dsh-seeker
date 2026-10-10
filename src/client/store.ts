/**
 * Seeker 工作台 client 状态（v3 重构）：模块级内存 store。
 * - open：覆盖层是否打开（侧边栏按钮 ↔ 覆盖层组件跨槽位共享）；
 * - 浏览位置：workspace / 列表 or 详情 / 详情 id —— 关闭再打开恢复（内存态，
 *   刷新丢失）；workspace 与 savedView 另由 localStorage 持久记忆。
 * - saved view 全量结果：会话缓存（workspace+view 键），手动刷新失效。
 * 零依赖：useSyncExternalStore 直接订阅。
 */

import type { IssueRow } from './api.ts'

export interface WorkbenchState {
  open: boolean
  /** 当前 workspace key（localStorage 持久）。 */
  workspace: string
  /** 最近一次进入的 saved view id；'' 表示默认列表（localStorage 持久）。 */
  savedView: string
  /** 当前视图：list | detail。 */
  view: 'list' | 'detail'
  /** detail 视图下的 issue id。 */
  detailId: string | null
}

const WS_KEY = 'dsh-seeker.workspace'
const SAVED_VIEW_KEY = 'dsh-seeker.saved-view'

function loadWorkspace(): string {
  try {
    const saved = localStorage.getItem(WS_KEY)
    if (saved !== null && saved !== '') return saved
  } catch {
    // localStorage 不可用时忽略
  }
  return ''
}

function saveWorkspace(workspace: string): void {
  try {
    if (workspace === '') localStorage.removeItem(WS_KEY)
    else localStorage.setItem(WS_KEY, workspace)
  } catch {
    // 忽略
  }
}

function loadSavedView(): string {
  try {
    const saved = localStorage.getItem(SAVED_VIEW_KEY)
    if (saved !== null && saved !== '') return saved
  } catch {
    // localStorage 不可用时忽略
  }
  return ''
}

function saveSavedView(savedView: string): void {
  try {
    if (savedView === '') localStorage.removeItem(SAVED_VIEW_KEY)
    else localStorage.setItem(SAVED_VIEW_KEY, savedView)
  } catch {
    // 忽略
  }
}

/* ---------------- saved view 显示模式（分组列表 / 看板） ----------------
 * 按 workspace+view 记忆（localStorage，key 形如 `workspace:view`）。
 * view 为空（默认列表）无记忆，恒为分组列表。
 */

const VIEW_DISPLAY_KEY = 'dsh-seeker.view-display'

export type ViewDisplayMode = 'list' | 'kanban'

function readViewDisplayMap(): Record<string, ViewDisplayMode> {
  try {
    const raw = localStorage.getItem(VIEW_DISPLAY_KEY)
    if (raw !== null && raw !== '') {
      const parsed = JSON.parse(raw) as Record<string, ViewDisplayMode>
      if (typeof parsed === 'object' && parsed !== null) return parsed
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return {}
}

/** 读取指定 workspace+view 的记忆显示模式（默认分组列表；view 为空恒为列表）。 */
export function getViewDisplay(workspace: string, view: string): ViewDisplayMode {
  if (view === '') return 'list'
  const mode = readViewDisplayMap()[`${workspace}:${view}`]
  return mode === 'kanban' ? 'kanban' : 'list'
}

/** 记忆指定 workspace+view 的显示模式（列表为默认，直接移除条目）。 */
export function setViewDisplay(workspace: string, view: string, mode: ViewDisplayMode): void {
  if (view === '') return
  try {
    const map = readViewDisplayMap()
    const key = `${workspace}:${view}`
    if (mode === 'kanban') map[key] = 'kanban'
    else delete map[key]
    localStorage.setItem(VIEW_DISPLAY_KEY, JSON.stringify(map))
  } catch {
    // 忽略
  }
}

/* ---------------- 「加载」默认值持久化记忆 ----------------
 * 加载弹窗（选择会话工作区 + 模型）默认选中上次的选择；localStorage 持久，
 * 下次打开弹窗恢复。值可能是空的（用户未选过 / 记忆被清）。
 */

export interface LoadDefaults {
  /** 会话工作区目录（DSH workspace path，新会话 cwd）。 */
  workspacePath?: string
  /** 模型提供者 route id。 */
  provider?: string
  /** 模型 id。 */
  model?: string
}

const LOAD_DEFAULTS_KEY = 'dsh-seeker.load-defaults'

function readLoadDefaults(): LoadDefaults {
  try {
    const raw = localStorage.getItem(LOAD_DEFAULTS_KEY)
    if (raw !== null && raw !== '') {
      const parsed = JSON.parse(raw) as LoadDefaults
      if (typeof parsed === 'object' && parsed !== null) return parsed
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return {}
}

/** 读取上次「加载」的选择（可能为空对象）。 */
export function getLoadDefaults(): LoadDefaults {
  return readLoadDefaults()
}

/** 记忆本次「加载」的选择（供下次弹窗默认选中）。 */
export function setLoadDefaults(defaults: LoadDefaults): void {
  try {
    const clean: LoadDefaults = {}
    if (defaults.workspacePath !== undefined && defaults.workspacePath !== '') clean.workspacePath = defaults.workspacePath
    if (defaults.provider !== undefined && defaults.provider !== '') clean.provider = defaults.provider
    if (defaults.model !== undefined && defaults.model !== '') clean.model = defaults.model
    if (Object.keys(clean).length === 0) localStorage.removeItem(LOAD_DEFAULTS_KEY)
    else localStorage.setItem(LOAD_DEFAULTS_KEY, JSON.stringify(clean))
  } catch {
    // 忽略
  }
}

let state: WorkbenchState = {
  open: false,
  workspace: loadWorkspace(),
  savedView: loadSavedView(),
  view: 'list',
  detailId: null,
}

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  for (const fn of listeners) fn()
}

function setState(patch: Partial<WorkbenchState>): void {
  state = { ...state, ...patch }
  if (patch.workspace !== undefined) saveWorkspace(patch.workspace)
  if (patch.savedView !== undefined) saveSavedView(patch.savedView)
  emit()
}

/** 打开/关闭覆盖层。 */
export function setOpen(open: boolean): void {
  if (state.open === open) return
  setState({ open })
}

/** 切换 workspace（同时重置浏览位置到列表）。 */
export function setWorkspace(workspace: string): void {
  if (state.workspace === workspace) return
  setState({ workspace, view: 'list', detailId: null })
}

/** 记录最近进入的 saved view（'' = 默认列表；localStorage 持久，下次打开恢复）。 */
export function setSavedView(savedView: string): void {
  if (state.savedView === savedView) return
  setState({ savedView })
}

/** 打开详情视图（记忆浏览位置）。 */
export function openDetail(id: string): void {
  setState({ view: 'detail', detailId: id })
}

/** 返回列表视图。 */
export function backToList(): void {
  setState({ view: 'list', detailId: null })
}

export function getState(): WorkbenchState {
  return state
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/* ---------------- saved view 全量结果会话缓存 ----------------
 * saved view 模式 host 每次全量翻页 ≈ 数批并发 CLI 调用；会话内按
 * workspace+view 缓存结果，重复进入 / 切换 view / 详情返回零请求。
 * 新鲜度由「刷新」按钮负责：点击先失效缓存再重拉。
 */

const VIEW_CACHE_MAX = 10
const viewCache = new Map<string, IssueRow[]>()

function viewCacheKey(workspace: string, view: string): string {
  return `${workspace}:${view}`
}

/** 读取会话缓存（view 为空或未命中返回 null）。 */
export function getViewCache(workspace: string, view: string): IssueRow[] | null {
  if (view === '') return null
  return viewCache.get(viewCacheKey(workspace, view)) ?? null
}

/** 写入会话缓存（超上限整体清空，简单 FIFO 语义）。 */
export function setViewCache(workspace: string, view: string, items: IssueRow[]): void {
  if (view === '') return
  if (viewCache.size >= VIEW_CACHE_MAX) viewCache.clear()
  viewCache.set(viewCacheKey(workspace, view), items)
}

/** 失效指定 workspace+view 的缓存（刷新按钮调用）。 */
export function clearViewCache(workspace: string, view: string): void {
  viewCache.delete(viewCacheKey(workspace, view))
}
