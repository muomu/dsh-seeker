/**
 * dsh-seeker client 半区冒烟测试（对 dsh 0.1.7-rc.2 的浏览器模块表契约）。
 *
 * 覆盖「typecheck 抓不到、但 0.1.7-rc.2 运行时会炸」的三类问题：
 * 1. 模块表协议：lib/client.js 必须走 `window.__ModuleLoader__.load({id, factory})`
 *    注册，且 factory 只能 require 模块表基线（react 家族 + ui-primitives）；
 * 2. 具名导入存在性：client 源码从 ui-primitives 取的值导入必须在已发布的
 *    0.1.7-rc.2 产物里真实导出（该版把 IconChecklistOutline14 更名为
 *    IconChecklistOutlineMedium；缺失时 React 抛「Element type is invalid」
 *    整块崩掉，而 tsc 因 MemoExoticComponent 包装漏报）；
 * 3. 槽位装配：apply() 在 slots 上注册三个条目、声明 uiWorkspace 注入，并以
 *    react-dom/server 实渲染各条目（图标/kit 契约在渲染期才暴露）。
 *
 * 注意：ui-primitives 的 npm 产物是浏览器件（import clsx 与 *.module.css），
 * Node 无法 import，故 require 表里注入桩件；其「导出名」改由产物 export 表校验。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import * as realReact from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

let failures = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`✗ ${name}${detail !== '' ? `：${detail}` : ''}`)
    failures += 1
  }
}

const root = fileURLToPath(new URL('..', import.meta.url))

/* ---------- 1. 具名导入 vs 已发布产物的导出表 ---------- */

const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const require_ = createRequire(import.meta.url)
let primitivesEntry
try {
  primitivesEntry = require_.resolve(PRIMITIVES)
} catch (error) {
  check(`解析 ${PRIMITIVES}`, false, error instanceof Error ? error.message : String(error))
}
const entrySource = primitivesEntry !== undefined ? readFileSync(primitivesEntry, 'utf8') : ''
const exportBlocks = [...entrySource.matchAll(/export\s*\{([^}]*)\}/g)]
const exportBlock = exportBlocks[exportBlocks.length - 1]
const exported = new Set(
  (exportBlock?.[1] ?? '')
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/).pop() ?? '')
    .filter((name) => name !== ''),
)
check(`${PRIMITIVES} 产物导出表可解析`, exported.size > 50, `解析到 ${exported.size} 个导出`)

const imported = new Map()
for (const file of ['src/client/index.tsx', 'src/client/workbench.tsx']) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  for (const match of source.matchAll(/import\s+(type\s*)?\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/g)) {
    const statementTypeOnly = (match[1] ?? '').trim() === 'type'
    for (const raw of (match[2] ?? '').split(',')) {
      const spec = raw.trim()
      if (spec === '') continue
      const typeOnly = statementTypeOnly || /^type\s/.test(spec)
      const name = spec.replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
      if (name !== undefined && name !== '') imported.set(name, typeOnly)
    }
  }
}
check('client 源码声明了 ui-primitives 导入', imported.size > 0, [...imported.keys()].join(', '))
for (const [name, typeOnly] of imported) {
  // 类型导入只存在于 .d.ts，不是产物值导出。
  if (typeOnly) continue
  check(`产物导出 ${name}`, exported.has(name))
}

/* ---------- 2. 通过模块表协议加载 bundle ---------- */

let registration
const fakeWindow = { __ModuleLoader__: { load: (r) => { registration = r } } }
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', source)(fakeWindow) // eslint-disable-line no-new-func

check('bundle 通过 __ModuleLoader__.load 注册', registration !== undefined)
check('注册 id 为 dsh-seeker', registration?.id === 'dsh-seeker', String(registration?.id))
check('注册带 factory', typeof registration?.factory === 'function')

/* ---------- 3. 材化：只允许模块表基线 specifier ---------- */

const BASELINE = new Set(['react', 'react/jsx-runtime', 'react-dom/client', PRIMITIVES])
const requested = []
/** 桩 ui-primitives：保留被插件使用的成员，形状与真实产物一致。 */
const primitivesStub = {
  Button: ({ children, ...rest }) => realReact.createElement('button', rest, children),
  MarkdownText: ({ text }) => realReact.createElement('div', null, text),
  writeClipboard: async () => true,
  IconChecklistOutlineMedium: () => realReact.createElement('svg', { 'data-icon': 'checklist' }),
}
const requireShim = (spec) => {
  requested.push(spec)
  if (!BASELINE.has(spec)) throw new Error(`非基线 require：${spec}`)
  if (spec === 'react') {
    // SSR 下 useSyncExternalStore 需要 getServerSnapshot；测试里直接取快照。
    return { ...realReact, useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() }
  }
  if (spec === 'react/jsx-runtime') return jsxRuntime
  return primitivesStub
}
let mod
try {
  mod = registration.factory(requireShim)
} catch (error) {
  check('factory 材化', false, error instanceof Error ? error.message : String(error))
}
check('factory 材化不抛错', mod !== undefined)
check('仅请求模块表基线', requested.length > 0 && requested.every((s) => BASELINE.has(s)), requested.join(', '))

/* ---------- 4. apply() 槽位装配 ---------- */

const registered = []
const sessionsSnapshot = { ids: [], byId: {} }
const opened = []
const ctx = {
  slots: {
    inject: (_key, cb) => cb(),
    register: (opts, component) => { registered.push({ opts, component }); return () => {} },
  },
  sessions: { list: { getSnapshot: () => sessionsSnapshot } },
  workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  modelDirectories: { directoryFor: () => ({ load: async () => {}, store: { getSnapshot: () => ({ groups: [], status: 'idle' }) } }) },
  uiWorkspace: { openSession: (id) => { opened.push(id) } },
}
let dispose
try {
  dispose = mod.apply(ctx)
} catch (error) {
  check('apply() 执行', false, error instanceof Error ? error.message : String(error))
}
check('apply() 返回卸载函数', typeof dispose === 'function')
check('声明 uiWorkspace 注入（0.1.7-rc.2 会话导航服务）', (mod.inject ?? []).includes('uiWorkspace'), JSON.stringify(mod.inject))
check('注册三个槽位条目', registered.length === 3, `实际 ${registered.length}`)
check(
  '槽位键为 sidebar.footer.action / shell.overlay / conversation.input.dock',
  ['sidebar.footer.action', 'shell.overlay', 'conversation.input.dock'].every((k) => registered.some((r) => r.opts.name === k)),
  registered.map((r) => r.opts.name).join(', '),
)

/* ---------- 5. 渲染各条目 ---------- */

const sidebarEntry = registered.find((r) => r.opts.name === 'sidebar.footer.action')
try {
  const html = renderToStaticMarkup(realReact.createElement(sidebarEntry.component, { wide: true }))
  check('侧边栏入口（wide）可渲染', html.includes('Seeker'))
  check('侧边栏入口（rail）可渲染', renderToStaticMarkup(realReact.createElement(sidebarEntry.component, { wide: false })).length > 0)
} catch (error) {
  check('侧边栏入口可渲染', false, error instanceof Error ? error.message : String(error))
}

const mineDock = registered.find((r) => r.opts.name === 'conversation.input.dock')
const kit = (blank) => ({ sessionId: 'session-test', useSession: (sel) => sel({ blank }) })
try {
  check('hero 栏非 hero 会话渲染 null', renderToStaticMarkup(realReact.createElement(mineDock.component, kit(false))) === '')
  check('hero 栏 hero 会话可渲染（无数据时 null）', renderToStaticMarkup(realReact.createElement(mineDock.component, kit(true))) === '')
} catch (error) {
  check('hero 栏可渲染', false, error instanceof Error ? error.message : String(error))
}

const overlay = registered.find((r) => r.opts.name === 'shell.overlay')
try {
  check('覆盖层关闭态渲染 null', renderToStaticMarkup(realReact.createElement(overlay.component, {})) === '')
} catch (error) {
  check('覆盖层关闭态可渲染', false, error instanceof Error ? error.message : String(error))
}

/* ---------- 6. 会话导航面改走 uiWorkspace ---------- */

// 0.1.7-rc.2 移除了 ISessions.open；导航必须走 ui-workspace 的 openSession。
check('bundle 不再调用已移除的 sessions.open', !/sessions\s*\.\s*open\s*\(/.test(source))
check('bundle 经 openSession 切换会话', /openSession/.test(source))

try {
  dispose()
  check('卸载函数可调用', true)
} catch (error) {
  check('卸载函数可调用', false, error instanceof Error ? error.message : String(error))
}

console.log(failures === 0 ? '\nclient 冒烟全部通过 ✅' : `\nclient 冒烟 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
