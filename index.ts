// @skp-kz/asar-openclaw — Asar channel for OpenClaw.
// Install:  openclaw plugins install npm:@skp-kz/asar-openclaw
// Connect:  openclaw asar connect ASAR-XXXX-XXXX   (code from Asar → Agents → + Agent → OpenClaw)
import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asarPlugin, getLink, resolveAsarAccount } from "./src/channel.js";
import { claim } from "./src/link.js";
import { getRuntime, setRuntime } from "./src/runtime.js";
import { ASAR_CHANNEL_ID, ASAR_DEFAULT_URL, readAsarSection } from "./src/types.js";

function registerAsarCli(api: OpenClawPluginApi) {
  setRuntime(api.runtime);
  api.registerCli(
    ({ program }) => {
      const cmd = program.command(ASAR_CHANNEL_ID).description("Asar workspace (connect, status, disconnect)");

      cmd
        .command("connect <code>")
        .description("Exchange an invite code for an agent key and save it to channels.asar")
        .option("--url <url>", "Asar host", ASAR_DEFAULT_URL)
        .action(async (code: string, opts: { url: string }) => {
          const runtime = getRuntime();
          const url = opts.url.replace(/\/+$/, "");
          const r = await claim(url, code, runtime.version);
          await runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft: OpenClawConfig) => {
              const asar = readAsarSection(draft);
              draft.channels = {
                ...draft.channels,
                [ASAR_CHANNEL_ID]: { ...asar, url, key: r.key, agentId: r.agent_id, agentName: r.name, enabled: true },
              };
            },
          });
          console.log(`Asar: подключён как ${r.name} (${r.agent_id}). Канал asar включён; шлюз подхватит конфиг сам.`);
        });

      cmd
        .command("status")
        .description("Link status")
        .action(() => {
          const cfg = getRuntime().config.current() as OpenClawConfig;
          const acc = resolveAsarAccount({ cfg });
          const link = getLink(acc.accountId);
          console.log(
            JSON.stringify(
              {
                configured: acc.configured,
                enabled: acc.enabled,
                url: acc.url,
                agentId: acc.agentId,
                wakeOn: acc.wakeOn,
                // `online` is only meaningful inside the gateway process; from the CLI it is always false.
                online: link?.online ?? false,
                channels: link?.hello?.channels?.map((c) => c.name) ?? [],
              },
              null,
              2,
            ),
          );
        });

      cmd
        .command("disconnect")
        .description("Remove the agent key from config and disable the channel")
        .action(async () => {
          await getRuntime().config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft: OpenClawConfig) => {
              const asar = { ...readAsarSection(draft) };
              delete asar.key;
              asar.enabled = false;
              draft.channels = { ...draft.channels, [ASAR_CHANNEL_ID]: asar };
            },
          });
          console.log("Asar: ключ удалён, канал выключен.");
        });
    },
    { descriptors: [{ name: ASAR_CHANNEL_ID, description: "Asar workspace (connect, status, disconnect)", hasSubcommands: true }] },
  );
}

const plugin = defineChannelPluginEntry({
  id: ASAR_CHANNEL_ID,
  name: "Asar",
  description: "Asar channel: people and AI agents in one workspace",
  plugin: asarPlugin,
  configSchema: asarPlugin.configSchema,
  setRuntime,
  registerCliMetadata: registerAsarCli,
});

export default plugin;
