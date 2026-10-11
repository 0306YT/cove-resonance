import { mkdir } from "node:fs/promises";

type BootstrapRequest = {
  appKey: string;
  dataDir: string;
  accId: string;
  token: string;
  roomNumber: number;
};

type NimClientLike = {
  init(appKey: string, appDataDir: string, appInstallDir: string, config: Record<string, unknown>): boolean;
  initEventHandlers(): void;
  login(appKey: string, account: string, password: string, cb: ((result: unknown) => void) | null, extension: string): Promise<[unknown]>;
};

type NimPluginLike = {
  initEventHandlers(): void;
  chatRoomRequestEnterAsync(roomId: number, cb: null, extension: string): Promise<[number, string]>;
};
type V2ChatroomClientLike = {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  enter(roomId: string, params: Record<string, unknown>): Promise<unknown>;
  getInstanceId(): number;
};

type V2NIMChatroomClientStatic = {
  init(option: Record<string, unknown>): unknown;
  newInstance(): V2ChatroomClientLike;
};

type NodeNimModule = {
  NIMClient: new () => NimClientLike;
  NIMPlugin: new () => NimPluginLike;
  V2NIMChatroomClient?: V2NIMChatroomClientStatic;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeV2DirectChatroom(
  nim: Partial<NodeNimModule>,
  request: BootstrapRequest,
): Promise<void> {
  const v2 = nim.V2NIMChatroomClient;
  if (!v2) {
    console.error("V2 chatroom probe: export unavailable");
    return;
  }

  const initResult = v2.init({
    appkey: request.appKey,
    appDataPath: request.dataDir + "/v2/",
    basicOption: { useHttps: true },
    linkOption: { linkTimeout: 5_000, protocolTimeout: 5_000 },
  });
  const initRecord = asRecord(initResult);
  console.error(
    "V2 chatroom probe: init code="
    + String(readNumber(initRecord.code) ?? (initResult === null ? 0 : "unknown")),
  );

  const instance = v2.newInstance();
  instance.on("chatroomStatus", (...args: unknown[]) => {
    console.error("V2 chatroom probe: status=" + JSON.stringify(args).slice(0, 700));
  });
  instance.on("chatroomEntered", () => {
    console.error("V2 chatroom probe: entered-event");
  });
  instance.on("chatroomExited", (...args: unknown[]) => {
    console.error("V2 chatroom probe: exited=" + JSON.stringify(args).slice(0, 700));
  });

  try {
    const result = await withTimeout(
      instance.enter(String(request.roomNumber), {
        accountId: request.accId,
        token: request.token,
        timeout: 10_000,
      }),
      12_000,
      "V2 direct chatroom enter timed out",
    );
    const record = asRecord(result);
    const selfMember = asRecord(record.selfMember);
    console.error(
      "V2 chatroom probe: ENTER SUCCESS room="
      + String(asRecord(record.chatroom).roomId ?? request.roomNumber)
      + " self=" + String(selfMember.accountId ?? "present"),
    );
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : JSON.stringify(error).slice(0, 900);
    console.error("V2 chatroom probe: enter failed " + detail);
  }
}

async function run(request: BootstrapRequest): Promise<[number, string]> {
  await mkdir(request.dataDir, { recursive: true });
  const imported = await withTimeout(import("node-nim"), 5_000, "NIM module import timed out");
  const candidate = (imported as { default?: unknown }).default ?? imported;
  const nim = candidate as Partial<NodeNimModule>;
  if (typeof nim.NIMClient !== "function" || typeof nim.NIMPlugin !== "function") {
    throw new Error("node-nim NIMClient/NIMPlugin exports are unavailable");
  }

  const client = new nim.NIMClient();
  const plugin = new nim.NIMPlugin();
  const config = {
    database_encrypt_key_: request.appKey,
    use_https_: true,
    sdk_log_level_: 2,
  };

  if (!client.init(request.appKey, request.dataDir + "/", "", config)) {
    throw new Error("NIM bootstrap client initialization failed");
  }
  client.initEventHandlers();
  plugin.initEventHandlers();

  const [loginResult] = await withTimeout(
    client.login(
      request.appKey,
      request.accId,
      request.token,
      (result) => {
        const value = asRecord(result);
        console.error(
          "NIM login callback: code=" + String(readNumber(value.res_code_))
          + " step=" + String(readNumber(value.login_step_))
          + " retrying=" + String(value.retrying_ ?? ""),
        );
      },
      "",
    ),
    65_000,
    "NIM login timed out",
  );
  const loginCode = readNumber(asRecord(loginResult).res_code_);
  if (loginCode !== 200) {
    if (loginCode === 415) {
      await probeV2DirectChatroom(nim, request);
    }
    throw new Error("NIM login failed" + (loginCode === null ? "" : " code=" + loginCode));
  }

  return await withTimeout(
    plugin.chatRoomRequestEnterAsync(request.roomNumber, null, ""),
    12_000,
    "NIM chatroom ticket request timed out",
  );
}

let started = false;
process.on("message", (raw: unknown) => {
  if (started) return;
  started = true;
  void run(raw as BootstrapRequest)
    .then((result) => {
      process.send?.({ ok: true, result });
    })
    .catch((error) => {
      process.send?.({
        ok: false,
        error: error instanceof Error ? error.message : "unknown bootstrap error",
      });
    });
});

// Never perform node-nim cleanup in this process. The parent kills this
// short-lived process after it receives a result, so the OS tears down all
// native NIM threads even if the SDK cleanup path is unhealthy.
setInterval(() => {}, 60_000);
