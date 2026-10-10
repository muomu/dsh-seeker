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
import { type ReactNode } from 'react';
import { type LoadSessions } from './workbench.tsx';
/** 会话标准 kit 的宽松面（session 作用域槽位由框架注入 useSession/sessionId）。
 *  dsh 0.1.7-rc.2 起 useSession 选择的是 SessionSnapshot：hero（空白新会话）
 *  判定从旧的 conversation.composerPhase === 'blank' 改为 snapshot.blank。 */
interface SessionKit {
    sessionId: string;
    useSession<S>(sel: (s: {
        blank?: boolean;
    }) => S): S;
}
export interface MineDockProps extends SessionKit {
    sessions: LoadSessions;
}
/** hero 栏主体：hero 时拉取 /seeker/api/mine 并渲染 chip 排；非 hero / 空 / 失败返回 null。 */
export declare function SeekerMineDock(props: MineDockProps): ReactNode;
export {};
