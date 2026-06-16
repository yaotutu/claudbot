import { runUserTurn } from "../conversation/run-user-turn.ts";
import type { ServiceContainer } from "../runtime/services.ts";
import type { ChannelInboundMessage, ChannelRunResult } from "./types.ts";

export async function runChannelTurn(
  services: ServiceContainer,
  inbound: ChannelInboundMessage,
): Promise<ChannelRunResult> {
  const conversationId = inbound.sessionKey ?? inbound.conversationId;
  const existing = await services.channelBindings.find(inbound.channel, conversationId);
  let assistantText = "";
  let completedText = "";
  let erroredText = "";

  const result = await runUserTurn(
    services,
    { source: inbound.channel, sessionId: existing?.claudebotSessionId ?? null, content: inbound.content },
    {
      send: async (event) => {
        if (event.type === "session.created") {
          await services.channelBindings.upsert({
            channel: inbound.channel,
            externalConversationId: conversationId,
            externalUserId: inbound.senderId,
            claudebotSessionId: event.session.id,
          });
        }
        if (event.type === "message.appended") assistantText = event.message.content;
        if (event.type === "run.completed" && event.result) completedText = event.result;
        if (event.type === "run.error") erroredText = event.message;
      },
    },
  );

  if (!existing && result.sessionId) {
    await services.channelBindings.upsert({
      channel: inbound.channel,
      externalConversationId: conversationId,
      externalUserId: inbound.senderId,
      claudebotSessionId: result.sessionId,
    });
  }

  return {
    sessionId: result.sessionId,
    runId: result.runId,
    isError: result.isError,
    outbound: {
      channel: inbound.channel,
      conversationId: inbound.conversationId,
      content: assistantText || completedText || erroredText || "(no response)",
      isError: result.isError,
      media: [],
      metadata: inbound.metadata,
    },
  };
}
