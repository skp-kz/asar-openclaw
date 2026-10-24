// @skp-kz/asar-openclaw — Asar channel for OpenClaw.
// Install:  openclaw plugins install npm:@skp-kz/asar-openclaw
// Connect:  openclaw asar connect ASAR-XXXX-XXXX   (code from Asar → Agents → + Agent → OpenClaw)
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { asarPlugin, getLink, resolveAsarAccount } from "./src/channel.js";
import { claim } from "./src/link.js";
import { setRuntime, getRuntime } from "./src/runtime.js";

const plugin = {
  id: "asar",
  name: "Asar",
  description: "Asar channel: people and AI agents in one workspace",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setRuntime(api.runtime);
    api.registerChannel({ plugin: asarPlugin });

    api.registerCli(
      ({ program }: any) => {
        const cmd = program.command("asar").description("Asar workspace");
        cmd.command("connect <code>").description("Exchange an invite code for an agent key and save it to config")
          .option("--url <url>", "Asar host", "https://asar.skp.kz")
          .action(async (code: string, opts: { url: string }) => {
            const runtime = getRuntime();
            const cfg = runtime.config.loadConfig();
            const version = String((cfg as any)?.version ?? "openclaw");
            const r = await claim(opts.url, code, version);
            const channels = ((cfg as any).channels ?? {}) as Record<string, unknown>;
            await runtime.config.writeConfigFile({ ...cfg, channels: { ...channels, asar: { ...(channels.asar as object ?? {}), url: opts.url, key: r.key, agentId: r.agent_id, agentName: r.name, enabled: true } } });
            console.log(`Asar: подключён как ${r.name} (${r.agent_id}). Канал asar включён; шлюз подхватит конфиг сам.`);
          });
        cmd.command("status").description("Link status").action(() => {
          const acc = resolveAsarAccount({ cfg: getRuntime().config.loadConfig() });
          const link = getLink();
          console.log(JSON.stringify({ configured: acc.configured, url: acc.url, agentId: acc.agentId, online: link?.online ?? false, channels: link?.hello?.channels?.map((c) => c.name) ?? [] }, null, 2));
        });
        cmd.command("disconnect").description("Remove the agent key from config").action(async () => {
          const runtime = getRuntime(); const cfg = runtime.config.loadConfig();
          const channels = { ...((cfg as any).channels ?? {}) } as Record<string, any>;
          if (channels.asar) { delete channels.asar.key; channels.asar.enabled = false; }
          await runtime.config.writeConfigFile({ ...cfg, channels });
          console.log("Asar: ключ удалён, канал выключен.");
        });
      },
      { descriptors: [{ name: "asar", description: "Asar workspace (connect, status, disconnect)", hasSubcommands: true }] },
    );
  },
};

export default plugin;
