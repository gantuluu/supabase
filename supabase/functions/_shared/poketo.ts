export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parsePoketoSignature(
  signatureHeader: string,
  nowMilliseconds = Date.now(),
): { timestamp: number; signature: string } | null {
  const parts = new Map<string, string>();
  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if ((key !== "t" && key !== "v1") || !value || parts.has(key)) return null;
    parts.set(key, value);
  }

  const timestampText = parts.get("t") ?? "";
  const signature = parts.get("v1") ?? "";
  if (!/^\d{1,12}$/.test(timestampText) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return null;
  }

  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) {
    return null;
  }

  return { timestamp, signature: signature.toLowerCase() };
}

export async function verifyPoketoSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowMilliseconds = Date.now(),
): Promise<boolean> {
  const parsed = parsePoketoSignature(signatureHeader, nowMilliseconds);
  if (!parsed || !webhookSecret.startsWith("whsec_")) return false;

  const expected = await hmacSha256Hex(
    webhookSecret,
    `${parsed.timestamp}.${rawBody}`,
  );
  return safeEqual(expected, parsed.signature);
}

export function isValidPoketoPaymentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "pay.poketo.id" &&
      url.pathname.startsWith("/inv/");
  } catch {
    return false;
  }
}
