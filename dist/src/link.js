// Asar Agent Link client — outbound WebSocket to Asar, reconnect, ping, ack.
// Protocol: https://github.com/skp-kz/asar/blob/main/docs/agent-link-protocol.md
// No inbound ports: the agent dials out, events flow both ways over the same socket.
const PING_MS = 30_000;
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
export class AsarLink {
    url;
    key;
    h;
    ws = null;
    closed = false;
    attempt = 0;
    pingTimer = null;
    pending = new Map();
    hello = null;
    constructor(url, key, h) {
        this.url = url;
        this.key = key;
        this.h = h;
    }
    start() { this.closed = false; this.connect(); }
    stop() { this.closed = true; this.clearPing(); try {
        this.ws?.close(1000, "stop");
    }
    catch { } this.ws = null; }
    get online() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
    wsUrl() { return this.url.replace(/^http/, "ws").replace(/\/+$/, "") + "/agent/v1/ws?key=" + encodeURIComponent(this.key); }
    connect() {
        if (this.closed)
            return;
        this.h.onState?.("connecting");
        let ws;
        try {
            ws = new WebSocket(this.wsUrl());
        }
        catch (e) {
            this.retry(String(e.message));
            return;
        }
        this.ws = ws;
        ws.onopen = () => { this.attempt = 0; this.h.onState?.("open"); this.startPing(); };
        ws.onmessage = (ev) => this.onFrame(String(ev.data));
        ws.onerror = () => { };
        ws.onclose = (ev) => { this.clearPing(); this.ws = null; this.failPending("closed"); this.h.onState?.("closed", `${ev.code} ${ev.reason}`); if (ev.code !== 4401)
            this.retry(`${ev.code} ${ev.reason}`);
        else
            this.h.log?.warn("asar: key revoked, not reconnecting"); };
    }
    retry(why) {
        if (this.closed)
            return;
        const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
        this.h.log?.debug?.(`asar: reconnect in ${wait}ms (${why})`);
        setTimeout(() => this.connect(), wait);
    }
    startPing() { this.clearPing(); this.pingTimer = setInterval(() => this.send({ type: "ping", t: Date.now() }), PING_MS); }
    clearPing() { if (this.pingTimer)
        clearInterval(this.pingTimer); this.pingTimer = null; }
    async onFrame(raw) {
        let m;
        try {
            m = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (m.type) {
            case "hello":
                this.hello = m;
                this.h.onHello?.(m);
                return;
            case "pong": return;
            case "posted":
            case "error": {
                const p = this.pending.get(String(m.ref || ""));
                if (p) {
                    this.pending.delete(String(m.ref));
                    clearTimeout(p.timer);
                    m.type === "error" ? p.reject(new Error(m.error)) : p.resolve(m);
                }
                return;
            }
            case "message": {
                try {
                    await this.h.onMessage(m);
                }
                catch (e) {
                    this.h.log?.warn(`asar: handler failed: ${e.message}`);
                }
                this.send({ type: "ack", cursor: m.cursor });
                return;
            }
            default: return;
        }
    }
    send(o) { if (this.online)
        this.ws.send(JSON.stringify(o)); }
    post(channel_id, text, parent_id) {
        if (!this.online)
            return Promise.reject(new Error("asar: offline"));
        const ref = Math.random().toString(36).slice(2);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(ref); reject(new Error("asar: post timeout")); }, 15_000);
            this.pending.set(ref, { resolve, reject, timer });
            this.send({ type: "post", ref, channel_id, text, parent_id: parent_id ?? null });
        });
    }
    status(state) { this.send({ type: "status", state }); }
    typing(channel_id) { this.send({ type: "typing", channel_id }); }
    failPending(why) { for (const [k, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("asar: " + why));
        this.pending.delete(k);
    } }
}
// Code → key (protocol §1). Used by setup / `openclaw asar connect`.
export async function claim(url, code, version) {
    const r = await fetch(url.replace(/\/+$/, "") + "/agent/v1/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), runtime: "openclaw", version }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(d.error === "bad_code" ? "Код не найден или истёк. Возьми новый в Asar → Агенты." : d.error || `HTTP ${r.status}`);
    return d;
}
