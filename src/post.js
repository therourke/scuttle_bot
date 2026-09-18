const fs = require("fs");
const path = require("path");
const { AtpAgent } = require("@atproto/api");
const { generatePost } = require("./generate");

const CORPUS_FILE = path.join(__dirname, "..", "data", "corpus.json");

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, "utf8"));
  const text = generatePost(corpus);

  console.log("Generated post:\n" + text);

  if (dryRun) {
    console.log("\n(dry run - not posting)");
    return;
  }

  const handle = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!handle || !password) {
    throw new Error("Missing BSKY_HANDLE or BSKY_APP_PASSWORD environment variables.");
  }

  const agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });
  await agent.post({ text, createdAt: new Date().toISOString() });

  console.log("Posted to Bluesky.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
