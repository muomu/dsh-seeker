import { randomUUID } from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
//#region src/skr.ts
/**
* skr (Seeker CLI) 执行器：以 `skr --json <args>` 方式调用本地 CLI 并解析
* 机器可读输出。插件工具的全部参数校验、错误处理与输出解析都收敛在这里。
*
* 注意：host 半区刻意不依赖任何 @deepseek-ai/* 运行时模块（profile 只解析
* 插件包自身），skr 通过 child_process 直接调用本机二进制。
*/
const execFileP = promisify(execFile);
/** 运行 `skr --json <args>` 并返回解析后的 `data`（ok !== true 时抛错）。 */
async function runSkr(args, opts) {
	try {
		const { stdout } = await execFileP("skr", ["--json", ...args], {
			timeout: 6e4,
			maxBuffer: 16777216,
			env: process.env,
			...opts?.cwd !== void 0 ? { cwd: opts.cwd } : {}
		});
		let parsed;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(`skr 输出不是合法 JSON（${stdout.slice(0, 200)}）`);
		}
		if (parsed.ok !== true) throw new Error(`skr ${args[0] ?? ""} 失败：${parsed.error?.message ?? "未知错误"}`);
		return parsed.data;
	} catch (error) {
		if (error instanceof Error && error.code === "ENOENT") throw new Error("未找到 skr 命令：请先安装 Seeker CLI（skr）并确保其在 PATH 中");
		const execErr = error;
		if (typeof execErr.stdout === "string" && execErr.stdout.trim() !== "") try {
			const parsed = JSON.parse(execErr.stdout);
			if (parsed.ok === false && typeof parsed.error?.message === "string") throw new Error(`skr ${args[0] ?? ""} 失败：${parsed.error.message}`);
		} catch (inner) {
			if (inner instanceof Error && inner.message.startsWith("skr ")) throw inner;
		}
		if (typeof execErr.stderr === "string" && execErr.stderr.trim() !== "") {
			const tail = execErr.stderr.trim().split("\n").slice(-3).join(" ");
			throw new Error(`${error instanceof Error ? error.message : String(error)} — ${tail.slice(0, 300)}`);
		}
		throw error;
	}
}
const skillCache = /* @__PURE__ */ new Map();
/** 读取 skr CLI 内置 skill 的全文（SKILL.md body）；找不到/读失败返回 undefined。 */
async function readBundledSkill(name) {
	if (skillCache.has(name)) return skillCache.get(name);
	let body;
	try {
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (dir === "") continue;
			const bin = join(dir, "skr");
			try {
				await access(bin, constants.X_OK);
				const target = await realpath(bin);
				body = await readFile(join(dirname(target), "skills", name, "SKILL.md"), "utf8");
				break;
			} catch {}
		}
	} catch {
		body = void 0;
	}
	skillCache.set(name, body);
	return body;
}
//#endregion
//#region src/data.ts
/**
* dsh-seeker host 数据函数层：skr CLI 封装的核心逻辑（参数校验、--json 解析、
* 错误处理）。供 /seeker/api 直连路由使用（面板数据通道，零模型参与）。
*
* 零 @deepseek-ai 运行时依赖，纯函数导出。
*/
/** 把用户提供的 workspace key/id 规范化成参数数组（无值则不传，用活跃 workspace）。 */
function wsArgs(workspace) {
	return workspace === void 0 || workspace === "" ? [] : ["--workspace", workspace];
}
const ctxCache = /* @__PURE__ */ new Map();
const ctxInflight = /* @__PURE__ */ new Map();
const CONTEXT_TTL_MS = 6e4;
const CONTEXT_CACHE_MAX = 50;
function pruneCtxCache() {
	const now = Date.now();
	for (const [key, entry] of ctxCache) if (entry.expiresAt <= now) ctxCache.delete(key);
	if (ctxCache.size > CONTEXT_CACHE_MAX) ctxCache.clear();
}
/** 带 TTL 与并发去重的上下文加载（key 为元数据实际覆盖的 workspace）。 */
async function cachedContext(key, loader) {
	pruneCtxCache();
	const hit = ctxCache.get(key);
	if (hit !== void 0 && hit.expiresAt > Date.now()) return hit.value;
	const existing = ctxInflight.get(key);
	if (existing !== void 0) return existing;
	const promise = loader().then((value) => {
		ctxCache.set(key, {
			value,
			expiresAt: Date.now() + CONTEXT_TTL_MS
		});
		return value;
	}).finally(() => {
		ctxInflight.delete(key);
	});
	ctxInflight.set(key, promise);
	return promise;
}
/** 并行拉取指定 workspace 的项目/标签/saved views（互不依赖，一波并发）。 */
async function fetchWorkspaceMeta(workspace) {
	const wa = wsArgs(workspace);
	const [projects, labels, views] = await Promise.all([
		runSkr([
			"project",
			"list",
			...wa
		]),
		runSkr([
			"label",
			"list",
			...wa
		]),
		runSkr([
			"view",
			"list",
			...wa
		])
	]);
	return {
		projects,
		labels,
		views
	};
}
/** 拉取工作区上下文：workspace 列表 + 指定 workspace 的项目/标签/saved views。
* - workspace 已知：ws/project/label/view 四个 skr 调用一波并发
*   （原串行 ≈4×0.4s → 一波 ≈0.5s）；
* - workspace 未知：拉 workspace 列表后顺带并行拉第一个 workspace 的元数据
*   （响应带 `workspace` 字段标明覆盖对象），客户端免二次请求；
* - 结果按实际覆盖的 workspace 走 TTL 缓存（60s）+ 并发去重。 */
async function fetchContextData(args) {
	const { workspace } = args;
	if (workspace === void 0 || workspace === "") {
		const workspaces = (await runSkr(["ws", "list"])).workspaces ?? [];
		const first = workspaces[0]?.key;
		if (first === void 0) return {
			workspaces,
			projects: [],
			labels: [],
			views: []
		};
		return cachedContext(`context:${first}`, async () => {
			const meta = await fetchWorkspaceMeta(first);
			return {
				workspaces,
				projects: meta.projects,
				labels: meta.labels,
				views: meta.views,
				workspace: first
			};
		});
	}
	return cachedContext(`context:${workspace}`, async () => {
		const [wsData, meta] = await Promise.all([runSkr(["ws", "list"]), fetchWorkspaceMeta(workspace)]);
		return {
			workspaces: wsData.workspaces ?? [],
			projects: meta.projects,
			labels: meta.labels,
			views: meta.views,
			workspace
		};
	});
}
/** 列出指定 workspace 的 saved views（供 saved view 选择器）。 */
async function listViewsData(workspace) {
	return { items: await runSkr([
		"view",
		"list",
		...wsArgs(workspace)
	]) };
}
/** skr issue list 每页上限（CLI 固定 1-100）。 */
const ISSUE_PAGE_LIMIT = 100;
/** 全量翻页的并发批大小（一批内的页码并发拉取，满页则继续下一批）。 */
const ISSUE_PAGE_BATCH = 5;
/** 组装一次 issue 列表/搜索的 CLI 参数（不含 --limit/--page，由调用方追加）。 */
function buildIssueListArgs(args, search, useView) {
	const argsList = search ? [
		"issue",
		"search",
		args.query.trim()
	] : ["issue", "list"];
	argsList.push(...wsArgs(args.workspace));
	if (useView) argsList.push("--view", args.view.trim());
	else {
		if (args.all === true) argsList.push("--all");
		if (args.status !== void 0 && args.status !== "") argsList.push("--status", args.status);
		if (args.type !== void 0 && args.type !== "") argsList.push("--type", args.type);
		if (args.project !== void 0 && args.project !== "") argsList.push("--project", args.project);
		if (Array.isArray(args.labels) && args.labels.length > 0) argsList.push("--labels", args.labels.join(","));
		if (args.assignee !== void 0 && args.assignee !== "") argsList.push("--assignee", args.assignee);
		if (args.priority !== void 0 && args.priority !== "") argsList.push("--priority", args.priority);
	}
	return argsList;
}
/** 拉取指定页码（limit=100，满页 100 条表示还有下一页）。 */
async function fetchIssuePage(argsList, page) {
	return await runSkr([
		...argsList,
		"--limit",
		String(ISSUE_PAGE_LIMIT),
		"--page",
		String(page)
	]);
}
/** 全量翻页聚合：page 1 起，满页则按批并发翻剩余页，直到出现短页。
* 超出末尾的页返回空数组（已实测），故首个短页之后的结果直接丢弃。
* 单批任一页失败 → 整批失败（错误卡 + 重试兜底）。 */
async function listIssuesAllPages(args) {
	const argsList = buildIssueListArgs(args, typeof args.query === "string" && args.query.trim() !== "", typeof args.view === "string" && args.view.trim() !== "");
	const first = await fetchIssuePage(argsList, 1);
	if (first.length < ISSUE_PAGE_LIMIT) return { items: first };
	const all = [...first];
	let batchStart = 2;
	for (;;) {
		const pages = Array.from({ length: ISSUE_PAGE_BATCH }, (_, i) => batchStart + i);
		const results = await Promise.all(pages.map((p) => fetchIssuePage(argsList, p)));
		const shortIdx = results.findIndex((r) => r.length < ISSUE_PAGE_LIMIT);
		if (shortIdx === -1) {
			all.push(...results.flat());
			batchStart += ISSUE_PAGE_BATCH;
			continue;
		}
		all.push(...results.slice(0, shortIdx + 1).flat());
		return { items: all };
	}
}
/** 列表或搜索（query 存在时走 search；view 存在时走 --view 复用筛选+排序；
*  allPages 时走全量翻页聚合，返回合并后的完整列表）。 */
async function listIssuesData(args) {
	const search = typeof args.query === "string" && args.query.trim() !== "";
	const useView = typeof args.view === "string" && args.view.trim() !== "";
	if (args.allPages === true && !search) return listIssuesAllPages(args);
	const argsList = buildIssueListArgs(args, search, useView);
	if (args.limit !== void 0 && args.limit > 0) argsList.push("--limit", String(Math.min(100, args.limit)));
	if (!search && !useView && args.page !== void 0 && args.page > 0) argsList.push("--page", String(args.page));
	return { items: await runSkr(argsList) };
}
/** 收件箱的状态范围（对齐 skr todo：默认不含 in_review/done；all 追加）。 */
const INBOX_STATUSES = "backlog,todo,in_progress";
const INBOX_STATUSES_ALL = "backlog,todo,in_progress,in_review,done";
/** 拉取收件箱（当前用户名下待办，全量翻页取回）。 */
async function listInboxData(args) {
	let me;
	try {
		me = await cachedWhoami();
	} catch {
		return {
			total: 0,
			items: []
		};
	}
	if (me === "") return {
		total: 0,
		items: []
	};
	const inboxArgs = {
		assignee: me,
		status: args.all === true ? INBOX_STATUSES_ALL : INBOX_STATUSES,
		allPages: true
	};
	if (args.workspace !== void 0 && args.workspace !== "") inboxArgs.workspace = args.workspace;
	const { items } = await listIssuesData(inboxArgs);
	return {
		total: items.length,
		items
	};
}
/** hero 栏最多展示的条数。 */
const MINE_TOP_N = 10;
/** 优先级排序枚举（P0 最高；未知/缺失排最后）。 */
const PRIORITY_RANK = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3
};
const WHOAMI_TTL_MS = 6e4;
let whoamiCache;
let whoamiInflight;
/** 当前登录用户的 displayName（whoami 结果 60s TTL 缓存，并发共享同一次调用）。 */
async function cachedWhoami() {
	if (whoamiCache !== void 0 && whoamiCache.expiresAt > Date.now()) return whoamiCache.value;
	if (whoamiInflight !== void 0) return whoamiInflight;
	const promise = (async () => {
		const data = await runSkr(["whoami"]);
		const name = data.displayName ?? data.customDisplayName ?? "";
		whoamiCache = {
			value: name,
			expiresAt: Date.now() + WHOAMI_TTL_MS
		};
		return name;
	})().finally(() => {
		whoamiInflight = void 0;
	});
	whoamiInflight = promise;
	return promise;
}
/** backlog 状态排最前；组内按优先级（未知/缺失垫底），同级按 updatedAt 倒序。 */
function compareMine(a, b) {
	const statusOf = (s) => s === "backlog" ? 0 : 1;
	const sa = statusOf(a.status);
	const sb = statusOf(b.status);
	if (sa !== sb) return sa - sb;
	const rankOf = (p) => p !== void 0 && p !== "" ? PRIORITY_RANK[p] ?? 99 : 99;
	const ra = rankOf(a.priority);
	const rb = rankOf(b.priority);
	if (ra !== rb) return ra - rb;
	return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}
/** 「我认领的 issue」：当前用户作为负责人、当前绑定 workspace、默认未完成范围，
* backlog 状态排最前、组内按优先级排序取前 10。whoami 失败或列表为空 → 空数组（前端隐藏栏）。 */
async function listMineData() {
	let name;
	try {
		name = await cachedWhoami();
	} catch {
		return { items: [] };
	}
	if (name === "") return { items: [] };
	const [{ items }, ws] = await Promise.all([listIssuesData({
		assignee: name,
		limit: ISSUE_PAGE_LIMIT
	}), runSkr(["ws", "current"]).then((d) => d.key).catch(() => void 0)]);
	return {
		items: [...items].sort(compareMine).slice(0, MINE_TOP_N),
		...ws !== void 0 && ws !== "" ? { workspace: ws } : {}
	};
}
/** 单条详情（含 markdown 正文与评论）。 */
async function getIssueData(args) {
	if (typeof args.id !== "string" || args.id.trim() === "") throw new Error("缺少 id 参数");
	return runSkr([
		"issue",
		"get",
		args.id.trim()
	]);
}
function flat(v) {
	if (v === void 0 || v === null) return "";
	if (typeof v === "string") return v;
	return String(v);
}
function person(identity, fallback) {
	return identity?.displayName ?? fallback ?? "";
}
/** 把 issue get 的原始 JSON 序列化成结构化文本（加载进新会话的第一条消息）。 */
function formatIssueContext(raw) {
	const it = raw ?? {};
	const lines = [];
	lines.push("【已加载 Issue】");
	lines.push("说明：本消息是仅读取的上下文注入——供你阅读与和用户讨论该 issue。不要自行开工：不要修改代码、不要创建/变更 issue 或其状态、不要执行任何写操作；等用户明确指示后再行动。");
	lines.push(`编号：${flat(it.id) || "—"}`);
	lines.push(`标题：${flat(it.title) || "（无标题）"}`);
	const meta = [];
	if (flat(it.type)) meta.push(`类型：${flat(it.type)}`);
	if (flat(it.status)) meta.push(`状态：${flat(it.status)}`);
	if (flat(it.priority)) meta.push(`优先级：${flat(it.priority)}`);
	if (flat(it.project)) meta.push(`项目：${flat(it.project)}`);
	if (flat(it.delivery)) meta.push(`交付：${flat(it.delivery)}`);
	const assignee = person(it.assigneeIdentity, flat(it.assignee));
	if (assignee) meta.push(`负责人：${assignee}`);
	const reporter = person(it.reporterIdentity, flat(it.reporter));
	if (reporter) meta.push(`报告人：${reporter}`);
	if (flat(it.createdAt)) meta.push(`创建：${flat(it.createdAt)}`);
	if (flat(it.updatedAt)) meta.push(`更新：${flat(it.updatedAt)}`);
	if (meta.length > 0) lines.push(`元数据：${meta.join("；")}`);
	if (Array.isArray(it.labels) && it.labels.length > 0) lines.push(`标签：${it.labels.map((l) => flat(l)).filter(Boolean).join(", ")}`);
	const body = flat(it.bodyText);
	lines.push("");
	lines.push("描述：");
	lines.push(body !== "" ? body : "（无描述）");
	const comments = Array.isArray(it.comments) ? it.comments : [];
	if (comments.length > 0) {
		lines.push("");
		lines.push(`评论（${comments.length}）：`);
		for (const c of comments) {
			const author = flat(c.authorDisplayName) || "匿名";
			const when = flat(c.createdAt);
			const who = [
				author,
				flat(c.kind),
				flat(c.agent)
			].filter(Boolean).join(" · ");
			lines.push(`- ${who}${when ? `（${when}）` : ""}`);
			const cb = flat(c.bodyText);
			if (cb !== "") for (const seg of cb.split("\n")) lines.push(`  ${seg}`);
		}
	}
	lines.push("");
	lines.push("（再次强调：仅读取。回复请限于对以上内容的理解/讨论/建议，不要开始实施，等用户指示。）");
	return lines.join("\n");
}
/** 把指定目录绑定到 Seeker workspace（`skr ws bind <key>`）。
* cwd 缺省时沿用当前进程目录（与 loadIssueSession 的会话 cwd 一致）。
* skr 绑定失败（如 workspace 不存在）抛错，由调用方决定是否让加载失败。 */
async function bindWorkspaceData(workspace, cwd) {
	if (typeof workspace !== "string" || workspace.trim() === "") throw new Error("缺少 workspace 参数");
	await runSkr([
		"ws",
		"bind",
		workspace.trim()
	], cwd !== void 0 ? { cwd } : void 0);
}
/** 创建 story（body 走临时文件）。保留端点，供未来复用。 */ async function createStoryData(args) {
	if (typeof args.title !== "string" || args.title.trim() === "" || typeof args.body !== "string") throw new Error("缺少 title 或 body 参数");
	const { writeFile, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const tmp = join(tmpdir(), `seeker-story-${process.pid}-${Date.now()}.md`);
	await writeFile(tmp, args.body, "utf8");
	try {
		const argsList = [
			"issue",
			"create",
			"--type",
			"story",
			"--title",
			args.title.trim(),
			"--body-file",
			tmp,
			"--agent",
			"dsh-seeker"
		];
		argsList.push(...wsArgs(args.workspace));
		if (args.project !== void 0 && args.project !== "") argsList.push("--project", args.project);
		if (args.priority !== void 0 && args.priority !== "") argsList.push("--priority", args.priority);
		for (const label of args.labels ?? []) if (typeof label === "string" && label.trim() !== "") argsList.push("--label", label.trim());
		const data = await runSkr(argsList);
		return { issue: {
			id: data.id,
			...data.title !== void 0 ? { title: data.title } : {},
			...data.status !== void 0 ? { status: data.status } : {},
			...data.priority !== void 0 ? { priority: data.priority } : {}
		} };
	} finally {
		await rm(tmp, { force: true }).catch(() => {});
	}
}
//#endregion
//#region src/api.ts
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
/** 路由前缀（注册到 webServer，longest-prefix 优先于 /api 桥）。 */
const SEEKER_API_ROUTE = "/seeker/api";
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(payload);
}
function ok(res, data) {
	json(res, 200, {
		ok: true,
		data
	});
}
function fail(res, status, error) {
	json(res, status, {
		ok: false,
		error: error instanceof Error ? error.message : String(error)
	});
}
/** 读取 POST body（限量 2MB）。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 2097152) {
				reject(/* @__PURE__ */ new Error("body 过大（>2MB）"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function boolOf(value) {
	if (value === null) return void 0;
	return value === "true" || value === "1";
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
async function loadIssueSession(ctx, issueId, opts) {
	if (typeof issueId !== "string" || issueId.trim() === "") throw new Error("缺少 id 参数");
	const [raw, skrSkill] = await Promise.all([getIssueData({ id: issueId.trim() }), readBundledSkill("skr")]);
	const text = formatIssueContext(raw);
	const agents = ctx.agents;
	const sessions = ctx.sessions;
	const defaultModel = ctx.get("agentDefaultModel");
	if (agents === void 0 || sessions === void 0 || defaultModel === void 0) throw new Error("会话服务不可用（agents/sessions/agentDefaultModel 未注入）");
	const selection = opts?.model !== void 0 && opts.model.provider !== "" && opts.model.model !== "" ? {
		provider: opts.model.provider,
		model: opts.model.model
	} : defaultModel.currentSelection();
	const cwd = opts?.cwd ?? process.cwd();
	if (opts?.workspace !== void 0 && opts.workspace.trim() !== "") await bindWorkspaceData(opts.workspace, cwd);
	const sessionId = SessionId(`seeker-load-${randomUUID()}`);
	const presets = ctx.get("agentPresets");
	const agentPreset = presets !== void 0 ? (await presets.resolve(void 0)).id : void 0;
	const handle = await agents.create({
		sessionId,
		meta: {
			cwd,
			...agentPreset !== void 0 ? { agentPreset } : {}
		},
		agentOptions: {
			provider: selection.provider,
			model: selection.model
		},
		setup: async (agentCtx) => {
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
			if (presets !== void 0 && agentPreset !== void 0) await presets.mount(agentCtx, agentPreset);
		}
	});
	const agent = handle.agent;
	const registry = ctx.workspaceRegistry;
	if (registry !== void 0) try {
		await (await registry.create(cwd)).attachSession(agent.session.id);
	} catch (error) {
		await handle.dispose().catch(() => {});
		throw error;
	}
	const titles = ctx.get("sessionTitle");
	if (titles !== void 0) {
		const issueTitle = flatTitle(raw.title);
		try {
			titles.rename(agent.session, `${issueId.trim()}｜${issueTitle !== "" ? issueTitle : "（无标题）"}`);
		} catch {}
	}
	if (skrSkill !== void 0) agent.inject(createUserMessage({
		content: [{
			type: "text",
			text: `【skr Skill】以下是 skr CLI 内置 skill 的全文，是你用 skr 操作 Seeker issue 的规矩与命令参考：\n\n${skrSkill}`
		}],
		source: {
			kind: "dsh-seeker",
			form: "notice",
			summary: boundContextSummary("注入 skr skill 上下文")
		}
	}));
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "dsh-seeker",
			form: "notice",
			summary: boundContextSummary(`加载 issue ${issueId.trim()}`)
		}
	}));
	return { sessionId: agent.session.id };
}
/** issue title 归一化为单行文本（标题进会话名，去掉换行避免刷屏）。 */
function flatTitle(v) {
	if (typeof v !== "string") return "";
	return v.replace(/\s+/g, " ").trim();
}
/** 处理一次 /seeker/api 请求（导出供测试）。 */
async function handleSeekerApi(method, pathname, params, bodyText) {
	try {
		if (method === "GET" && pathname === `/seeker/api/context`) return {
			ok: true,
			data: await fetchContextData({ workspace: params.get("workspace") ?? void 0 })
		};
		if (method === "GET" && pathname === `/seeker/api/views`) return {
			ok: true,
			data: await listViewsData(params.get("workspace") ?? void 0)
		};
		if (method === "GET" && pathname === `/seeker/api/mine`) return {
			ok: true,
			data: await listMineData()
		};
		if (method === "GET" && pathname === `/seeker/api/inbox`) return {
			ok: true,
			data: await listInboxData({
				workspace: params.get("workspace") ?? void 0,
				all: boolOf(params.get("all"))
			})
		};
		if (method === "GET" && pathname === `/seeker/api/list`) return {
			ok: true,
			data: await listIssuesData({
				workspace: params.get("workspace") ?? void 0,
				query: params.get("query") ?? void 0,
				all: boolOf(params.get("all")),
				allPages: boolOf(params.get("allPages")),
				status: params.get("status") ?? void 0,
				type: params.get("type") ?? void 0,
				project: params.get("project") ?? void 0,
				view: params.get("view") ?? void 0,
				limit: params.get("limit") !== null ? Number(params.get("limit")) : void 0,
				page: params.get("page") !== null ? Number(params.get("page")) : void 0
			})
		};
		if (method === "GET" && pathname === `/seeker/api/issue`) {
			const id = params.get("id");
			if (id === null || id.trim() === "") return {
				ok: false,
				error: "缺少 id 参数（?id=SEE-xxx）"
			};
			return {
				ok: true,
				data: { issue: await getIssueData({ id }) }
			};
		}
		if (method === "POST" && pathname === `/seeker/api/create`) {
			let parsed;
			try {
				parsed = JSON.parse(bodyText);
			} catch {
				return {
					ok: false,
					error: "create 请求体不是合法 JSON"
				};
			}
			return {
				ok: true,
				data: await createStoryData(parsed ?? {})
			};
		}
		return {
			ok: false,
			error: `未支持的路由：${method} ${pathname}`
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
/** webServer 路由处理器（注册用）。ctx 用于「加载」操作创建会话。 */
function createSeekerRouteHandler(ctx) {
	return async (req, res) => {
		if (req.method !== "GET" && req.method !== "POST") {
			fail(res, 405, "仅支持 GET / POST");
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? "/", "http://localhost");
		} catch {
			fail(res, 400, "URL 解析失败");
			return;
		}
		if (!url.pathname.startsWith(`/seeker/api/`)) {
			fail(res, 404, "未找到");
			return;
		}
		let bodyText = "";
		if (req.method === "POST") try {
			bodyText = await readBody(req);
		} catch (error) {
			fail(res, 400, error instanceof Error ? error.message : String(error));
			return;
		}
		if (req.method === "POST" && url.pathname === `/seeker/api/load`) {
			if (ctx === void 0) {
				fail(res, 503, "加载需要会话服务（host 未注入 agents/sessions）");
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(bodyText);
			} catch {
				fail(res, 400, "load 请求体不是合法 JSON");
				return;
			}
			try {
				const loadOpts = {};
				if (parsed.workspace !== void 0 && parsed.workspace.trim() !== "") loadOpts.workspace = parsed.workspace;
				if (parsed.cwd !== void 0 && parsed.cwd.trim() !== "") loadOpts.cwd = parsed.cwd;
				if (parsed.model !== void 0 && typeof parsed.model.provider === "string" && parsed.model.provider !== "" && typeof parsed.model.model === "string" && parsed.model.model !== "") loadOpts.model = {
					provider: parsed.model.provider,
					model: parsed.model.model
				};
				ok(res, await loadIssueSession(ctx, parsed.id ?? "", loadOpts));
			} catch (error) {
				fail(res, 400, error instanceof Error ? error.message : String(error));
			}
			return;
		}
		const result = await handleSeekerApi(req.method, url.pathname, url.searchParams, bodyText);
		if (result.ok) ok(res, result.data);
		else fail(res, 400, result.error);
	};
}
//#endregion
//#region src/index.ts
/** host 入口：注册 /seeker/api 直连路由（webServer 可选服务，探针 + 订阅）。
* 「加载」需要 agents/sessions/agentDefaultModel 创建会话，并用
* workspaceRegistry 把新会话挂到项目所在的工作区（GUI 分组）。 */
const inject = [
	"webServer",
	"agents",
	"sessions",
	"agentDefaultModel",
	"workspaceRegistry"
];
function apply(ctx) {
	let routeRegistered = false;
	const tryRegisterRoute = (value) => {
		if (routeRegistered) return;
		const webServer = value ?? ctx.reflect.get("webServer", false);
		if (webServer === void 0) return;
		webServer.register({
			kind: "prefix",
			path: SEEKER_API_ROUTE,
			handler: createSeekerRouteHandler(ctx)
		});
		routeRegistered = true;
	};
	tryRegisterRoute(void 0);
	ctx.on("internal/service", (name, value) => {
		if (name === "webServer") tryRegisterRoute(value);
	});
}
//#endregion
export { SEEKER_API_ROUTE, apply, bindWorkspaceData, createSeekerRouteHandler, createStoryData, fetchContextData, formatIssueContext, getIssueData, handleSeekerApi, inject, listInboxData, listIssuesData, listMineData, listViewsData, loadIssueSession };
