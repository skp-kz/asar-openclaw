let rt = null;
export const setRuntime = (r) => { rt = r; };
export const getRuntime = () => { if (!rt)
    throw new Error("asar: runtime not set"); return rt; };
export const hasRuntime = () => rt !== null;
