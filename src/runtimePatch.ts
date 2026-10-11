import { readFileSync, writeFileSync } from "node:fs";

function replaceOrThrow(path: string, pattern: RegExp, replacement: string): void {
  const source = readFileSync(path, "utf8");
  if (!pattern.test(source)) {
    throw new Error("Fanqie runtime patch anchor missing in " + path);
  }
  writeFileSync(path, source.replace(pattern, replacement));
}

replaceOrThrow(
  "dist/src/profiles.js",
  /if \(profile === "music"\)\s*return source\.startsWith\("netease\."\);/,
  'if (profile === "music") return source.startsWith("netease.") || source.startsWith("fanqie.");',
);

replaceOrThrow(
  "dist/src/bridge/events.js",
  /if \(source\.startsWith\("netease\."\)\) \{\s*return \{ stream: "state", stateKey: "netease\.together\.presence" \};\s*\}/,
  'if (source.startsWith("fanqie.")) { return { stream: "state", stateKey: "fanqie.current_page" }; }\n    if (source.startsWith("netease.")) { return { stream: "state", stateKey: "netease.together.presence" }; }',
);

console.log("Fanqie runtime routing patch applied.");
