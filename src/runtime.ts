// Runtime handle from OpenClaw (set in register), used by channel.ts for handleInboundMessage.
let rt: any = null;
export const setRuntime = (r: any) => { rt = r; };
export const getRuntime = () => { if (!rt) throw new Error("asar: runtime not set"); return rt; };
