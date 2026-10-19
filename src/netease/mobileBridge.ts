import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const require = createRequire(import.meta.url);
const neteaseCrypto = require("NeteaseCloudMusicApi/util/crypto.js") as {
  eapi: (url: string, object: Record<string, unknown>) => { params: string };
};

export type PhoneTask = {
  id: string;
  kind: "netease_publish_note";
  createdAt: string;
  text: string;
  privacySetting: 0 | 1 | 2 | 6;
  publishRequest: MobileHttpRequest;
  state: "pending" | "leased" | "completed" | "failed";
  result?: unknown;
};

export type MobileHttpRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

const tasks = new Map<string, PhoneTask>();
const pendingOrder: string[] = [];
const handoffs = new Map<string, { taskId: string; expiresAt: number }>();

function parseCookie(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function encodeForm(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function createHeader(cookieMap: Record<string, string>): Record<string, string> {
  const now = Date.now();
  return {
    osver: cookieMap.osver || "17.0",
    deviceId: cookieMap.deviceId || "",
    os: cookieMap.os || "iPhone OS",
    appver: cookieMap.appver || "9.0.90",
    versioncode: cookieMap.versioncode || "140",
    mobilename: cookieMap.mobilename || "iPhone",
    buildver: cookieMap.buildver || String(Math.floor(now / 1000)),
    resolution: cookieMap.resolution || "1179x2556",
    __csrf: cookieMap.__csrf || "",
    channel: cookieMap.channel || "distribution",
    requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    ...(cookieMap.MUSIC_U ? { MUSIC_U: cookieMap.MUSIC_U } : {}),
  };
}

function headerCookie(header: Record<string, string>): string {
  return Object.entries(header)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("; ");
}

function buildEapiRequest(
  apiPath: string,
  data: Record<string, unknown>,
  accountCookie: string,
): MobileHttpRequest {
  const cookieMap = parseCookie(accountCookie);
  const header = createHeader(cookieMap);
  const payload = { ...data, header, e_r: false };
  const encrypted = neteaseCrypto.eapi(apiPath, payload);
  return {
    url: `https://interface.music.163.com/eapi/${apiPath.slice(5)}`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "NeteaseMusic 9.0.90/5038 (iPhone; iOS 17.0; zh_CN)",
      "Cookie": headerCookie(header),
      "Accept": "application/json",
    },
    body: encodeForm(encrypted),
  };
}

export function buildMobilePublishRequest(text: string): MobileHttpRequest {
  const cookie = process.env.NETEASE_COOKIE?.trim() ?? "";
  if (!cookie) throw new Error("NETEASE_COOKIE is not configured");
  return buildEapiRequest(
    "/api/share/friends/resource",
    { type: "noresource", msg: text, id: "" },
    cookie,
  );
}

export function buildMobilePrivacyRequest(
  eventId: string,
  privacySetting: 0 | 1 | 2 | 6,
): MobileHttpRequest {
  const cookie = process.env.NETEASE_COOKIE?.trim() ?? "";
  if (!cookie) throw new Error("NETEASE_COOKIE is not configured");
  return buildEapiRequest(
    "/api/event/privacy/op",
    { eventId, privacy: privacySetting },
    cookie,
  );
}

export function enqueueMobileNote(
  text: string,
  privacySetting: 0 | 1 | 2 | 6,
): PhoneTask {
  const clean = text.trim();
  if (!clean) throw new Error("Note text is empty");
  const id = randomUUID();
  const task: PhoneTask = {
    id,
    kind: "netease_publish_note",
    createdAt: new Date().toISOString(),
    text: clean,
    privacySetting,
    publishRequest: buildMobilePublishRequest(clean),
    state: "pending",
  };
  tasks.set(id, task);
  pendingOrder.push(id);
  return task;
}

export function nextMobileTask(): PhoneTask | null {
  while (pendingOrder.length) {
    const id = pendingOrder[0];
    const task = tasks.get(id);
    if (!task || task.state === "completed" || task.state === "failed") {
      pendingOrder.shift();
      continue;
    }
    task.state = "leased";
    return task;
  }
  return null;
}

export function getMobileTask(id: string): PhoneTask | null {
  return tasks.get(id) ?? null;
}

export function createMobileHandoff(taskId: string, ttlMs = 15 * 60 * 1000): string {
  const task = tasks.get(taskId);
  if (!task) throw new Error("Unknown mobile task");
  if (task.state === "completed" || task.state === "failed") {
    throw new Error("Mobile task is already terminal");
  }
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  handoffs.set(token, { taskId, expiresAt: Date.now() + ttlMs });
  return token;
}

export function getHandoffTask(token: string): PhoneTask | null {
  const entry = handoffs.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    handoffs.delete(token);
    return null;
  }
  const task = tasks.get(entry.taskId);
  if (!task || task.state === "completed" || task.state === "failed") {
    handoffs.delete(token);
    return null;
  }
  return task;
}

export function finishMobileHandoff(token: string): void {
  handoffs.delete(token);
}

export function completeMobileTask(
  id: string,
  ok: boolean,
  result: unknown,
): PhoneTask {
  const task = tasks.get(id);
  if (!task) throw new Error("Unknown mobile task");
  task.state = ok ? "completed" : "failed";
  task.result = result;
  const index = pendingOrder.indexOf(id);
  if (index >= 0) pendingOrder.splice(index, 1);
  return task;
}

export const mobileResultSchema = z.object({
  taskId: z.string().min(1),
  ok: z.boolean(),
  eventId: z.string().optional(),
  publishStatus: z.number().optional(),
  publishBody: z.unknown().optional(),
  privacyStatus: z.number().optional(),
  privacyBody: z.unknown().optional(),
  error: z.string().optional(),
});
