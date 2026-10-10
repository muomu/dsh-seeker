/**
 * dsh-seeker host 数据层端到端冒烟测试（对真实 skr CLI / Seeker API）。
 * v3 重构：模型工具层已删除，直连路由 /seeker/api/* 是唯一数据通道。
 * 安全约束：
 * - create 只用不存在的 workspace 触发「参数组装 → CLI 调用 → 前置失败」
 *   路径，绝不创建真实 issue；
 * - 测试后检查临时正文文件已清理。
 */
import { handleSeekerApi } from '../lib/index.js'
import { tmpdir } from 'node:os'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

let failures = 0

/** 直连路由冒烟：模拟 GET/POST /seeker/api/*。 */
async function runApi(method, path, params, bodyText = '', expectError = false) {
  const url = new URL(`http://x${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  }
  const r = await handleSeekerApi(method, url.pathname, url.searchParams, bodyText)
  if (r.ok && expectError) {
    console.log(`✗ api ${method} ${path}：期望失败但成功`)
    failures += 1
  } else if (!r.ok && !expectError) {
    console.log(`✗ api ${method} ${path}：${r.error}`)
    failures += 1
  } else {
    const head = JSON.stringify(r).slice(0, 180)
    console.log(`${r.ok ? '✓' : '✓(期望失败)'} api ${method} ${path}`)
    console.log(`   → ${head}`)
  }
}

// 1. 上下文：无 workspace（workspace 列表）+ 指定 workspace（项目/标签/saved views）
await runApi('GET', '/seeker/api/context', {})
await runApi('GET', '/seeker/api/context', { workspace: 'see' })

// 2. saved views 列表（选择器数据源）
await runApi('GET', '/seeker/api/views', { workspace: 'see' })

// 3. 列表：默认未完成 / 搜索 / 过滤 / 全量限量 / 分页
await runApi('GET', '/seeker/api/list', { workspace: 'see' })
await runApi('GET', '/seeker/api/list', { workspace: 'see', query: '评论' })
await runApi('GET', '/seeker/api/list', { workspace: 'see', type: 'story', status: 'in_progress' })
await runApi('GET', '/seeker/api/list', { workspace: 'see', all: true, limit: 3 })
// 分页：limit=3 第 1/2 页应返回不同条目
await runApi('GET', '/seeker/api/list', { workspace: 'see', limit: 3, page: 1 })
await runApi('GET', '/seeker/api/list', { workspace: 'see', limit: 3, page: 2 })
// saved view：取第一个可用 view 复用其筛选+排序；allPages=true 走全量翻页聚合
{
  const u = new URL('http://x/seeker/api/views')
  u.searchParams.set('workspace', 'see')
  const views = await handleSeekerApi('GET', u.pathname, u.searchParams, '')
  if (views.ok) {
    const items = views.data.items ?? []
    if (items.length > 0) {
      await runApi('GET', '/seeker/api/list', { workspace: 'see', view: items[0].id })
      await runApi('GET', '/seeker/api/list', { workspace: 'see', view: items[0].id, allPages: true })
    } else {
      console.log('✓(跳过) saved view 列表为空，无 view 可测')
    }
  } else {
    console.log(`✗ 取 saved views 失败：${views.error}`)
    failures += 1
  }
}

// 4. 详情：正文 + 评论
await runApi('GET', '/seeker/api/issue', { id: 'SEE-664' })
await runApi('GET', '/seeker/api/issue', {}, '', true)

// 4.5 我认领的 issue（hero 栏数据源：whoami → --assignee 列表 → 优先级排序取前 10）
await runApi('GET', '/seeker/api/mine', {})

// 4.6 收件箱（个人维度 Inbox）：whoami → issue list --assignee，默认
// backlog/todo/in_progress + 精确总数；all=true 追加我名下的 in_review/done
await runApi('GET', '/seeker/api/inbox', { workspace: 'see' })
await runApi('GET', '/seeker/api/inbox', { workspace: 'see', all: true })

// 5. 创建：负路径（不存在的 workspace → skr 前置失败，验证参数/临时文件逻辑）
await runApi('POST', '/seeker/api/create', {}, JSON.stringify({
  title: '【联调测试】请忽略',
  body: '# 测试\n\n## 角色\n作为 联调\n',
  workspace: 'no-such-workspace-xyz',
  priority: 'P3',
  labels: ['联调'],
}), true)

// 6. 未支持路由
await runApi('GET', '/seeker/api/unknown', {}, '', true)

// 7. 临时文件清理检查
const leftovers = (await readdir(tmpdir())).filter((f) => f.startsWith('seeker-story-'))
console.log(leftovers.length === 0 ? '✓ 临时正文文件已清理' : `✗ 残留临时文件：${leftovers.join(', ')}`)
if (leftovers.length > 0) failures += 1

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
