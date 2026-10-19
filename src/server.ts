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
import { publishNeteaseNote } from "./netease/noteTools.js";
import {
  buildMobilePrivacyRequest,
  completeMobileTask,
  createMobileHandoff,
  enqueueMobileNote,
  finishMobileHandoff,
  getHandoffTask,
  getMobileTask,
  mobileResultSchema,
  nextMobileTask,
} from "./netease/mobileBridge.js";
import { InMemoryEventQueue } from "./queue.js";

const PORT = Number(process.env.PORT ?? 8787);
const INGEST_TOKEN = process.env.BRIDGE_INGEST_TOKEN ?? "";
const FANQIE_INGEST_TOKEN = process.env.FANQIE_INGEST_TOKEN?.trim() ?? "";
const OPS_TOKEN = process.env.COVE_OPS_TOKEN?.trim() ?? "";
const MOBILE_BRIDGE_TOKEN = process.env.COVE_MOBILE_BRIDGE_TOKEN?.trim() ?? "";
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

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function mobileScriptFor(handoffBase: string): string {
  return `const BASE=${JSON.stringify(handoffBase)};
async function g(path){const r=new Request(BASE+path);r.method="GET";r.timeoutInterval=30;const t=await r.loadString();if(r.response.statusCode<200||r.response.statusCode>=300)throw new Error(t);return JSON.parse(t)}
async function p(path,b){const r=new Request(BASE+path);r.method="POST";r.timeoutInterval=30;r.headers={"Content-Type":"application/json"};r.body=JSON.stringify(b);const t=await r.loadString();if(r.response.statusCode<200||r.response.statusCode>=300)throw new Error(t);return JSON.parse(t)}
async function h(s){const r=new Request(s.url);r.method=s.method||"POST";r.timeoutInterval=30;r.headers=s.headers||{};r.body=s.body||"";const t=await r.loadString();let j=null;try{j=JSON.parse(t)}catch{}return{status:r.response.statusCode,text:t,json:j}}
function id(b){return String(b?.id??b?.eventId??b?.event?.id??b?.event?.eventId??"").trim()}
async function n(title,body){const x=new Notification();x.title=title;x.body=body;await x.schedule()}
try{
 const q=await g("/next"); if(!q.task){await n("Cove Mobile Bridge","没有待执行任务。");Script.complete();return}
 const task=q.task; const a=await h(task.publishRequest); const ab=a.json;
 if(!ab||Number(ab.code)!==200){await p("/result",{taskId:task.id,ok:false,publishStatus:a.status,publishBody:ab??a.text,error:"publish_failed"});throw new Error("网易云发布失败："+(ab?.message??ab?.msg??a.text.slice(0,120)))}
 const eid=id(ab); if(!eid)throw new Error("发布返回成功，但没有拿到笔记 ID。")
 const pr=await p("/privacy-request",{taskId:task.id,eventId:eid,privacySetting:task.privacySetting});
 const b=await h(pr.request); const bb=b.json; const ok=!!bb&&Number(bb.code)===200;
 await p("/result",{taskId:task.id,ok,eventId:eid,publishStatus:a.status,publishBody:ab,privacyStatus:b.status,privacyBody:bb??b.text,error:ok?undefined:"privacy_failed"});
 if(!ok)throw new Error("笔记已发出，但仅互关可见设置失败："+(bb?.message??bb?.msg??b.text.slice(0,120)));
 await n("Cove Mobile Bridge","网易云笔记已从这台 iPhone 发出，并设置为仅互关可见。");
}catch(e){await n("Cove Mobile Bridge 失败",String(e?.message??e))}
Script.complete();`;
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

function opsAuthorized(url: URL): boolean {
  if (!OPS_TOKEN) return false;
  return secretMatches(url.searchParams.get("token")?.trim() ?? "", OPS_TOKEN);
}

function mobileBridgeAuthorized(url: URL): boolean {
  if (!MOBILE_BRIDGE_TOKEN) return false;
  return secretMatches(url.searchParams.get("token")?.trim() ?? "", MOBILE_BRIDGE_TOKEN);
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
    }

    if (req.method === "GET" && url.pathname === "/ops/netease/note/publish") {
      if (!opsAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const text = url.searchParams.get("text")?.trim() ?? "";
      const rawPrivacy = Number(url.searchParams.get("privacy") ?? "6");
      if (!text || ![0, 1, 2, 6].includes(rawPrivacy)) {
        writeJson(res, 400, { error: "text_required_and_privacy_must_be_0_1_2_or_6" });
        return;
      }
      try {
        const result = await publishNeteaseNote(text, rawPrivacy as 0 | 1 | 2 | 6);
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        const raw = error as { status?: unknown; body?: unknown };
        const message = error instanceof Error
          ? error.message
          : JSON.stringify({ status: raw?.status ?? null, body: raw?.body ?? null });
        console.error("NetEase note publish failed", message);
        writeJson(res, 200, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/ops/mobile/note/enqueue") {
      if (!opsAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const text = url.searchParams.get("text")?.trim() ?? "";
      const privacySetting = Number(url.searchParams.get("privacy") ?? "6");
      if (!text || ![0, 1, 2, 6].includes(privacySetting)) {
        writeJson(res, 400, { error: "text_required_and_privacy_must_be_0_1_2_or_6" });
        return;
      }
      try {
        const task = enqueueMobileNote(text, privacySetting as 0 | 1 | 2 | 6);
        writeJson(res, 200, {
          ok: true,
          taskId: task.id,
          state: task.state,
          privacySetting: task.privacySetting,
        });
      } catch (error) {
        writeJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : "enqueue_failed",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/ops/mobile/status") {
      if (!opsAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const id = url.searchParams.get("id")?.trim() ?? "";
      const task = getMobileTask(id);
      if (!task) {
        writeJson(res, 404, { error: "unknown_task" });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        task: {
          id: task.id,
          state: task.state,
          createdAt: task.createdAt,
          privacySetting: task.privacySetting,
          result: task.result ?? null,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ops/mobile/handoff") {
      if (!opsAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const id = url.searchParams.get("id")?.trim() ?? "";
      try {
        const handoff = createMobileHandoff(id);
        const origin = `https://${req.headers.host ?? "cove-resonance-production-d352.up.railway.app"}`;
        writeJson(res, 200, {
          ok: true,
          setupUrl: origin + "/mobile/setup?handoff=" + encodeURIComponent(handoff),
        });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "handoff_failed",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/mobile/setup") {
      const handoff = url.searchParams.get("handoff")?.trim() ?? "";
      const task = getHandoffTask(handoff);
      if (!task) {
        writeHtml(res, 410, "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:-apple-system;padding:24px'>这个一次性入口已失效，请回到 ChatGPT 让我重新生成。</body>");
        return;
      }
      const origin = `https://${req.headers.host ?? "cove-resonance-production-d352.up.railway.app"}`;
      const code = mobileScriptFor(origin + "/mobile/handoff?handoff=" + encodeURIComponent(handoff));
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      writeHtml(res, 200, `<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Cove Mobile Bridge</title><style>body{font-family:-apple-system,system-ui;padding:20px;background:#111;color:#fff}button{font:inherit;padding:12px 16px;border:0;border-radius:12px}textarea{width:100%;height:52vh;margin-top:14px;border-radius:12px;padding:12px;background:#1d1d1f;color:#fff;border:1px solid #444}</style><h2>Cove Mobile Bridge</h2><p>点“复制脚本”，然后在 Scriptable 新建脚本并粘贴运行一次。</p><button id=b>复制脚本</button><textarea id=t readonly>${escaped}</textarea><script>b.onclick=async()=>{await navigator.clipboard.writeText(t.value);b.textContent="已复制 ✓"}</script></html>`);
      return;
    }

    if (url.pathname.startsWith("/mobile/handoff")) {
      const handoff = url.searchParams.get("handoff")?.trim() ?? "";
      const task = getHandoffTask(handoff);
      if (!task) {
        writeJson(res, 410, { error: "expired_or_invalid_handoff" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/mobile/handoff/next") {
        writeJson(res, 200, {
          ok: true,
          task: {
            id: task.id,
            kind: task.kind,
            createdAt: task.createdAt,
            text: task.text,
            privacySetting: task.privacySetting,
            publishRequest: task.publishRequest,
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mobile/handoff/privacy-request") {
        try {
          const body = await readJson(req) as Record<string, unknown>;
          const taskId = String(body.taskId ?? "").trim();
          const eventId = String(body.eventId ?? "").trim();
          const privacySetting = Number(body.privacySetting ?? 6);
          if (taskId !== task.id || !eventId || ![0, 1, 2, 6].includes(privacySetting)) {
            writeJson(res, 400, { error: "invalid_task_event_or_privacy" });
            return;
          }
          writeJson(res, 200, {
            ok: true,
            request: buildMobilePrivacyRequest(eventId, privacySetting as 0 | 1 | 2 | 6),
          });
        } catch (error) {
          writeJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : "invalid_request",
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/mobile/handoff/result") {
        try {
          const parsed = mobileResultSchema.safeParse(await readJson(req));
          if (!parsed.success || parsed.data.taskId !== task.id) {
            writeJson(res, 400, { error: "invalid_result" });
            return;
          }
          const completed = completeMobileTask(parsed.data.taskId, parsed.data.ok, parsed.data);
          finishMobileHandoff(handoff);
          writeJson(res, 200, { ok: true, taskId: completed.id, state: completed.state });
        } catch (error) {
          writeJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : "invalid_request",
          });
        }
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/mobile/next") {
      if (!mobileBridgeAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const task = nextMobileTask();
      if (!task) {
        writeJson(res, 200, { ok: true, task: null });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        task: {
          id: task.id,
          kind: task.kind,
          createdAt: task.createdAt,
          text: task.text,
          privacySetting: task.privacySetting,
          publishRequest: task.publishRequest,
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/mobile/privacy-request") {
      if (!mobileBridgeAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const taskId = String(body.taskId ?? "").trim();
        const eventId = String(body.eventId ?? "").trim();
        const privacySetting = Number(body.privacySetting ?? 6);
        const task = getMobileTask(taskId);
        if (!task || !eventId || ![0, 1, 2, 6].includes(privacySetting)) {
          writeJson(res, 400, { error: "invalid_task_event_or_privacy" });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          request: buildMobilePrivacyRequest(eventId, privacySetting as 0 | 1 | 2 | 6),
        });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "invalid_request",
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/mobile/result") {
      if (!mobileBridgeAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const parsed = mobileResultSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, 400, { error: parsed.error.flatten() });
          return;
        }
        const task = completeMobileTask(parsed.data.taskId, parsed.data.ok, parsed.data);
        writeJson(res, 200, { ok: true, taskId: task.id, state: task.state });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "invalid_request",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/mobile/status") {
      if (!mobileBridgeAuthorized(url)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const id = url.searchParams.get("id")?.trim() ?? "";
      const task = getMobileTask(id);
      if (!task) {
        writeJson(res, 404, { error: "unknown_task" });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        task: {
          id: task.id,
          kind: task.kind,
          state: task.state,
          createdAt: task.createdAt,
          privacySetting: task.privacySetting,
          result: task.result ?? null,
        },
      });
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
