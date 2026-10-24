// Asar channel plugin for OpenClaw. Shape follows the bundled Nostr plugin (extensions/nostr/src/channel.ts):
// gateway.startAccount opens the outbound link, inbound events go to runtime.channel.reply.handleInboundMessage,
// outbound.sendText posts back over the same socket. No inbound ports, no webhooks.
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "openclaw/plugin-sdk";
import { z } from "zod";
import { AsarLink, type AsarMessageEvent } from "./link.js";
import { getRuntime } from "./runtime.js";

export const AsarConfigSchema = z.object({
  url: z.string().default("https://asar.skp.kz"),
  key: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  wakeOn: z.enum(["mention", "all"]).default("mention"),
  enabled: z.boolean().default(true),
}).passthrough();

export type ResolvedAsarAccount = {
  accountId: string; name: string; enabled: boolean; configured: boolean;
  url: string; key: string; agentId: string; wakeOn: "mention" | "all";
};

export function resolveAsarAccount({ cfg, accountId }: { cfg: any; accountId?: string | null }): ResolvedAsarAccount {
  const section = (cfg?.channels?.asar ?? {}) as z.infer<typeof AsarConfigSchema>;
  const parsed = AsarConfigSchema.safeParse(section);
  const c = parsed.success ? parsed.data : AsarConfigSchema.parse({});
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID, name: c.agentName ?? "Asar", enabled: c.enabled !== false,
    configured: Boolean(c.key), url: c.url, key: c.key ?? "", agentId: c.agentId ?? "", wakeOn: c.wakeOn,
  };
}

const links = new Map<string, AsarLink>();
export const getLink = (accountId = DEFAULT_ACCOUNT_ID) => links.get(accountId) ?? null;

export const asarPlugin: ChannelPlugin<ResolvedAsarAccount> = {
  id: "asar",
  meta: { id: "asar", label: "Asar", selectionLabel: "Asar (team workspace)", docsPath: "https://asar.skp.kz", docsLabel: "asar", blurb: "Channels where people and agents work together.", order: 60 },
  capabilities: { chatTypes: ["direct", "group"], media: false },
  reload: { configPrefixes: ["channels.asar"] },
  configSchema: buildChannelConfigSchema(AsarConfigSchema),

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveAsarAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({ accountId: account.accountId, name: account.name, enabled: account.enabled, configured: account.configured, url: account.url, agentId: account.agentId }),
    resolveAllowFrom: () => ["*"], // membership is decided by Asar: the agent only ever sees channels it was added to
    formatAllowFrom: ({ allowFrom }) => allowFrom,
  },

  security: {
    resolveDmPolicy: () => ({ policy: "open", allowFrom: ["*"], policyPath: "channels.asar.dmPolicy", allowFromPath: "channels.asar.allowFrom", approveHint: "", normalizeEntry: (raw: string) => raw.trim() }),
  },

  messaging: {
    normalizeTarget: (target) => target.replace(/^#/, "").trim(),
    targetResolver: { looksLikeId: (input) => /^#?[a-z0-9-]{2,64}$/i.test(input.trim()), hint: "<channel-id | #channel>" },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 8000,
    sendText: async ({ to, text, accountId }) => {
      const link = links.get(accountId ?? DEFAULT_ACCOUNT_ID);
      if (!link) throw new Error("asar: link not running");
      const channel = String(to).replace(/^#/, "");
      await link.post(channel, text ?? "");
      return { channel: "asar", to: channel };
    },
  },

  status: {
    defaultRuntime: { accountId: DEFAULT_ACCOUNT_ID, running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    collectStatusIssues: (accounts) => accounts.flatMap((a) => (a.lastError ? [{ channel: "asar", accountId: a.accountId, kind: "runtime" as const, message: `Asar: ${a.lastError}` }] : [])),
    buildChannelSummary: ({ snapshot }) => ({ configured: snapshot.configured ?? false, running: snapshot.running ?? false, lastStartAt: snapshot.lastStartAt ?? null, lastStopAt: snapshot.lastStopAt ?? null, lastError: snapshot.lastError ?? null }),
    buildAccountSnapshot: ({ account, runtime }) => ({ accountId: account.accountId, name: account.name, enabled: account.enabled, configured: account.configured, url: account.url, agentId: account.agentId, running: runtime?.running ?? false, lastStartAt: runtime?.lastStartAt ?? null, lastStopAt: runtime?.lastStopAt ?? null, lastError: runtime?.lastError ?? null }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) throw new Error("Asar: no key. Run `openclaw asar connect <code>` with a code from Asar → Agents.");
      const runtime = getRuntime();
      ctx.log?.info(`[asar] connecting to ${account.url} as ${account.agentId || "?"}`);

      const link = new AsarLink(account.url, account.key, {
        log: { info: (m) => ctx.log?.info(m), warn: (m) => ctx.log?.warn(m), debug: (m) => ctx.log?.debug(m) },
        onHello: (h) => { ctx.setStatus({ accountId: account.accountId, agentId: h.agent.id, name: h.agent.name }); ctx.log?.info(`[asar] hello: ${h.agent.name}, ${h.channels.length} channel(s)`); },
        onState: (s, d) => ctx.log?.debug(`[asar] ${s} ${d ?? ""}`),
        onMessage: async (e: AsarMessageEvent) => {
          // Wake policy: like Telegram groups — reply only when mentioned (or DM), unless wakeOn=all.
          if (account.wakeOn === "mention" && !e.mentioned && e.channel.kind !== "dm") return;
          const chatType = e.channel.kind === "dm" ? "direct" : "group";
          link.status("working");
          try {
            await runtime.channel.reply.handleInboundMessage({
              channel: "asar",
              accountId: account.accountId,
              senderId: e.from.id,
              senderName: e.from.name,
              chatType,
              chatId: e.channel.id,
              groupName: chatType === "group" ? "#" + e.channel.name : undefined,
              text: e.text,
              messageId: String(e.id),
              reply: async (responseText: string) => { await link.post(e.channel.id, responseText, null); },
            });
          } finally { link.status("on"); }
        },
      });
      link.start();
      links.set(account.accountId, link);
      return { stop: () => { link.stop(); links.delete(account.accountId); ctx.log?.info("[asar] stopped"); } };
    },
  },
};
