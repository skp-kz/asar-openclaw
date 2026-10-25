// Gateway side of the Asar channel: open the outbound WebSocket link per account, turn Asar events
// into OpenClaw inbound turns, and post agent replies back over the same socket.
//
// Shape follows the Nostr bundle (extensions/nostr): startAccount → runPassiveAccountLifecycle,
// DMs → dispatchInboundDirectDm, group channels → resolveAgentRoute + ingress.resolveStable +
// buildChannelInboundEventContext + dispatchChannelInboundTurn (the same primitives the direct
// helper uses internally, with conversation.kind = "group").
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilderAsync,
  dispatchChannelInboundTurn,
  dispatchInboundDirectDm,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { AsarLink, type AsarMessageEvent } from "./link.js";
import { ASAR_CHANNEL_ID, type ResolvedAsarAccount } from "./types.js";

const CHANNEL_LABEL = "Asar";

// One live link per account; outbound.sendText and `asar status` look it up here.
const links = new Map<string, AsarLink>();
export const getLink = (accountId: string) => links.get(accountId) ?? null;

type ChannelRuntime = PluginRuntime["channel"];

function toTimestamp(ts: string): number | undefined {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : undefined;
}

export async function startAsarAccount(ctx: ChannelGatewayContext<ResolvedAsarAccount>): Promise<void> {
  const account = ctx.account;
  const accountId = account.accountId;
  if (!account.configured) {
    throw new Error("Asar: no key. Run `openclaw asar connect <code>` with a code from Asar → Agents.");
  }
  ctx.setStatus({ accountId, lifecycle: "starting" });
  // Host helpers are present when the Gateway runs us with a runtime resolver; SDK imports cover the rest.
  const channelRuntime = ctx.channelRuntime as ChannelRuntime | undefined;
  const log = ctx.log;

  const onMessage = async (link: AsarLink, e: AsarMessageEvent) => {
    // Wake policy: like Telegram groups — react only when mentioned (or in a DM), unless wakeOn=all.
    const isDm = e.channel.kind === "dm";
    if (account.wakeOn === "mention" && !e.mentioned && !isDm) return;
    const text = (e.text ?? "").trim();
    if (!text) return;

    const messageId = String(e.id);
    const timestamp = toTimestamp(e.ts);
    const senderId = e.from.id;
    const senderName = e.from.name || senderId;
    const channelId = e.channel.id;
    const channelLabel = isDm ? senderName : `#${e.channel.name}`;

    const deliver = async (payload: { text?: string }) => {
      const out = sanitizeAssistantVisibleText(payload.text ?? "").trim();
      if (!out) return;
      await link.post(channelId, out, null);
    };
    const onRecordError = (err: unknown) => log?.warn(`[asar] session record failed: ${String(err)}`);
    const onDispatchError = (err: unknown, info: { kind: string }) => log?.error(`[asar] ${info.kind} reply failed: ${String(err)}`);

    link.status("working");
    try {
      if (isDm) {
        await dispatchInboundDirectDm({
          cfg: ctx.cfg,
          channel: ASAR_CHANNEL_ID,
          channelLabel: CHANNEL_LABEL,
          accountId,
          peer: { kind: "direct", id: senderId },
          senderId,
          senderAddress: senderId,
          recipientAddress: channelId,
          conversationLabel: senderName,
          rawBody: text,
          messageId,
          timestamp,
          resolveChannelIngress: async (binding) =>
            (channelRuntime?.inbound.ingress.resolveStable ?? resolveStableChannelMessageIngress)({
              channelId: ASAR_CHANNEL_ID,
              accountId,
              cfg: ctx.cfg,
              subject: { stableId: senderId },
              conversation: { kind: "direct", id: senderId },
              contextBinding: binding,
              dmPolicy: "open",
              allowFrom: ["*"],
            }),
          deliver,
          onRecordError,
          onDispatchError,
        });
        return;
      }

      // Group channel: same pipeline as the direct helper, but with a group conversation/session.
      const peer = { kind: "group" as const, id: channelId };
      const route = (channelRuntime?.routing.resolveAgentRoute ?? resolveAgentRoute)({
        cfg: ctx.cfg,
        channel: ASAR_CHANNEL_ID,
        accountId,
        peer,
      });
      const ingress = await (channelRuntime?.inbound.ingress.resolveStable ?? resolveStableChannelMessageIngress)({
        channelId: ASAR_CHANNEL_ID,
        accountId,
        cfg: ctx.cfg,
        subject: { stableId: senderId },
        conversation: { kind: "group", id: channelId, title: channelLabel },
        contextBinding: { agentId: route.agentId, sessionKey: route.sessionKey, messageId, inboundEventKind: "user_request" },
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
        groupAllowFrom: ["*"],
      });
      if (ingress.ingress.admission !== "dispatch") {
        log?.debug?.(`[asar] skip ${channelLabel}/${messageId}: ${ingress.ingress.admission} (${ingress.ingress.reasonCode})`);
        return;
      }
      const envelope = await createChannelInboundEnvelopeBuilderAsync({ cfg: ctx.cfg, route });
      const body = envelope({ channel: CHANNEL_LABEL, from: `${channelLabel} ${senderName}`, body: text, timestamp });
      const buildContext = channelRuntime?.inbound.buildContext ?? buildChannelInboundEventContext;
      const ctxPayload = buildContext({
        channel: ASAR_CHANNEL_ID,
        accountId: route.accountId ?? accountId,
        messageId,
        messageIdFull: messageId,
        timestamp,
        from: `${ASAR_CHANNEL_ID}:${channelId}`,
        sender: { id: senderId, name: senderName },
        conversation: { kind: "group", id: channelId, label: channelLabel, routePeer: peer },
        route: { agentId: route.agentId, accountId: route.accountId, routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
        reply: { to: channelId, originatingTo: channelId },
        message: { body, bodyForAgent: text, rawBody: text, commandBody: text },
        access: {
          commands: { authorized: ingress.commandAccess.authorized },
          mentions: { canDetectMention: true, wasMentioned: e.mentioned, requireMention: account.wakeOn === "mention" },
        },
        channelIngress: ingress,
        extra: { OriginatingChannel: ASAR_CHANNEL_ID, GroupSubject: channelLabel, GroupChannel: channelLabel, SenderName: senderName },
      });
      const dispatch = channelRuntime?.inbound.dispatch ?? dispatchChannelInboundTurn;
      await dispatch({
        cfg: ctx.cfg,
        channel: ASAR_CHANNEL_ID,
        accountId: route.accountId ?? accountId,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
        ctxPayload,
        record: { onRecordError },
        delivery: { deliver, onError: onDispatchError },
      });
    } finally {
      link.status("on");
    }
  };

  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () => {
      log?.info(`[asar] connecting to ${account.url} as ${account.agentId || "?"}`);
      const link: AsarLink = new AsarLink(account.url, account.key, {
        log: {
          info: (m) => log?.info(m),
          warn: (m) => log?.warn(m),
          debug: (m) => log?.debug?.(m),
        },
        onHello: (h) => {
          ctx.setStatus({ ...ctx.getStatus(), ...channelReadyPatch({ accountId, name: h.agent.name, lastConnectedAt: Date.now() }) });
          log?.info(`[asar] hello: ${h.agent.name}, ${h.channels.length} channel(s)`);
        },
        onState: (s, d) => {
          log?.debug?.(`[asar] ${s} ${d ?? ""}`.trim());
          if (s === "closed") {
            ctx.setStatus({ ...ctx.getStatus(), connected: false, lifecycle: "recovering", lastDisconnect: { at: Date.now(), error: d } });
          }
        },
        onMessage: (e) => onMessage(link, e),
      });
      link.start();
      links.set(accountId, link);
      return link;
    },
    stop: async (link) => {
      link.stop();
      if (links.get(accountId) === link) links.delete(accountId);
      ctx.setStatus({ ...ctx.getStatus(), ...channelStoppedPatch({ accountId }) });
      log?.info("[asar] stopped");
    },
  });
}
