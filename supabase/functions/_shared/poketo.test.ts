import {
  hmacSha256Hex,
  isValidPoketoPaymentUrl,
  parsePoketoSignature,
  safeEqual,
  verifyPoketoSignature,
} from "./poketo.ts";

Deno.test("Poketo HMAC-SHA256 matches the standard test vector", async () => {
  const digest = await hmacSha256Hex(
    "key",
    "The quick brown fox jumps over the lazy dog",
  );
  if (digest !== "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8") {
    throw new Error("Unexpected HMAC-SHA256 digest");
  }
});

Deno.test("signature parser accepts fresh timestamps and rejects stale or malformed headers", () => {
  const now = 1_800_000_000_000;
  const timestamp = Math.floor(now / 1000);
  const signature = "a".repeat(64);

  if (!parsePoketoSignature(`t=${timestamp},v1=${signature}`, now)) {
    throw new Error("Expected a valid signature header");
  }
  if (parsePoketoSignature(`t=${timestamp - 301},v1=${signature}`, now)) {
    throw new Error("Expected a stale signature to be rejected");
  }
  if (parsePoketoSignature(`t=${timestamp + 301},v1=${signature}`, now)) {
    throw new Error("Expected a future replay timestamp to be rejected");
  }
  if (parsePoketoSignature(`t=${timestamp},v1=bad`, now)) {
    throw new Error("Expected a malformed signature to be rejected");
  }
  if (parsePoketoSignature(`t=${timestamp},t=${timestamp},v1=${signature}`, now)) {
    throw new Error("Expected duplicate signature fields to be rejected");
  }
});

Deno.test("Poketo webhook signature verifies the exact raw body", async () => {
  const secret = "whsec_test-secret";
  const rawBody = '{"id":"evt_test","type":"invoice.paid"}';
  const timestamp = 1_800_000_000;
  const digest = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  const header = `t=${timestamp},v1=${digest}`;

  if (!await verifyPoketoSignature(rawBody, header, secret, timestamp * 1000)) {
    throw new Error("Expected the valid webhook signature to pass");
  }
  if (await verifyPoketoSignature(rawBody + " ", header, secret, timestamp * 1000)) {
    throw new Error("Expected a changed raw body to fail verification");
  }
  if (await verifyPoketoSignature(rawBody, header, "wrong-secret", timestamp * 1000)) {
    throw new Error("Expected an invalid webhook secret to fail verification");
  }
});

Deno.test("constant-time comparison rejects different values", () => {
  if (!safeEqual("a".repeat(64), "a".repeat(64))) {
    throw new Error("Expected equal values");
  }
  if (safeEqual("a".repeat(64), "b".repeat(64))) {
    throw new Error("Expected unequal values");
  }
  if (safeEqual("short", "longer")) {
    throw new Error("Expected different lengths");
  }
});

Deno.test("only Poketo invoice payment URLs are accepted", () => {
  if (!isValidPoketoPaymentUrl("https://pay.poketo.id/inv/abc123")) {
    throw new Error("Expected a Poketo invoice URL to pass");
  }
  for (const url of [
    "http://pay.poketo.id/inv/abc123",
    "https://poketo.id/inv/abc123",
    "https://pay.poketo.id.evil.test/inv/abc123",
    "https://pay.poketo.id/l/abc123",
  ]) {
    if (isValidPoketoPaymentUrl(url)) {
      throw new Error(`Expected URL to be rejected: ${url}`);
    }
  }
});
