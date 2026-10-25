// Asar channel plugin for OpenClaw (plugin SDK 2026.10). Shape follows the bundled Nostr plugin:
// createChatChannelPlugin({ base, security, outbound }) with top-level single-account config,
// outbound.sendText posting over the live AsarLink, gateway.startAccount in ./gateway.ts.
import { createTopLevelChannelConfigAdapter, createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { collectStatusIssuesFromLastError, createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { getLink, startAsarAccount } from "./gateway.js";
import { ASAR_CHANNEL_ID, AsarConfigSchema, resolveAsarAccount, type ResolvedAsarAccount } from "./types.js";

export { getLink } from "./gateway.js";
export { AsarConfigSchema, resolveAsarAccount, type ResolvedAsarAccount } from "./types.js";

const normalizeTarget = (target: string) => target.replace(/^asar:/i, "").replace(/^#/, "").trim();

const asarOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 8000,
  chunker: chunkTextForOutbound,
  sendText: async ({ to, text, accountId }) => {
    const link = getLink(accountId ?? DEFAULT_ACCOUNT_ID);
    if (!link) throw new Error("asar: link not running (is the channel enabled and connected?)");
    const channel = normalizeTarget(String(to));
    const posted = await link.post(channel, text ?? "", null);
    return attachChannelToResult(ASAR_CHANNEL_ID, { to: channel, messageId: String(posted.id) });
  },
};

export const asarPlugin: ChannelPlugin<ResolvedAsarAccount> = createChatChannelPlugin<ResolvedAsarAccount>({
  base: {
    id: ASAR_CHANNEL_ID,
    meta: {
      id: ASAR_CHANNEL_ID,
      label: "Asar",
      selectionLabel: "Asar (team workspace)",
      docsPath: "https://asar.skp.kz",
      docsLabel: "asar",
      blurb: "Channels where people and agents work together. Connect with a code from Asar.",
      order: 60,
    },
    capabilities: { chatTypes: ["direct", "group"], media: false },
    reload: { configPrefixes: [`channels.${ASAR_CHANNEL_ID}`] },
    // Cast: openclaw ships its own nested zod copy (4.6.5) and the two `ZodTypeAny` declarations are not
    // mutually assignable even for the same schema; at runtime buildChannelConfigSchema only needs `_zod`/`safeParse`.
    configSchema: buildChannelConfigSchema(AsarConfigSchema as unknown as Parameters<typeof buildChannelConfigSchema>[0], {
      uiHints: { key: { label: "Agent key", sensitive: true } },
    }),

    config: {
      ...createTopLevelChannelConfigAdapter<ResolvedAsarAccount>({
        sectionKey: ASAR_CHANNEL_ID,
        resolveAccount: (cfg: OpenClawConfig) => resolveAsarAccount({ cfg }),
        listAccountIds: () => [DEFAULT_ACCOUNT_ID],
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        deleteMode: "clear-fields",
        clearBaseFields: ["url", "key", "agentId", "agentName", "wakeOn"],
        // Membership is decided by Asar: the agent only ever sees channels it was added to.
        resolveAllowFrom: () => ["*"],
        formatAllowFrom: (allowFrom) => allowFrom.map(String),
      }),
      resolveAccount: (cfg, accountId) => resolveAsarAccount({ cfg, accountId }),
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      unconfiguredReason: () => "no agent key — run `openclaw asar connect <code>`",
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        url: account.url,
        agentId: account.agentId,
        wakeOn: account.wakeOn,
      }),
    },

    messaging: {
      targetPrefixes: [ASAR_CHANNEL_ID],
      normalizeTarget,
      targetResolver: {
        looksLikeId: (input) => /^(asar:)?#?[a-z0-9_-]{2,64}$/i.test(input.trim()),
        hint: "<channel-id | #channel>",
      },
    },

    message: createChannelMessageAdapterFromOutbound({ id: ASAR_CHANNEL_ID, outbound: asarOutbound }),

    status: createComputedAccountStatusAdapter<ResolvedAsarAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts) => collectStatusIssuesFromLastError(ASAR_CHANNEL_ID, accounts),
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastStartAt: snapshot.lastStartAt ?? null,
        lastStopAt: snapshot.lastStopAt ?? null,
        lastError: snapshot.lastError ?? null,
      }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          url: account.url,
          agentId: account.agentId,
          wakeOn: account.wakeOn,
          online: getLink(account.accountId)?.online ?? false,
        },
      }),
    }),

    gateway: {
      startAccount: startAsarAccount,
    },
  },

  // DMs are always open: Asar itself decides who can talk to the agent.
  security: {
    resolveDmPolicy: createScopedDmSecurityResolver<ResolvedAsarAccount>({
      channelKey: ASAR_CHANNEL_ID,
      resolvePolicy: () => "open",
      resolveAllowFrom: () => ["*"],
      policyPathSuffix: "dmPolicy",
      allowFromPathSuffix: "allowFrom",
      defaultPolicy: "open",
      approveHint: "",
      normalizeEntry: (raw) => raw.trim(),
    }),
  },

  outbound: asarOutbound,
});
