// Runtime handle from OpenClaw (set by the plugin entry), used by the CLI and gateway code.
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

let rt: PluginRuntime | null = null;
export const setRuntime = (r: PluginRuntime) => { rt = r; };
export const getRuntime = (): PluginRuntime => { if (!rt) throw new Error("asar: runtime not set"); return rt; };
export const hasRuntime = () => rt !== null;
