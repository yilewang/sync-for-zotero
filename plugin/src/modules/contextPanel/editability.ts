import type { Message } from "./types";

type EditabilityAssistantTurn = Pick<Message, "role" | "runMode"> | null | undefined;

export function canEditUserPromptTurn(params: {
  isUser: boolean;
  hasItem: boolean;
  conversationIsIdle: boolean;
  assistantPair: EditabilityAssistantTurn;
}): boolean {
  return Boolean(
    params.isUser &&
      params.hasItem &&
      params.conversationIsIdle &&
      params.assistantPair?.role === "assistant",
  );
}
