import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NeteaseClient } from "./client.js";

export const neteaseSongSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string(),
  durationMs: z.number(),
  coverUrl: z.string().optional(),
  album: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    coverUrl: z.string().optional(),
  }).optional(),
  artists: z.array(z.object({
    id: z.string().nullable(),
    name: z.string(),
  })).optional(),
  aliases: z.array(z.string()).optional(),
  translatedNames: z.array(z.string()).optional(),
  mvId: z.string().nullable().optional(),
  fee: z.number().nullable().optional(),
  trackNumber: z.number().nullable().optional(),
  disc: z.string().nullable().optional(),
});

const playlistSchema = z.object({
  id: z.string(),
  name: z.string(),
  trackCount: z.number(),
  creatorId: z.string().nullable(),
  creatorName: z.string().nullable(),
  owned: z.boolean(),
  privacy: z.number().nullable(),
  coverUrl: z.string().nullable(),
  description: z.string().nullable(),
  subscribed: z.boolean(),
  playCount: z.number().nullable(),
  updateTimeMs: z.number().nullable(),
});

export const neteaseAccountProfileSchema = z.object({
  id: z.string(),
  nickname: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  gender: z.number().nullable(),
});

export function registerNeteaseAccountTools(server: McpServer, client: NeteaseClient): void {
  server.registerTool(
    "netease_account_profile",
    {
      title: "Cove's NetEase account profile",
      description: "Read Cove's own NetEase account profile, including nickname and avatar URL.",
      inputSchema: {},
      outputSchema: { profile: neteaseAccountProfileSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const profile = await client.getAccountProfile();
      return {
        structuredContent: { profile },
        content: [{ type: "text", text: JSON.stringify({ profile }) }],
      };
    },
  );

  server.registerTool(
    "netease_search_songs",
    {
      title: "Search Cove's NetEase Music",
      description: "Search NetEase Cloud Music songs using Cove's own NetEase account session.",
      inputSchema: {
        query: z.string().trim().min(1).max(120),
        limit: z.number().int().min(1).max(20).default(10),
      },
      outputSchema: { songs: z.array(neteaseSongSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      const songs = await client.searchSongs(query, limit);
      return {
        structuredContent: { songs },
        content: [{ type: "text", text: JSON.stringify({ songs }) }],
      };
    },
  );

  server.registerTool(
    "netease_my_playlists",
    {
      title: "Cove's NetEase playlists",
      description: "List every playlist visible on Cove's own NetEase account with ownership, creator, cover, counts, description, and pagination metadata.",
      inputSchema: {
        limit: z.number().int().min(1).max(1000).default(1000),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        offset: z.number(),
        limit: z.number(),
        count: z.number(),
        hasMore: z.boolean(),
        nextOffset: z.number().nullable(),
        playlists: z.array(playlistSchema),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit, offset }) => {
      const playlists = await client.listOwnPlaylists(limit, offset);
      const hasMore = playlists.length === limit;
      const result = {
        offset,
        limit,
        count: playlists.length,
        hasMore,
        nextOffset: hasMore ? offset + playlists.length : null,
        playlists,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_playlist_tracks",
    {
      title: "NetEase playlist tracks",
      description: "Read every song in a NetEase playlist, including album, artists, aliases, translated names, MV id, fee, disc, track number, cover, duration, and pagination metadata.",
      inputSchema: {
        playlistId: z.string().trim().min(1).max(40),
        limit: z.number().int().min(1).max(1000).default(1000),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        playlistId: z.string(),
        offset: z.number(),
        limit: z.number(),
        count: z.number(),
        hasMore: z.boolean(),
        nextOffset: z.number().nullable(),
        songs: z.array(neteaseSongSchema),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ playlistId, limit, offset }) => {
      const songs = await client.getPlaylistTracks(playlistId, limit, offset);
      const hasMore = songs.length === limit;
      const result = {
        playlistId,
        offset,
        limit,
        count: songs.length,
        hasMore,
        nextOffset: hasMore ? offset + songs.length : null,
        songs,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_song_details",
    {
      title: "NetEase song details",
      description: "Resolve complete metadata for up to 1000 numeric NetEase song ids while preserving the requested order.",
      inputSchema: {
        songIds: z.array(z.string().trim().regex(/^\d+$/)).min(1).max(1000),
      },
      outputSchema: { songs: z.array(neteaseSongSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ songIds }) => {
      const songs = await client.getSongDetailsMany(songIds);
      return {
        structuredContent: { songs },
        content: [{ type: "text", text: JSON.stringify({ songs }) }],
      };
    },
  );

  server.registerTool(
    "netease_create_playlist",
    {
      title: "Create Cove's NetEase playlist",
      description: "Create a real playlist on Cove's own NetEase account.",
      inputSchema: {
        name: z.string().trim().min(1).max(80),
        privacy: z.enum(["public", "private"]).default("public"),
      },
      outputSchema: {
        playlist: z.object({
          id: z.string(),
          name: z.string(),
          privacy: z.number(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ name, privacy }) => {
      const playlist = await client.createPlaylist(name, privacy === "private" ? 10 : 0);
      return {
        structuredContent: { playlist },
        content: [{ type: "text", text: JSON.stringify({ playlist }) }],
      };
    },
  );

  server.registerTool(
    "netease_add_to_playlist",
    {
      title: "Add songs to Cove's NetEase playlist",
      description: "Add one or more songs to a real playlist on Cove's own NetEase account.",
      inputSchema: {
        playlistId: z.string().trim().min(1).max(40),
        songIds: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
      },
      outputSchema: {
        ok: z.boolean(),
        playlistId: z.string(),
        songIds: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ playlistId, songIds }) => {
      await client.updatePlaylistTracks(playlistId, songIds, "add");
      const result = { ok: true, playlistId, songIds };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_remove_from_playlist",
    {
      title: "Remove songs from Cove's NetEase playlist",
      description: "Remove one or more songs from a real playlist on Cove's own NetEase account.",
      inputSchema: {
        playlistId: z.string().trim().min(1).max(40),
        songIds: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
      },
      outputSchema: {
        ok: z.boolean(),
        playlistId: z.string(),
        songIds: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ playlistId, songIds }) => {
      await client.updatePlaylistTracks(playlistId, songIds, "del");
      const result = { ok: true, playlistId, songIds };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_like_song",
    {
      title: "Set Cove's NetEase like state",
      description: "Like or unlike a song on Cove's own NetEase account.",
      inputSchema: {
        songId: z.string().trim().min(1).max(40),
        like: z.boolean().default(true),
      },
      outputSchema: {
        ok: z.boolean(),
        songId: z.string(),
        liked: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ songId, like }) => {
      await client.likeSong(songId, like);
      const result = { ok: true, songId, liked: like };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_play_history",
    {
      title: "Cove's NetEase play history",
      description: "Read Cove's own NetEase listening history and play counts.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        allTime: z.boolean().default(false),
      },
      outputSchema: {
        records: z.array(z.object({
          song: neteaseSongSchema,
          playCount: z.number(),
          score: z.number().nullable(),
        })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit, allTime }) => {
      const records = await client.getPlayHistory(limit, allTime);
      return {
        structuredContent: { records },
        content: [{ type: "text", text: JSON.stringify({ records }) }],
      };
    },
  );

  server.registerTool(
    "netease_daily_recommend",
    {
      title: "Cove's NetEase daily recommendations",
      description: "Read today's personalized song recommendations for Cove's own NetEase account.",
      inputSchema: {
        limit: z.number().int().min(1).max(30).default(30),
      },
      outputSchema: {
        songs: z.array(neteaseSongSchema.extend({ reason: z.string().nullable() })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit }) => {
      const songs = await client.getDailyRecommendations(limit);
      return {
        structuredContent: { songs },
        content: [{ type: "text", text: JSON.stringify({ songs }) }],
      };
    },
  );
}
