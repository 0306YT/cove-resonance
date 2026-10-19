import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const sdk = require("NeteaseCloudMusicApi") as Record<string, unknown>;

const ACCOUNT_OPERATIONS = [
  "search",
  "user_playlist",
  "playlist_track_all",
  "playlist_create",
  "playlist_tracks",
  "like",
  "user_record",
  "recommend_songs",
  "msg_private",
  "msg_private_history",
  "msg_recentcontact",
  "send_text",
  "pl_count",
  "get_userids",
  "user_event",
  "comment_event",
  "comment",
  "resource_like",
  "follow",
  "user_update",
] as const;

test("installed NeteaseCloudMusicApi exposes Cove account operations", () => {
  for (const operation of ACCOUNT_OPERATIONS) {
    assert.equal(typeof sdk[operation], "function", `${operation} should be available`);
  }
});
