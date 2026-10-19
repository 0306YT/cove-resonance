import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as enhancedApiImport from "@neteasecloudmusicapienhanced/api";
import * as legacyApiImport from "NeteaseCloudMusicApi";
import { z } from "zod";
import { NeteaseClient } from "./client.js";

type AnyRecord = Record<string, any>;
type ApiFn = (params: Record<string, unknown>) => Promise<any>;

const api = ((enhancedApiImport as any).default ?? enhancedApiImport) as Record<string, ApiFn>;
const legacyApi = ((legacyApiImport as any).default ?? legacyApiImport) as Record<string, ApiFn>;
const REAL_IP = "116.25.146.177";

function bodyOf(value: any): AnyRecord {
  const body = value?.body ?? value;
  return body && typeof body === "object" ? body as AnyRecord : {};
}

function requireApi(name: string): ApiFn {
  const fn = api[name];
  if (typeof fn !== "function") throw new Error(`NetEase API function unavailable: ${name}`);
  return fn;
}

function requireLegacyApi(name: string): ApiFn {
  const fn = legacyApi[name];
  if (typeof fn !== "function") throw new Error(`Legacy NetEase API function unavailable: ${name}`);
  return fn;
}

function parseEventMessage(event: AnyRecord): string | null {
  const raw = event?.json;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.msg === "string" ? parsed.msg : null;
    } catch {
      return null;
    }
  }
  return typeof raw?.msg === "string" ? raw.msg : null;
}

async function accountId(cookie: string): Promise<string> {
  const client = new NeteaseClient(cookie);
  return client.getAccountId();
}

async function ownEvents(cookie: string, uid: string): Promise<AnyRecord[]> {
  const result = bodyOf(await requireLegacyApi("user_event")({
    cookie,
    uid,
    limit: 30,
    lasttime: -1,
    realIP: REAL_IP,
  }));
  return Array.isArray(result?.events) ? result.events : [];
}

async function deleteEventBestEffort(cookie: string, eventId: string): Promise<void> {
  try {
    await requireLegacyApi("event_del")({ cookie, evId: eventId, realIP: REAL_IP });
  } catch {
    // Best effort cleanup only.
  }
}

export type PublishedNote = {
  eventId: string;
  privacySetting: number;
  text: string;
  eventTime: number | null;
};

export async function publishNeteaseNote(
  text: string,
  privacySetting: 0 | 1 | 2 | 6 = 6,
): Promise<PublishedNote> {
  const cookie = process.env.NETEASE_COOKIE?.trim() ?? "";
  if (!cookie) throw new Error("NETEASE_COOKIE is not configured");

  const cleanText = text.trim();
  if (!cleanText) throw new Error("Note text is empty");
  if ([...cleanText].length > 140) throw new Error("NetEase note text exceeds 140 characters");

  const uid = await accountId(cookie);
  const startedAt = Date.now();

  const posted = bodyOf(await requireLegacyApi("share_resource")({
    cookie,
    type: "noresource",
    msg: cleanText,
    id: "",
    realIP: REAL_IP,
  }));
  if (Number(posted?.code) !== 200) {
    throw new Error(`NetEase note publish failed: ${JSON.stringify(posted)}`);
  }

  let eventId = String(posted?.id ?? posted?.event?.id ?? posted?.eventId ?? "").trim();

  if (!eventId) {
    const events = await ownEvents(cookie, uid);
    const match = events.find((event) => {
      const time = Number(event?.eventTime ?? 0);
      return parseEventMessage(event) === cleanText && time >= startedAt - 60_000;
    });
    eventId = match ? String(match?.id ?? "").trim() : "";
  }

  if (!eventId) {
    throw new Error("NetEase accepted the note but did not return or expose an event id");
  }

  const privacy = bodyOf(await requireApi("event_privacy")({
    cookie,
    evId: eventId,
    privacy: privacySetting,
    realIP: REAL_IP,
  }));
  if (Number(privacy?.code) !== 200) {
    await deleteEventBestEffort(cookie, eventId);
    throw new Error(`NetEase privacy update failed and note was deleted: ${JSON.stringify(privacy)}`);
  }

  const events = await ownEvents(cookie, uid);
  const found = events.find((event) => String(event?.id ?? "") === eventId);

  if (!found) {
    await deleteEventBestEffort(cookie, eventId);
    throw new Error("Published note could not be read back; note was deleted");
  }

  const actualPrivacy = Number(found?.privacySetting);
  if (actualPrivacy !== privacySetting) {
    await deleteEventBestEffort(cookie, eventId);
    throw new Error(
      `Published note privacy could not be verified (expected ${privacySetting}, got ${String(found?.privacySetting)}); note was deleted`,
    );
  }

  return {
    eventId,
    privacySetting: actualPrivacy,
    text: parseEventMessage(found) ?? cleanText,
    eventTime: Number.isFinite(Number(found?.eventTime)) ? Number(found.eventTime) : null,
  };
}

export function registerNeteaseNoteTools(server: McpServer): void {
  server.registerTool(
    "netease_publish_note",
    {
      title: "Publish NetEase note",
      description:
        "Publish a real note/post from Cove's NetEase account and verify its visibility by reading it back. privacySetting: 0 everyone, 1 people Cove follows, 2 only Cove, 6 mutual follows only.",
      inputSchema: {
        text: z.string().trim().min(1).max(140),
        privacySetting: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(6)]).default(6),
      },
      outputSchema: {
        eventId: z.string(),
        privacySetting: z.number(),
        text: z.string(),
        eventTime: z.number().nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ text, privacySetting }) => {
      const result = await publishNeteaseNote(text, privacySetting);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}
