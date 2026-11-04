/**
 * In-memory BingX for executor tests: the simulated exchange (sim-exchange.ts) behind a local
 * HTTP server. Test-only (never imported by the server).
 */
import http from "node:http";
import { createSimExchange, simText } from "./sim-exchange";

export function createFakeBingX(opts: { equity?: number; prices?: Record<string, number> } = {}) {
  const sim = createSimExchange(opts);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const params = Object.fromEntries(url.searchParams.entries());
    delete params.signature; delete params.timestamp; delete params.recvWindow;
    const out = sim.handle(req.method!, url.pathname, params);
    if (out === "DROP") { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(simText(out));
  });
  return {
    ...sim,
    async start(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, r));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
