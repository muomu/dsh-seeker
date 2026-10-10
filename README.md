# dsh-seeker — Seeker 工作台

基于 **skr CLI**（Seeker CLI）的 DeepSeek Harness 插件：侧边栏「Seeker」入口 → **框架级模态覆盖层**（`shell.overlay`，面板全局居中、3:2 宽高比）→ **确定性 client UI** 的 issue 列表（搜索 / 筛选 / saved view / 无限滚动 / 刷新）↔ 详情（元数据 / markdown 正文 / 评论 / 标签 / 外链）。浏览数据经同源相对 fetch 直连 host 的 `/seeker/api/*` 路由；**「加载」操作**（列表行 / 看板卡片 / 详情页）会创建**新会话**并把完整 issue 作为用户消息入队、**创建后立即开始执行**，切到该会话继续讨论。

## 功能（v3 架构）

- **侧边栏入口**：侧边栏底部「Seeker」按钮（`sidebar.footer.action` 槽），**对齐原生 sidebar.settings trigger 默认行为**——原生图标 `IconChecklistOutlineMedium`（宽 16px / rail 18px）、宽模式 42px 高圆角 12px、折叠 rail 36×36 圆形、hover/打开只切 `--dsw-alias-interactive-bg-hover`。
- **模态覆盖层**：`shell.overlay`（root 作用域框架级覆盖层）渲染工作台——面板**全局居中**、尺寸为 **3:2**（宽:高 = 3:2，top/bottom 边距收窄至 16px、左右 48px，按视口自适应）；整页淡遮罩 backdrop（`--dsw-alias-bg-mask-2`），**点击面板外部 / 关闭按钮 / ESC** 退出。
- **Issue 列表**：类型徽标 + 编号 + 标题 + 状态/优先级/标签/指派人/更新时间；**搜索**（标题/id 子串，**搜索框在标题栏居中**，搜索模式不分页、截断提示）、**筛选**（状态/类型/项目/标签多选）、**saved view 收藏夹式 Tab**（复用其筛选+排序，选中即锁定手动筛选/搜索，**全量拉取并按状态分组**——固定顺序组头 + 每组计数 + 点击折叠 + 会话缓存，未知/缺失状态并入「其他」组；saved view 下还提供 **分组列表 / 看板显示切换**，选择按 workspace+view 记忆）、**无限滚动**分页（列表模式）、**自动 + 手动刷新**（刷新按钮在标题栏右侧，同时失效 saved view 会话缓存）。
- **收件箱视图**：视图 Tab 首位「📥 收件箱」——**当前登录用户（whoami）名下**、当前 workspace 的 **backlog/todo/in_progress 待办 + 精确总数**（whoami → `skr issue list --assignee <me>`，host **全量翻页取回**，`total` 即 `items.length`，无截断）；「进行中 / 含待核对·已完成」segmented 开关追加我名下的 in_review/done（仍排除 closed/canceled）；与 saved view 同款 **分组列表 / 看板显示切换**（按状态分组 + 折叠、只读看板，选择按 workspace 记忆）；无筛选/搜索/分页，行内复用「加载到新会话」与详情跳转；选中与 saved view 同样持久记忆（localStorage）。
- **Issue 详情**（视图内栈，返回按钮回列表）：元数据（项目/负责人/报告人/时间）、markdown 正文、标签、评论列表、「在 Seeker Web 打开」外链（应用根地址）+ 复制编号。
- **Workspace 切换**：顶部切换器（see/TPG/VAN），**localStorage 持久记忆**；浏览位置（列表/详情）**内存态恢复**（刷新丢失）。
- **数据通道**：`/seeker/api/*` 同源直连路由（context / views / list / mine / issue / create / load），浏览数据零模型零会话，无认证。
- **新会话页「我认领的 issue」栏**：hero（空白新会话页，输入卡上方一整行，`conversation.input.dock` 槽）展示一排 issue chip（priority 标记 + 编号 + 标题）——数据源 `GET /seeker/api/mine`（`skr whoami` 拿 displayName → `skr issue list --assignee` 限定当前绑定 workspace → host 按优先级 P0→P3、同级 updatedAt 倒序取前 10；whoami 60s TTL 缓存，whoami 失败或列表为空则前端隐藏该栏）；点击 chip 直接走与覆盖层「加载」相同的代码路径（`POST /seeker/api/load` → 轮询 `ctx.sessions.list` → `ctx.uiWorkspace.openSession` 切到新会话，工作区沿用当前绑定 workspace、目录沿用当前会话 cwd、模型走默认，无选择弹窗）。非 hero 会话返回 null，自然不显示。
- **「加载」到新会话**：列表行 / 看板卡片 / 详情页的「加载」按钮 → **弹窗选择会话工作区与模型**（默认选中上次选择，localStorage 持久化记忆）→ 确认后 `POST /seeker/api/load`（宿主**按标准 agent preset 组合建新会话**——对齐 apiproxy `composeAgent`：create 前 `agentPresets.resolve` 并把 id 写进 `meta.agentPreset`，setup 内 `agentPresets.mount`，工具/AGENTS.md 指令/skill catalog/persona 与 GUI 新建会话一致——并把会话标题显式 rename 为「<id>｜<标题>」（pin 住，不再自动生成；rename 失败吞掉走自动生成兜底）——先 `agent.inject`（非唤醒）注入 **skr CLI 内置 skill 全文**（按 PATH realpath 定位包内 `dist/skills/skr/SKILL.md`，进程内缓存；inbox 批次语义保证排在 issue 之前进入首个请求），再把完整 issue 作为用户消息 `agent.followup` 入队并**唤醒驱动——会话创建后立即开始执行**（注入消息带**仅读取指令**：供阅读与讨论，模型不自行开工——不改代码、不变更 issue，等用户指示），preset 层上下文在第一个请求前随首 step 批次注入，不再只是注入后等用户手动继续）→ 返回 sessionId → client 轮询 `ctx.sessions.list` 后 `ctx.uiWorkspace.openSession(sessionId)` 切到新会话并关闭覆盖层。每次点击都新建会话；加载中态 + 成功切换 + 失败 toast 提示（不切走）。
  - **选择弹窗**：工作区下拉来自 `ctx.workspaces`（DSH workspace 目录列表，决定新会话 cwd 与 GUI 分组）；模型下拉来自 `ctx.modelDirectories`（per-session 模型目录，GUI 模型选择器同款数据源；含「默认模型」选项，缺省走 host 默认模型选择）。弹窗默认选中 localStorage 记忆的上次选择（`dsh-seeker.load-defaults`），确认后回写记忆。
  - **绑定项目工作区**：加载时 client 把当前选中的 Seeker workspace（issue 所属项目的工作区，see/TPG/VAN）、弹窗选中的工作区目录与模型一并传给 `/load`；host 先 `skr ws bind <workspace>` 把新会话的工作目录绑定到该项目工作区（写 `.seeker/workspace.json`），再以弹窗选中的工作区目录为 `meta.cwd` 建会话——新会话落在所选工作区、skr 操作默认使用正确 workspace，而不是跨会话粘住的全局活跃 workspace。**建会话后 host 还把新会话 attach 到所选工作区**（`workspaceRegistry.create(cwd)` 幂等复用/新建记录 + `attachSession(sessionId)`），因此新会话在 GUI 左侧出现在工作区分组下，不再「未分组」。绑定失败直接报错不建会话；attach 失败则清理会话再报错（不留孤儿会话）。
- **错误处理**：错误卡 + 重试（skr 缺失 / 网络失败 / 空态）。
- 无自定义面板、无斜杠命令；未触发时不影响普通对话。

## 安装与激活

```bash
# 1. 安装（link 模式用于开发迭代）
dsh plugin --profile web add link:/path/to/dsh-seeker

# 2. 重启 dsh web（host 半区改动必须重启才生效）
dsh web
```

前置条件：本机已安装 `skr`（Seeker CLI）且在 PATH 中，且已 `skr login`。

## 兼容版本（dsh 0.1.7-rc.2）

peerDependencies 钉在 **`@deepseek-ai/dsh-*@0.1.7-rc.2` + `@deepseek-ai/cordis@~4.0.4`**（与 dsh 0.1.7-rc.2 内核自带版本一致）。相对 0.1.0-rc.x 的适配点：

| 位置 | 0.1.0-rc.x | 0.1.7-rc.2 |
| --- | --- | --- |
| 宿主注入消息 source | `{ kind: 'plugin', plugin: 'dsh-seeker', form: 'notice', summary }` | 模块增强声明自有 `kind`：`{ kind: 'dsh-seeker', form: 'notice', summary: boundContextSummary(…) }`（`MessageSourceMap` 不再有共享 `plugin` 兜底） |
| 侧边栏图标 | `IconChecklistOutline14` | `IconChecklistOutlineMedium`（primitives 更名，缺失时 React 整块抛「Element type is invalid」） |
| 会话切换 | `ctx.sessions.open(id)` | `ctx.uiWorkspace.openSession(id)`（导航归 ui-workspace；`ISessions` 只保留目录/引用面，并在 `inject` 中声明 `uiWorkspace`） |
| 当前会话 | `SessionListState.current` | 遍历 `byId`，取 `retainedBy.mainView > 0` 的那一行（与 ui-session/ui-workspace 的 `containsCurrent` 同源） |
| hero 判定 | `useSession(s => s.composerPhase === 'blank')` | `useSession(s => s.blank === true)`（`useSession` 现在选的是 `SessionSnapshot`） |
| 正文渲染 | `<MarkdownText text={…} />` | `<MarkdownText text={…} labels={MARKDOWN_LABELS} />`（`labels` 变必填，运行时直接读 `labels.code.*`，缺省会崩；插件自带中文文案） |
| 类型解析 | `tsconfig.paths` 写死 npx 缓存绝对路径 | 删除 `paths`，改为按本地 `node_modules` 解析（依赖已钉在 0.1.7-rc.2） |
| 客户端包 | `@deepseek-ai/dsh-client-runtime` / `dsh-api-remotes` | 两包在 0.1.7-rc.2 已不存在：宿主面拆到 `dsh-api-session-controller` / `dsh-api-workspace-controller` / `dsh-client-ui-renderer` 等；本插件只用宽松结构面，故直接移除依赖 |

## 开发

```bash
pnpm install
pnpm build          # rm -rf lib && tsc -p tsconfig.json && tsdown
pnpm test           # 宿主直连路由 + 「加载」建会话 + client bundle 三段冒烟
```

- `pnpm test` 三段（均对真实 skr CLI 只读，不开模型会话）：
  - `test/smoke.mjs`：`/seeker/api/*` 直连路由（context/views/list/mine/inbox/issue/create 负路径）；
  - `test/load-smoke.mjs`：mock ctx 跑 `loadIssueSession`——建会话参数、`agent/pre-step` 监听、`dsh-seeker` source 形状、skill→issue 注入顺序、attach + 标题 pin；
  - `test/client-smoke.mjs`：不经浏览器验证 `lib/client.js` 的模块表契约（`__ModuleLoader__.load` 注册、只 require 模块表基线、ui-primitives 具名导入在产物中真实导出、三槽位装配、`uiWorkspace` 注入、React 实渲染侧边栏入口）——专治 tsc 抓不到的运行时改名/契约漂移。

- **client 半区改动**：`pnpm build` 后 HMR 热替换（`dsh-client-hmr` 轮询 `lib/client.js`），无需刷新页面。
- **host 半区改动**（`src/index.ts` / `src/api.ts` / `src/data.ts` / `src/skr.ts`）：需重启 `dsh web`。

### 结构

```
src/
  index.ts            host：注册 /seeker/api 直连路由（webServer 可选服务，探针 + 订阅）
  skr.ts              host：`skr --json` 执行器（child_process，无沙箱阻碍）+
                      readBundledSkill（按 PATH realpath 读 CLI 内置 skill 全文，加载时注入）
  data.ts             host：数据函数（fetchContextData / listViewsData / listIssuesData /
                      listMineData / getIssueData / createStoryData / formatIssueContext）
                      ——/seeker/api 的唯一数据源
  api.ts              host：/seeker/api/* 直连路由（context / views / list / mine / issue / create / load；
                      load 用 agents.create + agentPresets.mount 建标准组合会话，followup 注入 issue 并唤醒执行）
  client/
    index.tsx         client：侧边栏「Seeker」入口 + shell.overlay 覆盖层条目 +
                      conversation.input.dock「我认领的 issue」hero 栏注册
    store.ts          client：模块级内存 store（打开状态 / workspace(localStorage) / 浏览位置 / saved view 会话缓存）
    api.ts            client：同源相对 fetch /seeker/api/* 封装
    workbench.tsx     client：覆盖层 UI（列表 ↔ 详情，确定性组件 + token 配色）
    mine.tsx          client：hero 栏 UI（我认领的 issue chip 排，仅 hero 渲染，点击加载新会话）
test/
  smoke.mjs           host：对真实 skr CLI 的 /seeker/api/* 直连路由冒烟
  load-smoke.mjs      host：「加载」建会话（mock ctx）——source 形状 / 注入顺序 / attach / 标题
  client-smoke.mjs    client：模块表协议 / 具名导入导出 / 槽位装配 / React 实渲染冒烟
```

## 覆盖层流程

```
侧边栏 Seeker ──点击──▶ store.setOpen(true)
  └─ shell.overlay 条目渲染 WorkbenchSurface（全屏 backdrop + 全局居中的 3:2 面板）
       ├─ 拉取 /seeker/api/context（workspace 列表 + 项目/标签/saved views）
       ├─ 列表视图：/seeker/api/list（搜索/筛选/saved view/无限滚动/刷新）
       │    └─ saved view 模式：allPages=true → host 全量翻页聚合 → 分组列表 / 看板渲染
       │    └─ 点行 / 点卡片 → store.openDetail(id) → 详情视图
       │         ├─ /seeker/api/issue?id=（元数据 + markdown 正文 + 评论）
       │         └─ 返回按钮 → store.backToList()
       └─ 关闭按钮 / ESC / 点击面板外部（全屏模态 backdrop）→ store.setOpen(false)（浏览位置内存保留）
```

## 数据通道（/seeker/api 直连）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/seeker/api/context?workspace=` | GET | workspace 列表 + 项目 / 标签 / saved views |
| `/seeker/api/views?workspace=` | GET | saved views 列表（选择器数据源） |
| `/seeker/api/inbox?workspace=&all=` | GET | 收件箱（个人维度）：whoami → `issue list --assignee <me>`，默认 backlog/todo/in_progress，全量取回 + 精确 `total`；`all=true` 追加我名下的 in_review/done |
| `/seeker/api/mine` | GET | 我认领的 issue（whoami → --assignee，当前绑定 workspace，优先级排序取前 10，hero 栏数据源） |
| `/seeker/api/list?…` | GET | 列表 / 搜索 / 筛选 / saved view / 分页；`allPages=true` 走全量翻页聚合（saved view 分组用） |
| `/seeker/api/issue?id=` | GET | 单条详情（bodyText + comments） |
| `/seeker/api/create` | POST | 创建 story（保留端点，当前 UI 未用） |
| `/seeker/api/load` | POST | `{id, workspace?, cwd?, model?}` → 宿主先 `skr ws bind <workspace>` 把会话工作目录绑定到项目所属的 Seeker workspace（写 `.seeker/workspace.json`），再以 `cwd` 为 `meta.cwd`、`model` 为模型、按标准 agent preset 组合建新会话（`meta.agentPreset` 记录 preset id，冷恢复沿用同一组合），把完整 issue 注入为首条用户消息，最后 attach 到工作区分组，返回 `{sessionId}` |

## 说明与边界

- **浏览零模型**：工作台的列表 / 详情 / 筛选 / 刷新不发 prompt、不调模型、不开会话，全部走直连路由；唯一例外是「加载」——它按需 `agents.create` 建一个**标准 agent preset 组合**的普通会话（工具/AGENTS.md 指令/skill catalog 齐备，与 GUI 新建会话一致）并把 issue 作为用户消息 `agent.followup` 入队（**唤醒驱动，会话创建后立即开始执行**，preset 层上下文在第一个请求前随首 step 批次注入），随后 client `ctx.uiWorkspace.openSession` 切到该会话。
- **saved view 互斥**：skr `--view` 不能与其他筛选组合，选中 saved view（收藏夹式 Tab）时**隐藏搜索栏与手动筛选**（标签、状态/类型/项目），只保留 Tab；**刷新按钮在标题栏右侧**（与关闭同排，列表视图可用）。
- **收件箱**：**个人维度**——whoami 拿 displayName → `skr issue list --assignee <me>`（不是 CLI 的 `skr todo`：那是整 workspace 的待办池，会包含未分配/他人的 issue，故不采用）。状态范围对齐 todo 语义：默认 backlog/todo/in_progress、`--all` 追加 in_review/done（仍排除 closed/canceled）。`skr issue list` 无 total 字段，host **全量翻页取回**（默认范围个人待办量小、通常 1 页；`--all` 含 done 可能上百条），`total` 即 `items.length`——计数精确、无截断。收件箱不是 saved view，用 `INBOX_VIEW = '__inbox__'` sentinel 走同一视图 Tab 状态位（localStorage 持久、打开面板恢复），刷新走标题栏刷新按钮。**布局与 saved view 同款**：分组列表（按状态分组 + 折叠，组内保留后端顺序）/ 只读看板（非终态列，终态不进板）切换，选择按 workspace+view 记忆（key 为 `workspace:__inbox__`）；`--all` 的 done 在列表模式可见、看板模式按终态规则隐藏。
- **saved view 分组**：skr 每页上限 100，`allPages=true` 时 host 分批并发翻页直到短页（按页序合并）；分组固定 `STATUSES` 顺序、组内保留 view 排序，未知/缺失状态并入垫底「其他」组；结果按 workspace+view **会话缓存**，手动刷新失效。全量代价：see 工作区（约 670 条）≈ 7 页、首屏数批并发 CLI 调用，缓存后重复打开零请求。
- **saved view 看板**：工具栏「分组列表 / 看板」segmented 切换，选择按 workspace+view 记忆到 localStorage（首次默认分组列表）；看板为**只读**（零写端点、零 skr 流转）——列 = 非终态状态（backlog/todo/in_progress/in_review），空列隐藏、非空列均分铺满一屏、列内独立纵向滚动（列头常驻）、列内保留 view 排序；卡片 = 标题 + 类型徽标 + 编号 + P 徽标 + 负责人，点击进详情。**终态（done/closed/canceled）与未知/缺失状态不进看板**（切换模式零请求，与分组列表同源同一份全量数据）。
- **搜索不分页**：skr `issue search` 无分页，搜索模式截断为前 20 条并提示。
- **排序**：skr `issue list` 无排序参数，排序由 saved view（`--view`）承担；`/mine`（hero 栏）例外——host 侧按优先级（P0→P3）+ updatedAt 倒序排序取前 10。
- **外链**：`skr issue get` 无 web URL 字段，外链用应用根地址 + 复制编号（深链路由未探测）。
- **workspace**：`skr ws list` 的 active 可能为 null，默认取第一个并记忆选择。
- 面板尺寸为 3:2（宽:高 = 3:2），top/bottom 边距 16px、左右 48px，取视口内可容纳的最大值并全局居中，随窗口 resize 自适应（`resize` 监听 + rAF 节流）。
- 视觉：`--dsw-*` / `--dsh-*` token 自绘，跟随当前主题（含 aqua 玻璃拟态）；面板表面玻璃拟态并**加强磨砂**（玻璃填充向 `--dsw-alias-bg-base` 靠拢 25% + 加大模糊）——**安装并启用 [`dsh-client-ui-aqua`](https://github.com/WYH66666666/DSH) 时深度适配**其玻璃卡片配方（`--dsh-aqua-glass-card-*` + `blur(var(--dsh-aqua-blur, 20px))`，实时跟随模糊/磨砂旋钮与明暗模式），未启用则回退到通用毛玻璃（`--dsw-alias-bg-mask-drop` + `blur(18px)`）。

## License

MIT
