import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord, readNumber, readString, type RealtimeCredentials } from "./types.js";

const NIM_APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";
const ENTER_TIMEOUT_MS = 15_000;
const BOOTSTRAP_TIMEOUT_MS = 75_000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_CHAT_TEXT_LENGTH = 500;
const MAX_JSON_STRING_BYTES = 65_536;

type RealtimePlayStatus = "PLAY" | "PAUSE" | "UNKNOWN";

export type RealtimePlaybackEvent = {
  type: "playback";
  serverSeq: number | null;
  commandType: string | null;
  songId: string | null;
  formerSongId: string | null;
  progressMs: number;
  playStatus: RealtimePlayStatus;
  receivedAtMs: number;
  clientSeq?: number;
  senderId?: string;
};

export type RealtimeChatRoomMessage = {
  type: "chatroom_message";
  category: "text" | "custom" | "robot" | "notification" | "other";
  msgType: number | null;
  senderId: string | null;
  senderNick: string | null;
  text: string | null;
  messageId: string | null;
  timetagMs: number | null;
  receivedAtMs: number;
};

export type RealtimeTransportStatus = {
  enabled: boolean;
  connected: boolean;
  roomId: string | null;
  chatRoomId: string | null;
  credentialsReady: boolean;
  lastPlaybackEvent: RealtimePlaybackEvent | null;
  lastChatMessage: RealtimeChatRoomMessage | null;
  lastError: string | null;
};

export type RealtimeChatSendResult = {
  ok: true;
  roomId: string;
  chatRoomId: string;
  messageId: string;
  text: string;
  code: number;
};

export type RealtimeMemberProfile = {
  userId?: string;
  nick?: string;
  avatar?: string;
  gender?: number;
};

type ConnectOptions = {
  roomId: string;
  chatRoomId: string;
  credentials: RealtimeCredentials;
  memberProfile?: RealtimeMemberProfile;
};

type EventHandler = (...args: unknown[]) => void;

type ChatRoomLike = {
  init(appInstallDir: string, extension: string): boolean;
  initEventHandlers(): void;
  enter(roomId: number, requestLoginData: string, info: Record<string, unknown>, extension: string): boolean;
  exit(roomId: number, extension: string): void;
  sendMsg(roomId: number, msg: Record<string, unknown>, extension: string): boolean;
  updateMyRoomRoleAsync(
    roomId: number,
    info: Record<string, unknown>,
    needNotify: boolean,
    notifyExt: string,
    cb: null,
    extension: string,
  ): Promise<[number, number]>;
  getMemberInfoByIDsAsync(
    roomId: number,
    ids: string[],
    cb: null,
    extension: string,
  ): Promise<[number, number, Array<Record<string, unknown>>]>;
  on(event: string, handler: EventHandler): unknown;
};

type NimClientLike = {
  init(appKey: string, appDataDir: string, appInstallDir: string, config: Record<string, unknown>): boolean;
  initEventHandlers(): void;
  login(appKey: string, account: string, password: string, cb: null, extension: string): Promise<[unknown]>;
  cleanup(jsonExtension: string): void;
};

type NimPluginLike = {
  initEventHandlers(): void;
  chatRoomRequestEnterAsync(roomId: number, cb: null, extension: string): Promise<[number, string]>;
};

type V2LoginServiceLike = {
  on(event: string, handler: EventHandler): unknown;
  login(accountId: string, token: string, option: Record<string, unknown>): Promise<void>;
  logout(): Promise<void>;
  getLoginUser(): string;
  getLoginStatus(): number;
  getConnectStatus(): number;
  getChatroomLinkAddress(roomId: string): Promise<string[]>;
};

type V2StatisticsServiceLike = {
  on(event: string, handler: EventHandler): unknown;
};

type V2NIMClientLike = {
  init(option: Record<string, unknown>): unknown;
  getLoginService(): V2LoginServiceLike | null;
  getStatisticsService(): V2StatisticsServiceLike | null;
};

type V2ChatroomServiceLike = {
  on(event: string, handler: EventHandler): unknown;
  sendMessage(message: Record<string, unknown>, params: Record<string, unknown>): Promise<unknown>;
  updateSelfMemberInfo(
    params: Record<string, unknown>,
    antispamConfig: Record<string, unknown>,
  ): Promise<void>;
};

type V2ChatroomClientLike = {
  on(event: string, handler: EventHandler): unknown;
  enter(roomId: string, params: Record<string, unknown>): Promise<unknown>;
  exit(): void;
  getInstanceId(): number;
  getChatroomService(): V2ChatroomServiceLike;
};

type V2NIMChatroomClientStatic = {
  init(option: Record<string, unknown>): unknown;
  newInstance(): V2ChatroomClientLike;
};

type V2NIMChatroomMessageCreatorStatic = {
  createTextMessage(text: string): Record<string, unknown> | null;
};

type NodeNimModule = {
  V2NIMClient: new () => V2NIMClientLike;
  V2NIMChatroomClient: V2NIMChatroomClientStatic;
  V2NIMChatroomMessageCreator: V2NIMChatroomMessageCreatorStatic;
};

type PendingEnter = {
  generation: number;
  roomNumber: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingSend = {
  roomNumber: number;
  roomId: string;
  chatRoomId: string;
  text: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: RealtimeChatSendResult) => void;
  reject: (error: Error) => void;
};

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_JSON_STRING_BYTES) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeStatus(value: unknown): RealtimePlayStatus {
  const status = readString(value)?.toUpperCase();
  return status === "PLAY" || status === "PAUSE" ? status : "UNKNOWN";
}

function extractPlaybackCommand(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 7) return null;
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = extractPlaybackCommand(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;
  const hasCommandFields =
    object.commandType !== undefined
    || object.playStatus !== undefined
    || object.targetSongId !== undefined
    || object.progress !== undefined;
  if (hasCommandFields) return object;

  for (const key of ["command", "commandInfo", "config", "content", "data", "msg_attach_", "msg_body_", "ext_"]) {
    if (object[key] === undefined) continue;
    const found = extractPlaybackCommand(object[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function findPlaybackEnvelope(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 7) return null;
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findPlaybackEnvelope(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = asRecord(parsed);
  if (!Object.keys(object).length) return null;
  const eventType = readNumber(object.event_type) ?? readNumber(object.type);
  if (eventType === 20_000) return object;

  for (const nested of Object.values(object)) {
    const found = findPlaybackEnvelope(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

const PLAYBACK_DIAGNOSTIC_KEYS = new Set([
  "event_type",
  "type",
  "commandType",
  "command",
  "commandInfo",
  "config",
  "content",
  "data",
  "targetSongId",
  "formerSongId",
  "songId",
  "progress",
  "playStatus",
  "serverSeq",
  "clientSeq",
  "commandId",
  "roomId",
  "bizType",
  "ltType",
  "appName",
  "clientExt",
]);

function sanitizePlaybackDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max-depth]";
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) {
    return parsed.slice(0, 16).map((item) => sanitizePlaybackDiagnostic(item, depth + 1));
  }
  if (!parsed || typeof parsed !== "object") return parsed;

  const object = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(object)) {
    if (PLAYBACK_DIAGNOSTIC_KEYS.has(key)) {
      result[key] = sanitizePlaybackDiagnostic(nested, depth + 1);
    }
  }
  return result;
}

export function buildPlaybackDiagnostic(raw: unknown): Record<string, unknown> | null {
  const message = asRecord(raw);
  const envelope = findPlaybackEnvelope(raw);
  if (!envelope) return null;

  const setting = asRecord(message.msg_setting_);
  const senderId = readString(message.from_id_);
  const messageId = readString(message.client_msg_id_);
  return {
    msgType: readNumber(message.msg_type_),
    subType: readNumber(message.sub_type_),
    senderSuffix: senderId ? senderId.slice(-4) : null,
    messageIdSuffix: messageId ? messageId.slice(-6) : null,
    attach: sanitizePlaybackDiagnostic(message.msg_attach_),
    settingExt: sanitizePlaybackDiagnostic(setting.ext_),
    envelope: sanitizePlaybackDiagnostic(envelope),
  };
}

export function decodeRealtimePlaybackEvent(
  raw: unknown,
  receivedAtMs = Date.now(),
): RealtimePlaybackEvent | null {
  const envelope = findPlaybackEnvelope(raw);
  if (!envelope) return null;
  const command = extractPlaybackCommand(envelope);
  if (!command) return null;

  const progress = readNumber(command.progress);
  const serverSeq = readNumber(command.serverSeq) ?? readNumber(envelope.serverSeq);
  const clientSeq = readNumber(command.clientSeq);
  const rawMessage = asRecord(raw);
  const senderId = readString(rawMessage.from_id_) ?? readString(rawMessage.senderId);
  return {
    type: "playback",
    serverSeq,
    commandType: readString(command.commandType)?.toUpperCase() ?? null,
    songId: readString(command.targetSongId),
    formerSongId: readString(command.formerSongId),
    progressMs: Math.max(0, progress ?? 0),
    playStatus: normalizeStatus(command.playStatus),
    receivedAtMs,
    ...(clientSeq === null ? {} : { clientSeq }),
    ...(senderId ? { senderId } : {}),
  };
}

function extractChatText(value: unknown): string | null {
  const direct = readString(value);
  if (!direct) return null;
  const parsed = parseJsonString(direct);
  if (typeof parsed === "string") return direct;
  const object = asRecord(parsed);
  return readString(object.text)
    ?? readString(object.content)
    ?? readString(object.body)
    ?? readString(object.msg);
}

function chatMessageCategory(msgType: number | null): RealtimeChatRoomMessage["category"] {
  if (msgType === 0) return "text";
  if (msgType === 5) return "notification";
  if (msgType === 11) return "robot";
  if (msgType === 100) return "custom";
  return "other";
}

export function buildRealtimeChatTextMessage(
  text: string,
  roomId: string,
  messageId: string = randomUUID(),
  senderProfile?: RealtimeMemberProfile,
): Record<string, unknown> {
  const normalized = text.trim();
  if (!normalized) throw new Error("ChatRoom message cannot be empty");
  if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
    throw new Error(`ChatRoom message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`);
  }
  const numericUserId = senderProfile?.userId && /^\d+$/.test(senderProfile.userId)
    ? Number(senderProfile.userId)
    : null;
  const senderNick = senderProfile?.nick?.trim();
  const senderAvatar = senderProfile?.avatar?.trim();
  const serverExt = numericUserId !== null && senderNick && senderAvatar
    ? {
        userId: numericUserId,
        nickname: senderNick,
        avatarUrl: senderAvatar,
        msgId: Number(BigInt(`0x${messageId.replaceAll("-", "").slice(0, 12)}`) % 90_000_000_000n + 10_000_000_000n),
        ...(typeof senderProfile?.gender === "number" ? { gender: senderProfile.gender } : {}),
      }
    : undefined;
  const ext = JSON.stringify({
    ...(serverExt ? { serverExt } : {}),
    appName: "music",
    clientExt: {
      bizType: "listenTogether",
      ltType: "FRIEND",
      roomId,
      clientMsgId: messageId,
    },
  });
  return {
    msg_type_: 0,
    msg_attach_: normalized,
    msg_body_: "",
    client_msg_id_: messageId,
    sub_type_: 0,
    msg_setting_: {
      ext_: ext,
      anti_spam_enable_: false,
      history_save_: true,
      anti_spam_using_yidun_: 1,
      route_enabled_: true,
    },
  };
}

export function decodeRealtimeChatRoomMessage(
  raw: unknown,
  receivedAtMs = Date.now(),
): RealtimeChatRoomMessage | null {
  const message = asRecord(raw);
  if (!Object.keys(message).length) return null;
  const msgType = readNumber(message.msg_type_) ?? readNumber(message.messageType);
  const userInfo = asRecord(message.userInfoConfig);
  const attachment = asRecord(message.attachment);
  return {
    type: "chatroom_message",
    category: chatMessageCategory(msgType),
    msgType,
    senderId: readString(message.from_id_) ?? readString(message.senderId),
    senderNick: readString(message.from_nick_) ?? readString(userInfo.senderNick),
    text: extractChatText(message.msg_body_)
      ?? extractChatText(message.msg_attach_)
      ?? extractChatText(message.text)
      ?? extractChatText(attachment.raw),
    messageId: readString(message.client_msg_id_) ?? readString(message.messageClientId),
    timetagMs: readNumber(message.timetag_) ?? readNumber(message.createTime),
    receivedAtMs,
  };
}

export function buildRealtimeChatRoomEnterInfo(
  profile?: RealtimeMemberProfile,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const nick = profile?.nick?.trim();
  const avatar = profile?.avatar?.trim();
  if (nick) values.nick = nick;
  if (avatar) values.avatar = avatar;
  return { values_: values };
}

function numericChatRoomId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Unsupported NIM chatRoomId: ${value}`);
  }
  return parsed;
}

async function loadNodeNim(): Promise<NodeNimModule> {
  const imported = await import("node-nim");
  const candidate = (imported as { default?: unknown }).default ?? imported;
  const module = candidate as Partial<NodeNimModule>;
  if (
    typeof module.V2NIMClient !== "function"
    || typeof module.V2NIMChatroomClient?.init !== "function"
    || typeof module.V2NIMChatroomClient?.newInstance !== "function"
    || typeof module.V2NIMChatroomMessageCreator?.createTextMessage !== "function"
  ) {
    throw new Error("node-nim V2 IM/ChatRoom exports are unavailable");
  }
  return module as NodeNimModule;
}

function nimErrorCode(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  const record = asRecord(value);
  return readNumber(record.code) ?? readNumber(record.errorCode);
}

export class NeteaseRealtimeTransport {
  private runtimeReady = false;
  private nim: NodeNimModule | null = null;
  private v2Client: V2NIMClientLike | null = null;
  private loginService: V2LoginServiceLike | null = null;
  private chatroom: V2ChatroomClientLike | null = null;
  private chatroomService: V2ChatroomServiceLike | null = null;
  private connecting: Promise<void> | null = null;
  private activeAccountId: string | null = null;
  private activeMemberProfile: RealtimeMemberProfile | null = null;
  private status: RealtimeTransportStatus;

  constructor(
    private readonly enabled = true,
    private readonly onChatMessage?: (message: RealtimeChatRoomMessage) => void,
    private readonly onPlaybackEvent?: (event: RealtimePlaybackEvent) => void,
  ) {
    this.status = {
      enabled,
      connected: false,
      roomId: null,
      chatRoomId: null,
      credentialsReady: false,
      lastPlaybackEvent: null,
      lastChatMessage: null,
      lastError: null,
    };
  }

  getStatus(): RealtimeTransportStatus {
    return {
      ...this.status,
      lastPlaybackEvent: this.status.lastPlaybackEvent
        ? { ...this.status.lastPlaybackEvent }
        : null,
      lastChatMessage: this.status.lastChatMessage
        ? { ...this.status.lastChatMessage }
        : null,
    };
  }

  async connect(options: ConnectOptions): Promise<void> {
    if (!this.enabled) return;
    if (
      this.status.connected
      && this.status.roomId === options.roomId
      && this.status.chatRoomId === options.chatRoomId
    ) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectInternal(options)
      .catch((error) => {
        this.recordConnectionError(error);
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async ensureRuntime(): Promise<void> {
    if (this.runtimeReady) return;

    const nim = await loadNodeNim();
    const dataRoot = join(tmpdir(), "cove-nim-v2-runtime");
    await mkdir(dataRoot, { recursive: true });

    const client = new nim.V2NIMClient();
    const clientInit = client.init({
      appkey: NIM_APP_KEY,
      appDataPath: join(dataRoot, "im"),
      basicOption: {
        useHttps: true,
        useHttpdns: true,
        sdkLogLevel: 2,
      },
      linkOption: {
        linkTimeout: 6_000,
        protocolTimeout: 8_000,
      },
      databaseOption: {
        encryptionKey: NIM_APP_KEY,
      },
    });
    const clientInitCode = nimErrorCode(clientInit);
    if (clientInitCode !== 0) {
      throw new Error(`NIM V2 client initialization failed code=${String(clientInitCode)}`);
    }

    const loginService = client.getLoginService();
    if (!loginService) throw new Error("NIM V2 login service is unavailable");

    loginService.on("disconnected", (...args: unknown[]) => {
      this.status.connected = false;
      const error = asRecord(args[0]);
      const code = readNumber(error.code);
      this.status.lastError = code === null
        ? "NIM V2 IM disconnected"
        : `NIM V2 IM disconnected code=${code}`;
      console.warn(this.status.lastError);
    });
    loginService.on("connectFailed", (...args: unknown[]) => {
      const error = asRecord(args[0]);
      const code = readNumber(error.code);
      this.status.lastError = code === null
        ? "NIM V2 IM connect failed"
        : `NIM V2 IM connect failed code=${code}`;
      console.warn(this.status.lastError);
    });

    this.nim = nim;
    this.v2Client = client;
    this.loginService = loginService;
    this.runtimeReady = true;
    console.log("NetEase NIM V2 IM runtime initialized");
  }

  private async ensureChatroomRuntime(): Promise<void> {
    if (this.chatroom && this.chatroomService) return;
    const nim = this.nim;
    if (!nim) throw new Error("NIM V2 module is unavailable");

    const dataRoot = join(tmpdir(), "cove-nim-v2-runtime");
    await mkdir(dataRoot, { recursive: true });
    const chatroomInit = nim.V2NIMChatroomClient.init({
      appkey: NIM_APP_KEY,
      appDataPath: join(dataRoot, "chatroom"),
      basicOption: {
        useHttps: true,
        useHttpdns: true,
        sdkLogLevel: 2,
      },
      linkOption: {
        linkTimeout: 5_000,
        protocolTimeout: 5_000,
      },
      databaseOption: {
        encryptionKey: NIM_APP_KEY,
      },
    });
    const chatroomInitCode = nimErrorCode(chatroomInit);
    if (chatroomInitCode !== 0) {
      throw new Error(`NIM V2 ChatRoom initialization failed code=${String(chatroomInitCode)}`);
    }

    const chatroom = nim.V2NIMChatroomClient.newInstance();
    const chatroomService = chatroom.getChatroomService();

    chatroom.on("chatroomExited", (...args: unknown[]) => {
      this.status.connected = false;
      const error = asRecord(args[0]);
      const code = readNumber(error.code);
      this.status.lastError = code === null
        ? "NIM V2 ChatRoom exited"
        : `NIM V2 ChatRoom exited code=${code}`;
      console.warn(this.status.lastError);
    });
    chatroom.on("chatroomKicked", (...args: unknown[]) => {
      this.status.connected = false;
      this.status.lastError = "NIM V2 ChatRoom kicked";
      console.warn(this.status.lastError, args[0]);
    });
    chatroom.on("chatroomStatus", (...args: unknown[]) => {
      const state = readNumber(args[0]);
      if (state === 5 && this.status.chatRoomId) {
        this.status.connected = true;
        this.status.lastError = null;
      }
    });

    chatroomService.on("receiveMessages", (...args: unknown[]) => {
      const messages = Array.isArray(args[0]) ? args[0] : [];
      for (const raw of messages) {
        this.handleIncomingMessage(raw);
      }
    });

    this.chatroom = chatroom;
    this.chatroomService = chatroomService;
    console.log("NetEase NIM V2 ChatRoom runtime initialized after IM login");
  }

  private handleIncomingMessage(raw: unknown): void {
    const receivedAtMs = Date.now();
    const playback = decodeRealtimePlaybackEvent(raw, receivedAtMs);
    if (playback) {
      this.status.lastPlaybackEvent = playback;
      console.log(
        `NetEase realtime playback event: command=${playback.commandType ?? "UNKNOWN"} songId=${playback.songId ?? "unknown"} progressMs=${playback.progressMs} serverSeq=${playback.serverSeq ?? "unknown"} latencyAnchor=receivedAt`,
      );
      try {
        this.onPlaybackEvent?.(playback);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        console.error(`NetEase realtime playback sink failed: ${detail}`);
      }
    }

    const message = decodeRealtimeChatRoomMessage(raw, receivedAtMs);
    if (!message) return;
    this.status.lastChatMessage = message;
    const sender = message.senderId ? `***${message.senderId.slice(-4)}` : "unknown";
    const messageId = message.messageId ? `***${message.messageId.slice(-6)}` : "unknown";
    const textPreview = message.category === "text" && message.text
      ? message.text.replace(/[\r\n\t]+/g, " ").slice(0, 80)
      : null;
    console.log(
      `NetEase ChatRoom message received: category=${message.category} msgType=${message.msgType ?? "unknown"} sender=${sender} textLength=${message.text?.length ?? 0} textPreview=${textPreview === null ? "n/a" : JSON.stringify(textPreview)} messageId=${messageId}`,
    );
    try {
      this.onChatMessage?.(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`NetEase ChatRoom message sink failed: ${detail}`);
    }
  }

  private async ensureLoggedIn(credentials: RealtimeCredentials): Promise<void> {
    const login = this.loginService;
    if (!login) throw new Error("NIM V2 login service is unavailable");

    const alreadyLoggedIn =
      login.getLoginStatus() === 1
      && login.getConnectStatus() === 1
      && login.getLoginUser() === credentials.accId;
    if (alreadyLoggedIn) {
      this.activeAccountId = credentials.accId;
      return;
    }

    if (login.getLoginStatus() === 1 && login.getLoginUser() !== credentials.accId) {
      await login.logout().catch(() => {});
    }

    await login.login(credentials.accId, credentials.token, {
      retryCount: 3,
      timeout: 20_000,
    });
    if (login.getLoginStatus() !== 1 || login.getConnectStatus() !== 1) {
      throw new Error(
        `NIM V2 login did not reach connected state login=${login.getLoginStatus()} connect=${login.getConnectStatus()}`,
      );
    }
    this.activeAccountId = credentials.accId;
    console.log("NetEase NIM V2 IM login succeeded");
  }

  private async connectInternal(options: ConnectOptions): Promise<void> {
    const previousChatRoomId = this.status.chatRoomId;
    this.status = {
      enabled: this.enabled,
      connected: false,
      roomId: options.roomId,
      chatRoomId: options.chatRoomId,
      credentialsReady: true,
      lastPlaybackEvent: this.status.lastPlaybackEvent,
      lastChatMessage: this.status.lastChatMessage,
      lastError: null,
    };

    await this.ensureRuntime();
    await this.ensureLoggedIn(options.credentials);
    await this.ensureChatroomRuntime();

    const login = this.loginService;
    const chatroom = this.chatroom;
    const chatroomService = this.chatroomService;
    if (!login || !chatroom || !chatroomService) {
      throw new Error("NIM V2 realtime runtime is unavailable");
    }

    if (previousChatRoomId && previousChatRoomId !== options.chatRoomId) {
      try {
        chatroom.exit();
      } catch {
        // Best effort before entering a different room.
      }
    }

    const links = await login.getChatroomLinkAddress(options.chatRoomId);
    if (!links.length) throw new Error("NIM V2 ChatRoom link lookup returned no addresses");

    const profile = options.memberProfile;
    const result = await chatroom.enter(options.chatRoomId, {
      accountId: options.credentials.accId,
      token: options.credentials.token,
      timeout: ENTER_TIMEOUT_MS,
      __linkProvider: links,
      ...(profile?.nick ? { roomNick: profile.nick.trim() } : {}),
      ...(profile?.avatar ? { roomAvatar: profile.avatar.trim() } : {}),
    });
    const resultRecord = asRecord(result);
    const room = asRecord(resultRecord.chatroom);
    const enteredRoom = readString(room.roomId);
    if (enteredRoom && enteredRoom !== options.chatRoomId) {
      throw new Error(`NIM V2 entered unexpected ChatRoom ${enteredRoom}`);
    }

    if (profile?.nick || profile?.avatar) {
      await chatroomService.updateSelfMemberInfo(
        {
          ...(profile.nick ? { roomNick: profile.nick.trim() } : {}),
          ...(profile.avatar ? { roomAvatar: profile.avatar.trim() } : {}),
          notificationEnabled: false,
          persistence: false,
        },
        {},
      );
    }

    this.activeMemberProfile = profile ?? null;
    this.status.connected = true;
    this.status.lastError = null;
    console.log(
      `NetEase NIM V2 ChatRoom connected: chatRoomId=${options.chatRoomId} links=${links.length}`,
    );
  }

  async sendChatRoomText(text: string): Promise<RealtimeChatSendResult> {
    if (!this.enabled) throw new Error("NetEase realtime transport is disabled");
    const roomId = this.status.roomId;
    const chatRoomId = this.status.chatRoomId;
    const service = this.chatroomService;
    const nim = this.nim;
    if (!this.status.connected || !service || !nim || !roomId || !chatRoomId) {
      throw new Error("Not connected to a NetEase ChatRoom");
    }

    const normalized = text.trim();
    if (!normalized) throw new Error("ChatRoom message cannot be empty");
    if (normalized.length > MAX_CHAT_TEXT_LENGTH) {
      throw new Error(`ChatRoom message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`);
    }

    const message = nim.V2NIMChatroomMessageCreator.createTextMessage(normalized);
    if (!message) throw new Error("NIM V2 failed to create ChatRoom text message");

    const result = asRecord(await service.sendMessage(message, {
      messageConfig: {
        historyEnabled: true,
        highPriority: false,
      },
      routeConfig: {
        routeEnabled: true,
      },
      clientAntispamEnabled: false,
    }));
    const sent = asRecord(result.message);
    const messageId =
      readString(sent.messageClientId)
      ?? readString(message.messageClientId)
      ?? randomUUID();

    console.log(
      `NetEase ChatRoom message sent via V2: messageId=***${messageId.slice(-6)} textLength=${normalized.length}`,
    );
    return {
      ok: true,
      roomId,
      chatRoomId,
      messageId,
      text: normalized,
      code: 200,
    };
  }

  async disconnect(): Promise<void> {
    this.status.connected = false;
    this.status.roomId = null;
    this.status.chatRoomId = null;
    this.status.credentialsReady = false;
    this.activeMemberProfile = null;

    if (this.chatroom) {
      try {
        this.chatroom.exit();
      } catch {
        // Best effort. Keep the V2 IM session alive for fast re-entry.
      }
    }
  }

  recordConnectionError(error: unknown): void {
    this.status.connected = false;
    this.status.lastError = error instanceof Error ? error.message : "NIM V2 realtime connect failed";
  }
}

