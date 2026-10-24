// Asar Agent Link client — outbound WebSocket to Asar, reconnect, ping, ack.
// Protocol: https://github.com/skp-kz/asar/blob/main/docs/agent-link-protocol.md
// No inbound ports: the agent dials out, events flow both ways over the same socket.

export type AsarMember = { id: string; name: string; kind: "human" | "agent" };
export type AsarChannel = { id: string; name: string; kind: "public" | "private" | "dm" };
export type AsarMessageEvent = {
  type: "message"; cursor: number; id: number;
  channel: AsarChannel; from: AsarMember; text: string; mentioned: boolean; parent_id: number | null; ts: string;
};
export type AsarHello = { type: "hello"; agent: { id: string; name: string; card: string | null }; channels: AsarChannel[]; cursor: number; acked: number };

export type LinkHandlers = {
  onHello?: (h: AsarHello) => void;
  onMessage: (e: AsarMessageEvent) => Promise<void> | void;
  onState?: (s: "connecting" | "open" | "closed", detail?: string) => void;
  log?: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void };
};

const PING_MS = 30_000;
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

export class AsarLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  hello: AsarHello | null = null;

  constructor(private url: string, private key: string, private h: LinkHandlers) {}

  start() { this.closed = false; this.connect(); }
  stop() { this.closed = true; this.clearPing(); try { this.ws?.close(1000, "stop"); } catch {} this.ws = null; }
  get online() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  private wsUrl() { return this.url.replace(/^http/, "ws").replace(/\/+$/, "") + "/agent/v1/ws?key=" + encodeURIComponent(this.key); }

  private connect() {
    if (this.closed) return;
    this.h.onState?.("connecting");
    let ws: WebSocket;
    try { ws = new WebSocket(this.wsUrl()); } catch (e) { this.retry(String((e as Error).message)); return; }
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.h.onState?.("open"); this.startPing(); };
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => { this.clearPing(); this.ws = null; this.failPending("closed"); this.h.onState?.("closed", `${ev.code} ${ev.reason}`); if (ev.code !== 4401) this.retry(`${ev.code} ${ev.reason}`); else this.h.log?.warn("asar: key revoked, not reconnecting"); };
  }
  private retry(why: string) {
    if (this.closed) return;
    const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
    this.h.log?.debug?.(`asar: reconnect in ${wait}ms (${why})`);
    setTimeout(() => this.connect(), wait);
  }
  private startPing() { this.clearPing(); this.pingTimer = setInterval(() => this.send({ type: "ping", t: Date.now() }), PING_MS); }
  private clearPing() { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }

  private async onFrame(raw: string) {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "hello": this.hello = m; this.h.onHello?.(m); return;
      case "pong": return;
      case "posted": case "error": { const p = this.pending.get(String(m.ref || "")); if (p) { this.pending.delete(String(m.ref)); clearTimeout(p.timer); m.type === "error" ? p.reject(new Error(m.error)) : p.resolve(m); } return; }
      case "message": {
        try { await this.h.onMessage(m); } catch (e) { this.h.log?.warn(`asar: handler failed: ${(e as Error).message}`); }
        this.send({ type: "ack", cursor: m.cursor });
        return;
      }
      default: return;
    }
  }

  send(o: unknown) { if (this.online) this.ws!.send(JSON.stringify(o)); }

  post(channel_id: string, text: string, parent_id?: number | null): Promise<{ id: number; ts: string }> {
    if (!this.online) return Promise.reject(new Error("asar: offline"));
    const ref = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new Error("asar: post timeout")); }, 15_000);
      this.pending.set(ref, { resolve, reject, timer });
      this.send({ type: "post", ref, channel_id, text, parent_id: parent_id ?? null });
    });
  }
  status(state: "on" | "working" | "waiting") { this.send({ type: "status", state }); }
  typing(channel_id: string) { this.send({ type: "typing", channel_id }); }
  private failPending(why: string) { for (const [k, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("asar: " + why)); this.pending.delete(k); } }
}

// Code → key (protocol §1). Used by setup / `openclaw asar connect`.
export async function claim(url: string, code: string, version: string): Promise<{ agent_id: string; name: string; key: string; ws: string }> {
  const r = await fetch(url.replace(/\/+$/, "") + "/agent/v1/claim", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), runtime: "openclaw", version }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error === "bad_code" ? "Код не найден или истёк. Возьми новый в Asar → Агенты." : d.error || `HTTP ${r.status}`);
  return d;
}
