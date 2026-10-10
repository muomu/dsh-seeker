/**
 * dsh-seeker「加载到新会话」（loadIssueSession）host 半区冒烟测试。
 *
 * 用 mock ctx 验证 0.1.7-rc.2 适配后的建会话配方，不进入真实模型：
 * - agents.create 的 meta.cwd / meta.agentPreset / agentOptions；
 * - setup 内 installModelSelection（0.1.7-rc.2 新增 agent/pre-step 监听）+
 *   agentPresets.mount 都挂上；
 * - 注入消息的 source 形状 —— 0.1.7-rc.2 取消了 `kind: 'plugin'` 兜底，本插件
 *   以模块增强声明自有 kind `dsh-seeker`，notice 形态需带 ≤120 字符的 summary；
 * - skr skill 先 inject、issue 后 followup（顺序即首个请求的上下文顺序）；
 * - workspaceRegistry attach + sessionTitle rename（标题 pin）。
 * getIssueData 走真实 skr CLI（只读），与 smoke.mjs 的依赖一致。
 */
import { loadIssueSession } from '../lib/index.js'

const ISSUE = 'SEE-664'
const SESSION_ID = 'seeker-load-test-session'
const CWD = process.cwd()
const SELECTION = { provider: 'ark-agent-plan', model: 'ark-code-latest' }
const SUMMARY_MAX = 120

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`✗ ${name}${detail !== '' ? `：${detail}` : ''}`)
    failures += 1
  }
}

const calls = { create: [], inject: [], followup: [], events: [], bound: [], attached: [], renamed: [], disposed: 0 }

const agentCtx = {
  on: (event, _handler, opts) => { calls.events.push({ event, opts }); return () => {} },
}
const agent = {
  session: { id: SESSION_ID },
  inject: (message) => calls.inject.push(message),
  followup: (message) => calls.followup.push(message),
}
const services = {
  agentDefaultModel: { currentSelection: () => SELECTION },
  agentPresets: {
    resolve: async (id) => ({ id: id ?? 'default' }),
    mount: async (_ctx, id) => { calls.bound.push(id ?? 'default'); return {} },
  },
  sessionTitle: { rename: (session, title) => { calls.renamed.push({ session, title }); return {} } },
}
const ctx = {
  agents: {
    create: async (options) => {
      calls.create.push(options)
      if (options.setup !== undefined) await options.setup(agentCtx)
      return { agent, dispose: async () => { calls.disposed += 1 } }
    },
  },
  sessions: {},
  get: (name) => services[name],
  workspaceRegistry: {
    create: async (path) => {
      calls.attached.push(path)
      return { attachSession: async (id) => { calls.attached.push(id) } }
    },
  },
}

let result
try {
  result = await loadIssueSession(ctx, ISSUE)
} catch (error) {
  check('loadIssueSession 执行', false, error instanceof Error ? error.message : String(error))
}

/* 1. 返回值与建会话参数 */
check('返回新建会话 id', result?.sessionId === SESSION_ID, String(result?.sessionId))
const options = calls.create[0]
check('agents.create 调用一次', calls.create.length === 1, `实际 ${calls.create.length}`)
check('会话 id 为 seeker-load-<uuid>', typeof options?.sessionId === 'string' && options.sessionId.startsWith('seeker-load-'))
check('meta.cwd 为调用方 cwd', options?.meta?.cwd === CWD, String(options?.meta?.cwd))
check('meta.agentPreset 记录 preset id', options?.meta?.agentPreset === 'default', String(options?.meta?.agentPreset))
check(
  'agentOptions 用默认模型选择',
  options?.agentOptions?.provider === SELECTION.provider && options?.agentOptions?.model === SELECTION.model,
  JSON.stringify(options?.agentOptions),
)

/* 2. setup：模型选择 + preset mount */
const events = calls.events.map((e) => e.event)
check('setup 注册 installModelSelection 监听', ['system-prompt/assemble', 'agent/request'].every((e) => events.includes(e)), events.join(', '))
check('0.1.7-rc.2 的 agent/pre-step 监听已注册', events.includes('agent/pre-step'), events.join(', '))
check('agentPresets.mount 已调用', calls.bound[0] === 'default', JSON.stringify(calls.bound))

/* 3. 注入消息的 source 形状（本插件的核心适配点） */
check('先 inject(skr skill)、后 followup(issue)', calls.inject.length === 1 && calls.followup.length === 1, `inject=${calls.inject.length} followup=${calls.followup.length}`)
for (const [label, message] of [['skr skill', calls.inject[0]], ['issue', calls.followup[0]]]) {
  if (message === undefined) continue
  check(`${label} 消息为 user role`, message.role === 'user', String(message.role))
  check(`${label} source.kind 为 dsh-seeker`, message.source?.kind === 'dsh-seeker', String(message.source?.kind))
  check(`${label} source.form 为 notice`, message.source?.form === 'notice', String(message.source?.form))
  const summary = message.source?.summary
  check(`${label} notice summary 非空且 ≤${SUMMARY_MAX}`, typeof summary === 'string' && summary !== '' && summary.length <= SUMMARY_MAX, JSON.stringify(summary))
}
const issueText = calls.followup[0]?.content?.[0]?.text ?? ''
check('issue 文本包含编号与标题', issueText.includes(ISSUE) && issueText.includes('评论支持回复'), issueText.slice(0, 80))
check('followup summary 为「加载 issue <id>」', calls.followup[0]?.source?.summary === `加载 issue ${ISSUE}`, String(calls.followup[0]?.source?.summary))
const skillText = calls.inject[0]?.content?.[0]?.text ?? ''
check('skr skill 文本带全文标记', skillText.includes('【skr Skill】'), skillText.slice(0, 60))

/* 4. 工作区 attach + 标题 pin */
check('workspaceRegistry.create(meta.cwd)', calls.attached[0] === CWD, String(calls.attached[0]))
check('attachSession(sessionId)', calls.attached[1] === SESSION_ID, String(calls.attached[1]))
check(
  '会话标题 rename 为「<id>｜<标题>」',
  typeof calls.renamed[0]?.title === 'string' && calls.renamed[0].title.startsWith(`${ISSUE}｜`),
  String(calls.renamed[0]?.title),
)

/* 5. 成功路径不 dispose */
check('成功路径不 dispose 会话', calls.disposed === 0, String(calls.disposed))

console.log(failures === 0 ? '\nload 冒烟全部通过 ✅' : `\nload 冒烟 ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
