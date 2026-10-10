/**
 * skr (Seeker CLI) 执行器：以 `skr --json <args>` 方式调用本地 CLI 并解析
 * 机器可读输出。插件工具的全部参数校验、错误处理与输出解析都收敛在这里。
 *
 * 注意：host 半区刻意不依赖任何 @deepseek-ai/* 运行时模块（profile 只解析
 * 插件包自身），skr 通过 child_process 直接调用本机二进制。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, dirname } from 'node:path'

const execFileP = promisify(execFile)

/** skr CLI 的 JSON 响应外形（`skr --json` 全局契约）。 */
export interface SkrEnvelope {
  ok?: boolean
  data?: unknown
  error?: { code?: unknown; name?: string; message?: string }
}

/** runSkr 的可选执行参数（目前仅 cwd）。 */
export interface RunSkrOptions {
  /** 在指定工作目录下执行 skr（默认沿用当前进程 cwd）。用于按会话目录绑定 workspace。 */
  cwd?: string
}

/** 运行 `skr --json <args>` 并返回解析后的 `data`（ok !== true 时抛错）。 */
export async function runSkr(args: string[], opts?: RunSkrOptions): Promise<unknown> {
  try {
    const { stdout } = await execFileP('skr', ['--json', ...args], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    })
    let parsed: SkrEnvelope
    try {
      parsed = JSON.parse(stdout) as SkrEnvelope
    } catch {
      throw new Error(`skr 输出不是合法 JSON（${stdout.slice(0, 200)}）`)
    }
    if (parsed.ok !== true) {
      throw new Error(`skr ${args[0] ?? ''} 失败：${parsed.error?.message ?? '未知错误'}`)
    }
    return parsed.data
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('未找到 skr 命令：请先安装 Seeker CLI（skr）并确保其在 PATH 中')
    }
    // skr 失败时退出码非零，但 JSON envelope 输出在 stdout：优先解析它，
    // 提取真实业务错误（stderr 通常为空）。
    const execErr = error as { stdout?: string; stderr?: string; message?: string }
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim() !== '') {
      try {
        const parsed = JSON.parse(execErr.stdout) as SkrEnvelope
        if (parsed.ok === false && typeof parsed.error?.message === 'string') {
          throw new Error(`skr ${args[0] ?? ''} 失败：${parsed.error.message}`)
        }
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith('skr ')) throw inner
        // stdout 不是合法 envelope → 落到下面的一般错误处理。
      }
    }
    if (typeof execErr.stderr === 'string' && execErr.stderr.trim() !== '') {
      const tail = execErr.stderr.trim().split('\n').slice(-3).join(' ')
      throw new Error(`${error instanceof Error ? error.message : String(error)} — ${tail.slice(0, 300)}`)
    }
    throw error
  }
}

/* ---------------- skr 内置 skill 读取（加载会话注入用） ----------------
 * skr CLI 把 skill 打包在包内（<pkg>/dist/skills/<name>/SKILL.md），
 * `skr skill install` 只支持 claude/codex/workbuddy，装不进 dsh 的 skill
 * 发现目录——所以「加载」会话的 skill catalog 里没有 skr。这里直接按
 * PATH 解析 skr 二进制 → realpath 到包内 dist/index.cjs → 同级
 * skills/<name>/SKILL.md 读全文，进程内缓存（CLI 升级需重启 host 才
 * 拿到新版 skill，与 host 半区改动需重启的既有语义一致）。
 * 任何一步失败都返回 undefined：skill 注入是增强项，不应让加载失败。 */

const skillCache = new Map<string, string | undefined>()

/** 读取 skr CLI 内置 skill 的全文（SKILL.md body）；找不到/读失败返回 undefined。 */
export async function readBundledSkill(name: string): Promise<string | undefined> {
  if (skillCache.has(name)) return skillCache.get(name)
  let body: string | undefined
  try {
    // 在 PATH 里找 skr 可执行文件。
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir === '') continue
      const bin = join(dir, 'skr')
      try {
        await access(bin, constants.X_OK)
        // realpath 解析 bin 软链（如 ~/.local/bin/skr → @seeker/cli/dist/index.cjs），
        // skill 就在 realpath 同级的 skills/<name>/SKILL.md。
        const target = await realpath(bin)
        body = await readFile(join(dirname(target), 'skills', name, 'SKILL.md'), 'utf8')
        break
      } catch {
        // 该 PATH 项没有 skr 或 skill 读取失败 → 继续下一项。
      }
    }
  } catch {
    body = undefined
  }
  skillCache.set(name, body)
  return body
}
