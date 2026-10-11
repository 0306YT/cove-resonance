import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpServer } from "./mcp.js";
import { buildBridgeEvent } from "./bridge/events.js";
export { buildBridgeEvent } from "./bridge/events.js";
import { MCP_PATHS } from "./profiles.js";
import { listenerWakeHub } from "./listenerWake.js";
import { PlaybackStateStore } from "./netease/playbackState.js";
import { createTogetherWorker } from "./netease/togetherWorker.js";
import { InMemoryEventQueue } from "./queue.js";

const PORT = Number(process.env.PORT ?? 8787);
const INGEST_TOKEN = process.env.BRIDGE_INGEST_TOKEN ?? "";
const FANQIE_INGEST_TOKEN = process.env.FANQIE_INGEST_TOKEN?.trim() ?? "";
const UNIX_SOCKET = process.env.BRIDGE_UNIX_SOCKET?.trim() ?? "";
const queue = new InMemoryEventQueue();
const playbackState = new PlaybackStateStore();

function enqueueTogetherEvent(
  source: string,
  text: string,
  additionalModelContext?: string,
): boolean {
  const id = randomUUID();
  const created = queue.enqueue(buildBridgeEvent(
    id,
    source,
    text,
    new Date().toISOString(),
    additionalModelContext,
  ));
  if (created) listenerWakeHub.wake(source);
  return created;
}

const togetherWorker = createTogetherWorker(enqueueTogetherEvent, playbackState);

const eventInput = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(80).default("test"),
  text: z.string().trim().min(1).max(4000),
});

const fanqieInput = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(12000),
  context: z.string().trim().max(4000).optional(),
});

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function authorized(req: IncomingMessage): boolean {
  return !INGEST_TOKEN || req.headers.authorization === `Bearer ${INGEST_TOKEN}`;
}

function secretMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function fanqieAuthorized(req: IncomingMessage): boolean {
  if (!FANQIE_INGEST_TOKEN) return false;
  const authorization = req.headers.authorization ?? "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  return secretMatches(bearerToken, FANQIE_INGEST_TOKEN);
}

function mcpAuthorized(req: IncomingMessage, url: URL, accessToken: string): boolean {
  if (!accessToken) return true;
  const authorization = req.headers.authorization ?? "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const queryToken = url.searchParams.get("access_token")?.trim() ?? "";
  return secretMatches(bearerToken || queryToken, accessToken);
}

export function createHttpServer(options: { mcpAccessToken?: string } = {}) {
  const mcpAccessToken = options.mcpAccessToken
    ?? process.env.MCP_ACCESS_TOKEN?.trim()
    ?? "";

  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      res.writeHead(400).end("Bad Request");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      writeJson(res, 200, {
        ok: true,
        service: "cove-bridge",
        version: "0.1.0",
        queue: queue.status(),
        listener: listenerWakeHub.status(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/listener/events") {
      const authorization = req.headers.authorization ?? "";
      const bearerToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      const token = bearerToken || url.searchParams.get("session")?.trim() || "";
      const session = token ? listenerWakeHub.consumeSession(token) : null;
      if (!session) {
        writeJson(res, 401, { error: "invalid_or_expired_listener_session" });
        return;
      }
      listenerWakeHub.subscribe(res, session.expiresAtMs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/fanqie/events") {
      writeJson(res, 503, { error: "fanqie_listener_paused" });
      return;

      if (!fanqieAuthorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const parsed = fanqieInput.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, 400, { error: parsed.error.flatten() });
          return;
        }
        const createdAt = new Date().toISOString();
        const id = parsed.data.eventId ?? randomUUID();
        const text = "【番茄当前屏幕】\n" + parsed.data.text;
        const modelContext = [
          "FANQIE OCR STATE: this is the latest OCR-visible reading screen from the user's Fanqie app.",
          "This is screen state, not a message typed by the user.",
          parsed.data.context ?? "",
        ].filter(Boolean).join("\n");
        const event = buildBridgeEvent(id, "netease.fanqie", text, createdAt, modelContext);
        event.stream = "state";
        event.stateKey = "fanqie.current_page";
        delete event.replyRoute;
        delete event.replyPolicy;
        event.visibleText = text;
        event.modelContext = [
          "MESSAGE ORIGIN: Fanqie OCR state.",
          "This is the latest OCR-visible reading screen from the user's Fanqie app.",
          "This is NOT NetEase state and NOT a message typed by the user.",
          "Treat it only as the user's current reading context.",
          "source=netease.fanqie",
          "stream=state",
          "stateKey=fanqie.current_page",
          modelContext,
          "createdAt=" + createdAt,
        ].join("\n");
        const created = queue.enqueue(event);
        if (created) listenerWakeHub.wake("netease.fanqie");
        writeJson(res, created ? 201 : 200, { ok: true, created, eventId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        writeJson(res, message === "request_too_large" ? 413 : 400, { error: message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      if (!authorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const parsed = eventInput.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, 400, { error: parsed.error.flatten() });
          return;
        }
        const createdAt = new Date().toISOString();
        const id = parsed.data.eventId ?? randomUUID();
        const event = buildBridgeEvent(id, parsed.data.source, parsed.data.text, createdAt);
        const created = queue.enqueue(event);
        if (created) listenerWakeHub.wake(parsed.data.source);
        writeJson(res, created ? 201 : 200, { ok: true, created, eventId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        writeJson(res, message === "request_too_large" ? 413 : 400, { error: message });
      }
      return;
    }

    const mcpMethods = new Set(["POST", "GET", "DELETE"]);
    const mcpProfile = MCP_PATHS.get(url.pathname);
    if (mcpProfile && mcpMethods.has(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      if (!mcpAuthorized(req, url, mcpAccessToken)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const server = createMcpServer(queue, playbackState, togetherWorker, mcpProfile);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!res.headersSent) writeJson(res, 500, { error: "internal_server_error" });
      }
      return;
    }

    res.writeHead(404).end("Not Found");
  });
}

if (process.env.NODE_ENV !== "test") {
  createHttpServer().listen(PORT, "0.0.0.0", () => {
    console.log("Cove Resonance listening on http://0.0.0.0:" + PORT + " (MCP: /mcp, /mcp/music)");
    togetherWorker.start();
  });

  if (UNIX_SOCKET) {
    if (existsSync(UNIX_SOCKET)) unlinkSync(UNIX_SOCKET);
    createHttpServer().listen(UNIX_SOCKET, () => {
      chmodSync(UNIX_SOCKET, 0o666);
      console.log("Cove Resonance listening on unix://" + UNIX_SOCKET + " (MCP: /mcp, /mcp/music)");
    });
  }
}
