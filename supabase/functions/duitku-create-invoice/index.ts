// Supabase Edge Function: create a Duitku POP invoice.
// Required secrets: DUITKU_MERCHANT_CODE, DUITKU_MERCHANT_KEY,
// DUITKU_CALLBACK_URL, DUITKU_RETURN_URL. Optional: DUITKU_ENV=sandbox|production.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const merchantCode = requiredEnv("DUITKU_MERCHANT_CODE");
    const merchantKey = requiredEnv("DUITKU_MERCHANT_KEY");
    const callbackUrl = requiredEnv("DUITKU_CALLBACK_URL");
    const returnUrl = requiredEnv("DUITKU_RETURN_URL");
    const environment = (Deno.env.get("DUITKU_ENV") ?? "sandbox").toLowerCase();

    if (environment !== "sandbox" && environment !== "production") {
      return json({ success: false, error: "DUITKU_ENV must be sandbox or production" }, 500);
    }

    const input: unknown = await req.json();
    if (!isRecord(input)) {
      return json({ success: false, error: "Request body must be a JSON object" }, 400);
    }

    const paymentAmount = input.paymentAmount;
    const merchantOrderId = input.merchantOrderId;
    const productDetails = input.productDetails;
    const email = input.email;

    if (!Number.isSafeInteger(paymentAmount) || (paymentAmount as number) <= 0) {
      return json({ success: false, error: "paymentAmount must be a positive integer in IDR" }, 400);
    }
    if (typeof merchantOrderId !== "string" || merchantOrderId.length < 1 || merchantOrderId.length > 50) {
      return json({ success: false, error: "merchantOrderId must be a string of 1-50 characters" }, 400);
    }
    if (typeof productDetails !== "string" || productDetails.length < 1 || productDetails.length > 255) {
      return json({ success: false, error: "productDetails must be a string of 1-255 characters" }, 400);
    }
    if (typeof email !== "string" || email.length < 3 || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, error: "A valid email is required" }, 400);
    }

    const payload: Record<string, unknown> = {
      paymentAmount,
      merchantOrderId,
      productDetails,
      email,
      callbackUrl,
      returnUrl,
    };

    const optionalStringFields = [
      "additionalParam",
      "merchantUserInfo",
      "customerVaName",
      "phoneNumber",
      "paymentMethod",
    ] as const;

    for (const field of optionalStringFields) {
      const value = input[field];
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 255) {
          return json({ success: false, error: `${field} must be a string no longer than 255 characters` }, 400);
        }
        payload[field] = value;
      }
    }

    if (input.itemDetails !== undefined) {
      if (!Array.isArray(input.itemDetails)) {
        return json({ success: false, error: "itemDetails must be an array" }, 400);
      }
      payload.itemDetails = input.itemDetails;
    }
    if (input.customerDetail !== undefined) {
      if (!isRecord(input.customerDetail)) {
        return json({ success: false, error: "customerDetail must be an object" }, 400);
      }
      payload.customerDetail = input.customerDetail;
    }
    if (input.expiryPeriod !== undefined) {
      if (!Number.isInteger(input.expiryPeriod) || (input.expiryPeriod as number) <= 0) {
        return json({ success: false, error: "expiryPeriod must be a positive integer in minutes" }, 400);
      }
      payload.expiryPeriod = input.expiryPeriod;
    }

    // Duitku POP v1 Create Invoice signature:
    // HMAC_SHA256(merchantCode + timestamp, merchantKey)
    const timestamp = Date.now().toString();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(merchantKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(merchantCode + timestamp),
    );
    const signature = Array.from(new Uint8Array(signatureBytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const endpoint = environment === "production"
      ? "https://api-prod.duitku.com/api/merchant/createInvoice"
      : "https://api-sandbox.duitku.com/api/merchant/createInvoice";

    const duitkuResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-duitku-timestamp": timestamp,
        "x-duitku-signature": signature,
        "x-duitku-merchantcode": merchantCode,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await duitkuResponse.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { message: responseText.slice(0, 500) };
    }

    if (!duitkuResponse.ok) {
      return json({
        success: false,
        error: "Duitku invoice request failed",
        duitkuStatus: duitkuResponse.status,
        detail: responseData,
      }, 502);
    }

    return json({ success: true, data: responseData });
  } catch (error) {
    console.error("duitku-create-invoice error:", error instanceof Error ? error.message : "Unknown error");
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    }, 500);
  }
});
