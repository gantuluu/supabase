// Supabase Edge Function: verify Duitku POP payment notifications.
// This endpoint is public at the Supabase gateway; authenticity is enforced
// by verifying Duitku's HMAC-SHA256 callback signature.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response("OK");
  if (req.method !== "POST") return response("Method not allowed", 405);

  try {
    const merchantCode = Deno.env.get("DUITKU_MERCHANT_CODE")?.trim();
    const merchantKey = Deno.env.get("DUITKU_MERCHANT_KEY")?.trim();
    if (!merchantCode || !merchantKey) {
      console.error("Duitku callback secrets are not configured");
      return response("Server configuration error", 500);
    }

    const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
    let data: Record<string, string> = {};

    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") data[key] = value;
      }
    } else if (contentType.includes("application/json")) {
      const body: unknown = await req.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return response("Invalid callback payload", 400);
      }
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string" || typeof value === "number") data[key] = String(value);
      }
    } else {
      return response("Unsupported content type", 415);
    }

    const receivedMerchantCode = data.merchantCode ?? data.merchantcode ?? "";
    const amount = data.amount ?? "";
    const merchantOrderId = data.merchantOrderId ?? "";
    const receivedSignature = (data.signature ?? "").toLowerCase();

    if (
      receivedMerchantCode !== merchantCode ||
      !amount ||
      !merchantOrderId ||
      !/^[a-f0-9]{64}$/.test(receivedSignature)
    ) {
      return response("Invalid callback parameters", 400);
    }

    // Duitku POP callback signature:
    // HMAC_SHA256(merchantCode + amount + merchantOrderId, merchantKey)
    const expectedSignature = await hmacSha256Hex(
      merchantKey,
      receivedMerchantCode + amount + merchantOrderId,
    );

    if (!safeEqual(expectedSignature, receivedSignature)) {
      console.warn("Rejected Duitku callback: invalid signature");
      return response("Invalid signature", 401);
    }

    // resultCode "00" means successful payment; "01" means failed.
    // Persistence/order-state updates must be added once the application's
    // payment table and order ownership contract are defined.
    console.info("Verified Duitku callback", {
      merchantOrderId,
      amount,
      resultCode: data.resultCode ?? "",
      reference: data.reference ?? "",
    });

    return response("OK", 200);
  } catch (error) {
    console.error("duitku-callback error:", error instanceof Error ? error.message : "Unknown error");
    return response("Internal server error", 500);
  }
});
