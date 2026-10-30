// Creates a Duitku POP invoice and persists the transaction before returning it.
// Required secrets: DUITKU_MERCHANT_CODE, DUITKU_MERCHANT_KEY,
// DUITKU_CALLBACK_URL, DUITKU_RETURN_URL, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEYS), and SUPABASE_ANON_KEY
// (or SUPABASE_PUBLISHABLE_KEYS).

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

function getDefaultKey(jsonEnvName: string, legacyEnvName: string): string {
  const jsonValue = Deno.env.get(jsonEnvName);
  if (jsonValue) {
    const parsed: unknown = JSON.parse(jsonValue);
    if (typeof parsed === "object" && parsed !== null && "default" in parsed) {
      const value = (parsed as Record<string, unknown>).default;
      if (typeof value === "string" && value.length > 0) return value;
    }
    throw new Error(`Environment variable ${jsonEnvName} has no default key`);
  }
  return requiredEnv(legacyEnvName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getAuthenticatedUserId(req: Request, supabaseUrl: string): Promise<string | null> {
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const publishableKey = getDefaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${match[1]}`,
    },
  });
  if (!response.ok) return null;

  const user: unknown = await response.json();
  return isRecord(user) && typeof user.id === "string" ? user.id : null;
}

function adminHeaders(): Record<string, string> {
  let key: string;
  let legacyJwt = false;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed: unknown = JSON.parse(secretKeys);
    if (!isRecord(parsed) || typeof parsed.default !== "string") {
      throw new Error("SUPABASE_SECRET_KEYS must contain a default key");
    }
    key = parsed.default;
  } else {
    key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    legacyJwt = true;
  }

  return {
    apikey: key,
    ...(legacyJwt ? { Authorization: `Bearer ${key}` } : {}),
    "Content-Type": "application/json",
  };
}

async function dbRequest(
  supabaseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...adminHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const userId = await getAuthenticatedUserId(req, supabaseUrl);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);

    const merchantCode = requiredEnv("DUITKU_MERCHANT_CODE");
    const merchantKey = requiredEnv("DUITKU_MERCHANT_KEY");
    const callbackUrl = requiredEnv("DUITKU_CALLBACK_URL");
    const returnUrl = requiredEnv("DUITKU_RETURN_URL");
    const environment = (Deno.env.get("DUITKU_ENV") ?? "sandbox").toLowerCase();

    if (environment !== "sandbox" && environment !== "production") {
      return json({ success: false, error: "DUITKU_ENV must be sandbox or production" }, 500);
    }

    const input: unknown = await req.json();
    if (!isRecord(input)) return json({ success: false, error: "Request body must be a JSON object" }, 400);

    const paymentAmount = input.paymentAmount;
    const productDetails = typeof input.productDetails === "string" ? input.productDetails.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim() : "";
    const phoneNumber = typeof input.phoneNumber === "string" ? input.phoneNumber.trim() : undefined;
    const paymentMethod = typeof input.paymentMethod === "string" ? input.paymentMethod.trim() : undefined;
    const expiryPeriod = input.expiryPeriod;

    if (!Number.isSafeInteger(paymentAmount) || (paymentAmount as number) <= 0) {
      return json({ success: false, error: "paymentAmount must be a positive safe integer in IDR" }, 400);
    }
    if (!productDetails || productDetails.length > 255) {
      return json({ success: false, error: "productDetails must contain 1-255 characters" }, 400);
    }
    if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, error: "A valid email is required" }, 400);
    }
    if (phoneNumber !== undefined && (!/^\+?[0-9]{8,20}$/.test(phoneNumber))) {
      return json({ success: false, error: "phoneNumber must contain 8-20 digits and an optional leading +" }, 400);
    }
    if (paymentMethod !== undefined && (!/^[A-Za-z0-9]{1,10}$/.test(paymentMethod))) {
      return json({ success: false, error: "paymentMethod format is invalid" }, 400);
    }
    if (expiryPeriod !== undefined && (!Number.isInteger(expiryPeriod) || (expiryPeriod as number) < 1 || (expiryPeriod as number) > 10080)) {
      return json({ success: false, error: "expiryPeriod must be an integer between 1 and 10080 minutes" }, 400);
    }

    const merchantOrderId = `TRX-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    const insertQuery = "duitku_transactions?select=id,merchant_order_id";
    const insertResponse = await dbRequest(supabaseUrl, insertQuery, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        merchant_order_id: merchantOrderId,
        merchant_code: merchantCode,
        amount: paymentAmount,
        currency: "IDR",
        product_details: productDetails,
        customer_email: email,
        customer_phone: phoneNumber ?? null,
        payment_method: paymentMethod ?? null,
        status: "pending",
      }),
    });

    if (!insertResponse.ok) {
      console.error("Failed to create transaction row:", await insertResponse.text());
      return json({ success: false, error: "Could not initialize transaction" }, 500);
    }

    const createdRows: unknown = await insertResponse.json();
    if (!Array.isArray(createdRows) || !isRecord(createdRows[0]) || typeof createdRows[0].id !== "string") {
      return json({ success: false, error: "Transaction initialization returned an invalid response" }, 500);
    }
    const transactionId = createdRows[0].id as string;

    const payload: Record<string, unknown> = {
      paymentAmount,
      merchantOrderId,
      productDetails,
      email,
      callbackUrl,
      returnUrl,
    };
    if (phoneNumber) payload.phoneNumber = phoneNumber;
    if (paymentMethod) payload.paymentMethod = paymentMethod;
    if (expiryPeriod !== undefined) payload.expiryPeriod = expiryPeriod;

    const timestamp = Date.now().toString();
    const signature = await hmacSha256Hex(merchantKey, merchantCode + timestamp);
    const endpoint = environment === "production"
      ? "https://api-prod.duitku.com/api/merchant/createInvoice"
      : "https://api-sandbox.duitku.com/api/merchant/createInvoice";

    let duitkuResponse: Response;
    try {
      duitkuResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-duitku-timestamp": timestamp,
          "x-duitku-signature": signature,
          "x-duitku-merchantcode": merchantCode,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "failed", failure_reason: "Duitku request could not be reached" }),
      });
      throw error;
    }

    const responseText = await duitkuResponse.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { message: responseText.slice(0, 500) };
    }

    const validDuitkuResponse = isRecord(responseData) &&
      responseData.statusCode === "00" &&
      typeof responseData.reference === "string" &&
      responseData.reference.length > 0 &&
      typeof responseData.paymentUrl === "string" &&
      responseData.paymentUrl.startsWith("https://");

    if (!duitkuResponse.ok || !validDuitkuResponse) {
      await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          duitku_status_code: isRecord(responseData) ? String(responseData.statusCode ?? "") : null,
          duitku_status_message: isRecord(responseData) ? String(responseData.statusMessage ?? "") : null,
          failure_reason: "Duitku did not return a successful invoice",
        }),
      });
      return json({
        success: false,
        error: "Duitku invoice request failed",
        duitkuStatus: duitkuResponse.status,
        detail: responseData,
      }, 502);
    }

    const updateResponse = await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        duitku_reference: responseData.reference,
        payment_url: responseData.paymentUrl,
        duitku_status_code: responseData.statusCode,
        duitku_status_message: responseData.statusMessage ?? "SUCCESS",
        expires_at: expiryPeriod ? new Date(Date.now() + (expiryPeriod as number) * 60000).toISOString() : null,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!updateResponse.ok) {
      console.error("Invoice created but transaction update failed:", await updateResponse.text());
      return json({
        success: false,
        error: "Invoice was created but could not be saved. Contact support with this transaction ID.",
        transactionId,
      }, 500);
    }

    return json({
      success: true,
      data: {
        transactionId,
        merchantOrderId,
        reference: responseData.reference,
        paymentUrl: responseData.paymentUrl,
        amount: paymentAmount,
        currency: "IDR",
        status: "pending",
      },
    });
  } catch (error) {
    console.error("duitku-create-invoice error:", error instanceof Error ? error.message : "Unknown error");
    return json({ success: false, error: "Internal server error" }, 500);
  }
});
