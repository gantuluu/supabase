import {
  hmacSha256Hex,
  isSupportedCallbackResultCode,
  safeEqual,
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
