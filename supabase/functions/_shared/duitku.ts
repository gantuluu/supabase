import { createHash } from "node:crypto";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isSupportedCallbackResultCode(value: string): boolean {
  // The POP callback documentation is inconsistent about 01/02. Accept both
  // callback values, but settle from the independent status-check response.
  return value === "00" || value === "01" || value === "02";
}

export function md5Hex(message: string): string {
  return createHash("md5").update(message, "utf8").digest("hex");
}

export async function verifyPopCallbackSignature(
  merchantCode: string,
  amount: string,
  merchantOrderId: string,
  merchantKey: string,
  receivedSignature: string,
): Promise<boolean> {
  const signedFields = merchantCode + amount + merchantOrderId;
  const currentSignature = await hmacSha256Hex(merchantKey, signedFields);
  const legacyLibrarySignature = md5Hex(signedFields + merchantKey);
  return safeEqual(currentSignature, receivedSignature) ||
    safeEqual(legacyLibrarySignature, receivedSignature);
}
