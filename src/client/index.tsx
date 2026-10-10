/**
 * dsh-seeker browser half（v3 重构，确定性 client UI）：
 * 1) 侧边栏底部（sidebar.footer.action）注册「Seeker」入口按钮——点击切换
 *    工作台覆盖层开关（shell.overlay）。
 * 2) shell.overlay（root 作用域框架级覆盖层）注册工作台条目——打开时渲染
 *    全屏 Seeker 工作台（列表 ↔ 详情，零模型、零会话，/seeker/api 直连）。
 * 3) conversation.input.dock（list/session 作用域）注册「我认领的 issue」栏——
 *    仅在 hero（空白新会话页）渲染一排 issue chip，点击即 /load 建新会话并切换。
 */
import type { Context } from '@deepseek-ai/cordis'
import { IconChecklistOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useState, useSyncExternalStore } from 'react'
import { getState, setOpen, subscribe } from './store.ts'
import { SeekerOverlayEntry, type LoadSessions, type SessionListSnapshot } from './workbench.tsx'
import { SeekerMineDock, type MineDockProps } from './mine.tsx'

/** 宽松槽位面：注册/注入 API（类型收紧由平台保证，这里避免引入槽位类型依赖）。 */
interface LooseSlots {
  inject(key: string, cb: () => unknown): unknown
  register(opts: Record<string, unknown>, component: (props: unknown) => ReactNode): () => void
}

/** 宽松 sessions 面：list 快照（SessionListState: ids/byId[/phase]）。
 *  dsh 0.1.7-rc.2 起会话导航不再挂在 ISessions 上（旧的 sessions.open 已移除），
 *  切主视图会话改走 ctx.uiWorkspace.openSession。 */
interface LooseSessions {
  list: { getSnapshot(): SessionListSnapshot }
}

/** 宽松会话导航面（dsh-client-ui-workspace 的 UiWorkspace）。 */
interface LooseUiWorkspace {
  openSession(target: string): void
}

/** 宽松 workspaces 面（WorkspaceRuntime.list 快照：items 为 WorkspaceView）。 */
interface LooseWorkspaces {
  list: { getSnapshot(): { items: Array<{ workspaceId: string; path: string; title: string }> } }
}

/** 宽松模型目录面（ModelDirectoryResolver.directoryFor → per-session ModelDirectory）。
 *  load() 拉取模型目录，store 快照带 groups（ModelProviderGroup[]）。 */
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

/* ---------------- 侧边栏入口 ---------------- */

/**
 * 「Seeker」侧边栏入口：占 sidebar.footer.action 行的一份（list 槽可多占用者）。
 * 展开态：经 ：has 钩子把宿主共享行改为可换行，每个占用者独占一整行
 * （高 36px、圆角 8px、图标 16px + 标签），同原生 settings 行观感；
 * 折叠 rail：行保持单排居中，36×36 圆形、图标 18px。
 * 悬浮/打开只切 --dsw-alias-interactive-bg-hover（原生 :hover 语义；inline style
 * 无法写 :hover，故用 mouse 事件状态实现），无过渡。
 */
function SeekerEntry(props: { wide: boolean }): ReactNode {
  // 订阅 store 的打开状态，保证 ESC / 关闭按钮退出后按钮文字同步。
  const open = useSyncExternalStore(subscribe, () => getState().open)
  const [hovered, setHovered] = useState(false)
  const click = (): void => {
    setOpen(!open)
  }
  return (
    <>
      {/* 共享 footer 行默认不换行；展开态下每个占用者独占一行（用量按钮同款
          约定），这个隐藏钩子挂在按钮前，靠 :has 把宿主行改为 wrap。 */}
      {props.wide ? <span className="dsut-rows-hook" /> : null}
      <button
        onClick={click}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title="Seeker 工作台（issue 列表 + 详情，覆盖层）"
        aria-pressed={open}
        style={{
          boxSizing: 'border-box', cursor: 'pointer',
          // 展开态：占用者独占一整行（行被 :has 钩子改为 wrap），同原生
          // settings 行观感；折叠 rail：36×36 圆形，与其它 rail 图标同排。
          width: props.wide ? '100%' : 36,
          minWidth: 0,
          flex: props.wide ? '0 0 100%' : '0 0 auto',
          height: 36,
          color: 'var(--dsw-alias-label-primary)',
          background: open || hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          border: 'none',
          borderRadius: props.wide ? 8 : '50%',
          alignItems: 'center',
          gap: props.wide ? 8 : 0,
          margin: 0,
          padding: props.wide ? '0 10px 0 8px' : 0,
          justifyContent: props.wide ? 'flex-start' : 'center',
          fontFamily: 'inherit', fontSize: 13, lineHeight: '22px',
          display: 'flex', overflow: 'hidden',
        }}
      >
        <IconChecklistOutlineMedium size={props.wide ? 16 : 18} />
        {props.wide && (
          <span style={{
            minWidth: 0, flex: '1 1 auto', textAlign: 'left',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {open ? 'Seeker（开）' : 'Seeker'}
          </span>
        )}
      </button>
    </>
  )
}

/* ---------------- 插件入口 ---------------- */

/** Cordis client entry。inject 声明 slots + sessions + workspaces + modelDirectories
 * + uiWorkspace（硬门控：未声明的服务一读即抛）。workspaces 提供「加载」弹窗的
 * 工作区列表，modelDirectories 提供模型列表，uiWorkspace.openSession 负责切到
 * 新建的会话（dsh 0.1.7-rc.2 起会话导航归 ui-workspace，ISessions 不再有 open）。 */
export function apply(ctx: Context): () => void {
  const slots = (ctx as unknown as { slots: LooseSlots }).slots
  // 「加载」需要：切新会话为当前 + 读当前会话 cwd（新会话 cwd）+ 工作区/模型列表。
  const sessions = (ctx as unknown as { sessions: LooseSessions }).sessions
  const workspaces = (ctx as unknown as { workspaces: LooseWorkspaces }).workspaces
  const modelDirectories = (ctx as unknown as { modelDirectories: LooseModelDirectories }).modelDirectories
  const uiWorkspace = (ctx as unknown as { uiWorkspace: LooseUiWorkspace }).uiWorkspace
  // 会话导航面：list 读快照（轮询新建会话是否已进入目录），openSession 切主视图。
  // 在 apply 作用域构造一次，保证 hook 依赖（useEffect deps）身份稳定。
  const nav: LoadSessions = {
    openSession: (id) => uiWorkspace.openSession(id),
    list: sessions.list,
  }
  const SeekerOverlayWithServices = () => (
    <SeekerOverlayEntry sessions={nav} workspaces={workspaces} modelDirectories={modelDirectories} />
  )
  // 「我认领的 issue」hero 栏：框架 session kit（useSession/sessionId）由槽位运行时
  // 注入，这里只补插件自己的会话面（点击加载后切会话）。
  const SeekerMineWithServices = (slotProps: unknown) => {
    const kit = slotProps as Omit<MineDockProps, 'sessions'>
    return <SeekerMineDock sessionId={kit.sessionId} useSession={kit.useSession} sessions={nav} />
  }
  const disposers: Array<() => void> = [
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'seeker', order: 20, label: 'Seeker' },
      SeekerEntry as unknown as (props: unknown) => ReactNode,
    )) as () => void,
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'seeker-workbench', order: 100, label: 'Seeker 工作台' },
      SeekerOverlayWithServices as unknown as (props: unknown) => ReactNode,
    )) as () => void,
    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'seeker-mine', order: 100, label: '我认领的 Seeker issue' },
      SeekerMineWithServices as unknown as (props: unknown) => ReactNode,
    )) as () => void,
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export const inject = ['slots', 'sessions', 'workspaces', 'modelDirectories', 'uiWorkspace']
