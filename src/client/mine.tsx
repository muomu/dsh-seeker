/**
 * 「我认领的 Seeker issue」hero 栏：注入 conversation.input.dock（list/session
 * 作用域，ConversationRoot 在 hero 与普通会话都会渲染它，位于输入卡上方一整行），
 * 仅当会话处于 hero（空白新会话，SessionSnapshot.blank === true）时渲染一排 issue
 * 卡片/chip（类 GPT 快捷操作），点击即经 /seeker/api/load 建新会话并切过去；
 * 会话已有内容（非 hero）返回 null，自然不显示。数据走 GET /seeker/api/mine
 * （零模型零会话）；拉取失败/为空都隐藏该栏。
 *
 * 槽位选择说明：设计稿写的是 conversation.session——但那是「整个会话正文」的
 * single 槽（宿主 ConversationSession 占位，动态注册的条目优先级更高会遮蔽它，
 * hero 之外返回 null 会让所有会话正文空白；平台契约见 dsh-client-ui-conversation
 * 的 slots 声明注释）。conversation.input.dock 是可叠加的 list 槽，hero 门控由
 * 组件自己做，效果与设计一致且不破坏正文。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { listMine, loadIssue, type IssueRow } from './api.ts'
import { currentSessionCwd, openLoadedSession, type LoadSessions } from './workbench.tsx'

/** 会话标准 kit 的宽松面（session 作用域槽位由框架注入 useSession/sessionId）。
 *  dsh 0.1.7-rc.2 起 useSession 选择的是 SessionSnapshot：hero（空白新会话）
 *  判定从旧的 conversation.composerPhase === 'blank' 改为 snapshot.blank。 */
interface SessionKit {
  sessionId: string
  useSession<S>(sel: (s: { blank?: boolean }) => S): S
}

export interface MineDockProps extends SessionKit {
  sessions: LoadSessions
}

/** hero 判定：与宿主 ConversationRoot 一致——空白会话（SessionSnapshot.blank）。 */
function useIsHero(useSession: SessionKit['useSession']): boolean {
  return useSession((s) => s.blank === true)
}

/** 单条 issue chip：id + 标题 + priority 标记；点击加载到新会话。 */
function MineChip({ it, loading, onLoad }: { it: IssueRow; loading: boolean; onLoad: (id: string) => void }): ReactNode {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={() => { if (!loading) onLoad(it.id) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={loading}
      title={loading ? '加载中…' : `${it.id}｜${it.title ?? '（无标题）'}\n点击加载到新会话`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 'none',
        maxWidth: 260, cursor: loading ? 'default' : 'pointer',
        height: 28, padding: '0 10px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: hovered && !loading ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12,
      }}
    >
      {it.priority !== undefined && it.priority !== '' && (
        <span style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' }}>
          P{it.priority.replace('P', '')}
        </span>
      )}
      <span style={{ flex: 'none', color: 'var(--dsw-alias-state-business-primary)' }}>{it.id}</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {it.title ?? '（无标题）'}
      </span>
    </button>
  )
}

/** hero 栏主体：hero 时拉取 /seeker/api/mine 并渲染 chip 排；非 hero / 空 / 失败返回 null。 */
export function SeekerMineDock(props: MineDockProps): ReactNode {
  const hero = useIsHero(props.useSession)
  const [items, setItems] = useState<IssueRow[]>([])
  const [workspace, setWorkspace] = useState<string | undefined>(undefined)
  // 正在加载的 issue id（chip 禁用态）+ 失败提示。
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // 竖滚轮转横滚（React 根事件是 passive，需原生监听才能 preventDefault）；
  // 已到两端时放行，让页面正常竖滚。
  useEffect(() => {
    const el = rowRef.current
    if (!hero || el === null) return
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      const atStart = el.scrollLeft <= 0 && e.deltaY < 0
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && e.deltaY > 0
      if (atStart || atEnd) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hero, items.length])

  // hero 才拉取（每次进入 hero 拉一次；whoami host 侧 60s TTL，列表实时）。
  useEffect(() => {
    if (!hero) return
    let alive = true
    void listMine()
      .then((r) => {
        if (!alive) return
        setItems(r.items)
        setWorkspace(r.workspace)
      })
      .catch(() => {
        // 拉取失败（skr 缺失/未登录/网络）：隐藏该栏，不打扰新会话页。
        if (alive) setItems([])
      })
    return () => { alive = false }
  }, [hero])

  // 失败提示 5s 后自动消失。
  useEffect(() => {
    if (loadError === null) return
    const t = setTimeout(() => setLoadError(null), 5000)
    return () => clearTimeout(t)
  }, [loadError])

  // 点击 chip：沿用覆盖层「加载」的代码路径——POST /seeker/api/load（workspace
  // 沿用 /mine 报告的当前绑定 workspace，cwd 取当前会话目录，模型走默认）→
  // 轮询 sessions.list → open 新会话。每次点击都新建会话；失败提示且不切走。
  const onLoad = (issueId: string): void => {
    if (loadingId !== null) return
    setLoadingId(issueId)
    setLoadError(null)
    const loadOpts: { workspace?: string; cwd?: string } = {}
    if (workspace !== undefined && workspace !== '') loadOpts.workspace = workspace
    const cwd = currentSessionCwd(props.sessions)
    if (cwd !== undefined && cwd !== '') loadOpts.cwd = cwd
    void loadIssue(issueId, loadOpts)
      .then((r) => openLoadedSession(props.sessions, r.sessionId))
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoadingId(null))
  }

  if (!hero || items.length === 0) return null
  return (
    // 左右边缘对齐输入卡：栏宽限到卡宽（--dsh-composer-card-max-width）并居中。
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      width: '100%', maxWidth: 'var(--dsh-composer-card-max-width)', margin: '0 auto',
    }}>
      <style>{'.seeker-mine-row::-webkit-scrollbar{display:none}'}</style>
      {loadError !== null && (
        <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          加载失败：{loadError}
        </span>
      )}
      <div
        ref={rowRef}
        className="seeker-mine-row"
        style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', minWidth: 0, maxWidth: '100%', scrollbarWidth: 'none' }}
      >
        {items.map((it) => (
          <MineChip key={it.id} it={it} loading={loadingId === it.id} onLoad={onLoad} />
        ))}
      </div>
    </div>
  )
}
