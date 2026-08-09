// Public surface for the chat module (apps/mobile/src/chat/, 027).
// SSE 流式客户端（自写 expo/fetch，非 orval）+ 解析纯函数 + 会话态机 hook + 纯 reducer。

export { parseSseChunk } from './sse-parse';
export type { ParsedFrame, ParseResult, NumberedSource, ToolResultSource } from './sse-parse';

export { sendMessage } from './chat-stream-client';
export type { ChatStreamCallbacks, ChatStreamHandle, ChatToolEvent } from './chat-stream-client';

export { chatReducer, initialChatState } from './chat-reducer';
export type { ChatState, ChatMessage, ChatStatus, ChatAction } from './chat-reducer';

export { useLastConversationStore } from './last-conversation-store';
export type { LastConversationState } from './last-conversation-store';

export { useChat } from './use-chat';
export type { ChatModel } from './use-chat';

export { ChatHomeScreen } from './chat-home-screen';
export { CHAT_COPY, greeting } from './chat-copy';

// 028 左抽屉（历史会话 + 行操作 + 搜索 + 用户区）。
export { ChatDrawer, type ChatDrawerProps } from './chat-drawer';
export { ConversationList, type ConversationListProps } from './conversation-list';
export { useConversations, type UseConversationsResult } from './use-conversations';

// 029 模型切换（DeepSeek flash/pro 双模式）。
export { useModels, resolveModels, DEFAULT_MODELS, type UseModelsResult } from './use-models';
export {
  ModelSwitcherTrigger,
  ModelDropdown,
  type ModelSwitcherTriggerProps,
  type ModelDropdownProps,
} from './model-switcher';
export { CHAT_MODEL_NAME } from './chat-copy';
export {
  groupConversations,
  type ConversationItem,
  type ConversationGroup,
} from './group-conversations';
