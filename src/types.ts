// Config shape and resolved account for the Asar channel (channels.asar in openclaw.json).
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { z } from "zod";

export const ASAR_CHANNEL_ID = "asar";
export const ASAR_DEFAULT_URL = "https://asar.skp.kz";

export const AsarConfigSchema = z.object({
  url: z.string().default(ASAR_DEFAULT_URL),
  key: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  wakeOn: z.enum(["mention", "all"]).default("mention"),
  enabled: z.boolean().default(true),
}).passthrough();

export type AsarConfig = z.infer<typeof AsarConfigSchema>;

export type ResolvedAsarAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  url: string;
  key: string;
  agentId: string;
  wakeOn: "mention" | "all";
};

export function readAsarSection(cfg: OpenClawConfig | null | undefined): Record<string, unknown> {
  const section = (cfg?.channels as Record<string, unknown> | undefined)?.[ASAR_CHANNEL_ID];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

export function resolveAsarAccount({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }): ResolvedAsarAccount {
  const parsed = AsarConfigSchema.safeParse(readAsarSection(cfg));
  const c: AsarConfig = parsed.success ? parsed.data : AsarConfigSchema.parse({});
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    name: c.agentName ?? "Asar",
    enabled: c.enabled !== false,
    configured: Boolean(c.key),
    url: c.url,
    key: c.key ?? "",
    agentId: c.agentId ?? "",
    wakeOn: c.wakeOn,
  };
}
