// AES-GCM for what the hub keeps for a person: their Claude token (in its cookie) and their
// ChatGPT sign-in (on disk, under a key held in their cookie). The key comes from HUB_SECRET,
// else MCP_KEY; changing it signs every browser out.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY = createHash("sha256").update(`craft-ai-hub/token/${process.env.HUB_SECRET || process.env.MCP_KEY || randomBytes(32).toString("hex")}`).digest();

export const seal = (text, key = KEY) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
};

export const open = (sealed, key = KEY) => {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
};

// A key of its own for one person's data, from the hub's key and a secret only their cookie holds.
export const keyFor = (secret) => createHash("sha256").update(KEY).update(secret).digest();

export const cookieValue = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1] ?? "";
