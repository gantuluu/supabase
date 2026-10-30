import {
  hmacSha256Hex,
  md5Hex,
  isSupportedCallbackResultCode,
  safeEqual,
  verifyPopCallbackSignature,
} from "./duitku.ts";

Deno.test("Duitku HMAC-SHA256 matches the standard test vector", async () => {
  const digest = await hmacSha256Hex(
    "key",
    "The quick brown fox jumps over the lazy dog",
  );
  if (digest !== "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8") {
    throw new Error("Unexpected HMAC-SHA256 digest");
  }
});

Deno.test("signature comparison accepts equal values and rejects mismatches", () => {
  if (!safeEqual("a".repeat(64), "a".repeat(64))) {
    throw new Error("Expected equal signatures to match");
  }
  if (safeEqual("a".repeat(64), "b".repeat(64))) {
    throw new Error("Expected different signatures not to match");
  }
  if (safeEqual("short", "longer")) {
    throw new Error("Expected different lengths not to match");
  }
});

Deno.test("only documented Duitku callback result codes are accepted", () => {
  for (const code of ["00", "01", "02"]) {
    if (!isSupportedCallbackResultCode(code)) {
      throw new Error(`Expected ${code} to be supported`);
    }
  }
  for (const code of ["03", "", "success"]) {
    if (isSupportedCallbackResultCode(code)) {
      throw new Error(`Expected ${code} to be rejected`);
    }
  }
});

Deno.test("Duitku status-check MD5 matches the standard test vector", () => {
  if (md5Hex("abc") !== "900150983cd24fb0d6963f7d28e17f72") {
    throw new Error("Unexpected MD5 digest");
  }
});

Deno.test("POP callback verification supports current HMAC and official PHP library MD5 signatures", async () => {
  const merchantCode = "DTEST";
  const amount = "125000";
  const merchantOrderId = "TRX-ABC123";
  const merchantKey = "test-merchant-key";
  const signedFields = merchantCode + amount + merchantOrderId;

  const hmacSignature = await hmacSha256Hex(merchantKey, signedFields);
  const legacyMd5Signature = md5Hex(signedFields + merchantKey);

  if (!await verifyPopCallbackSignature(merchantCode, amount, merchantOrderId, merchantKey, hmacSignature)) {
    throw new Error("Expected current HMAC callback signature to verify");
  }
  if (!await verifyPopCallbackSignature(merchantCode, amount, merchantOrderId, merchantKey, legacyMd5Signature)) {
    throw new Error("Expected official PHP library callback signature to verify");
  }
  if (await verifyPopCallbackSignature(merchantCode, amount, merchantOrderId, merchantKey, "0".repeat(32))) {
    throw new Error("Expected invalid callback signature to be rejected");
  }
});
