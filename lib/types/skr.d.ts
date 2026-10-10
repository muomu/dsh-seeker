/** skr CLI 的 JSON 响应外形（`skr --json` 全局契约）。 */
export interface SkrEnvelope {
    ok?: boolean;
    data?: unknown;
    error?: {
        code?: unknown;
        name?: string;
        message?: string;
    };
}
/** runSkr 的可选执行参数（目前仅 cwd）。 */
export interface RunSkrOptions {
    /** 在指定工作目录下执行 skr（默认沿用当前进程 cwd）。用于按会话目录绑定 workspace。 */
    cwd?: string;
}
/** 运行 `skr --json <args>` 并返回解析后的 `data`（ok !== true 时抛错）。 */
export declare function runSkr(args: string[], opts?: RunSkrOptions): Promise<unknown>;
/** 读取 skr CLI 内置 skill 的全文（SKILL.md body）；找不到/读失败返回 undefined。 */
export declare function readBundledSkill(name: string): Promise<string | undefined>;
