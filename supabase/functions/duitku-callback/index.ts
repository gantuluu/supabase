// Public Duitku POP callback. HMAC verification and transaction reconciliation
// are performed before the callback is acknowledged with HTTP 200.

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
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

function adminHeaders(): Record<string, string> {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed: unknown = JSON.parse(secretKeys);
    if (!isRecord(parsed) || typeof parsed.default !== "string") {
      throw new Error("SUPABASE_SECRET_KEYS must contain a default key");
    }
    return { apikey: parsed.default, "Content-Type": "application/json" };
  }
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function dbRequest(supabaseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...adminHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response("OK");
  if (req.method !== "POST") return response("Method not allowed", 405);

  try {
    const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return response("Unsupported content type", 415);
    }

    const rawBody = await req.text();
    if (rawBody.length > 16384) return response("Callback payload too large", 413);
    const params = new URLSearchParams(rawBody);
    const data: Record<string, string> = {};
    for (const [key, value] of params.entries()) data[key] = value;

    const merchantCode = requiredEnv("DUITKU_MERCHANT_CODE");
    const merchantKey = requiredEnv("DUITKU_MERCHANT_KEY");
    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const receivedMerchantCode = data.merchantCode ?? data.merchantcode ?? "";
    const amountText = data.amount ?? "";
    const merchantOrderId = data.merchantOrderId ?? "";
    const resultCode = data.resultCode ?? "";
    const reference = data.reference ?? "";
    const receivedSignature = (data.signature ?? "").toLowerCase();

    if (
      receivedMerchantCode !== merchantCode ||
      !/^\d+$/.test(amountText) ||
      !Number.isSafeInteger(Number(amountText)) ||
      !merchantOrderId ||
      merchantOrderId.length > 50 ||
      !resultCode ||
      !/^[a-f0-9]{64}$/.test(receivedSignature)
    ) {
      return response("Invalid callback parameters", 400);
    }

    const expectedSignature = await hmacSha256Hex(
      merchantKey,
      receivedMerchantCode + amountText + merchantOrderId,
    );
    if (!safeEqual(expectedSignature, receivedSignature)) {
      console.warn("Rejected Duitku callback: invalid signature");
      return response("Invalid signature", 401);
    }

    const lookup = new URLSearchParams({
      select: "id,amount,status,duitku_reference,merchant_code",
      merchant_order_id: `eq.${merchantOrderId}`,
      limit: "1",
    });
    const lookupResponse = await dbRequest(supabaseUrl, `duitku_transactions?${lookup.toString()}`);
    if (!lookupResponse.ok) {
      console.error("Could not load transaction:", await lookupResponse.text());
      return response("Temporary database error", 500);
    }

    const rows: unknown = await lookupResponse.json();
    if (!Array.isArray(rows) || !isRecord(rows[0])) {
      console.warn("Duitku callback has no matching transaction", { merchantOrderId });
      return response("Transaction not found", 404);
    }

    const transaction = rows[0];
    if (
      transaction.merchant_code !== merchantCode ||
      Number(transaction.amount) !== Number(amountText)
    ) {
      console.warn("Duitku callback transaction mismatch", { merchantOrderId });
      return response("Transaction amount or merchant mismatch", 400);
    }

    if (
      typeof transaction.duitku_reference === "string" &&
      transaction.duitku_reference.length > 0 &&
      reference &&
      transaction.duitku_reference !== reference
    ) {
      console.warn("Duitku callback reference mismatch", { merchantOrderId });
      return response("Transaction reference mismatch", 400);
    }

    // Duitku documents resultCode 00 as success. Treat every other result code
    // as non-success; this avoids marking unknown codes as paid.
    const isPaid = resultCode === "00";
    if (transaction.status === "paid") return response("OK", 200);

    const updateFilter = isPaid
      ? "status=in.(pending,failed)"
      : "status=eq.pending";
    const updateQuery = `duitku_transactions?id=eq.${transaction.id}&${updateFilter}`;
    const callbackPayload = {
      merchantOrderId,
      amount: amountText,
      resultCode,
      reference,
      paymentCode: data.paymentCode ?? null,
    };
    const updateResponse = await dbRequest(supabaseUrl, updateQuery, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: isPaid ? "paid" : "failed",
        callback_result_code: resultCode,
        callback_reference: reference || null,
        callback_payload: callbackPayload,
        ...(reference && !transaction.duitku_reference ? { duitku_reference: reference } : {}),
        ...(isPaid ? { paid_at: new Date().toISOString(), failure_reason: null } : {
          failure_reason: `Duitku resultCode ${resultCode}`,
        }),
        updated_at: new Date().toISOString(),
      }),
    });

    if (!updateResponse.ok) {
      console.error("Could not persist Duitku callback:", await updateResponse.text());
      return response("Could not persist callback", 500);
    }

    const updatedRows: unknown = await updateResponse.json();
    if (Array.isArray(updatedRows) && updatedRows.length > 0) return response("OK", 200);

    // A concurrent duplicate may have completed the same update already.
    const checkResponse = await dbRequest(
      supabaseUrl,
      `duitku_transactions?select=status&merchant_order_id=eq.${encodeURIComponent(merchantOrderId)}&limit=1`,
    );
    if (checkResponse.ok) {
      const checkRows: unknown = await checkResponse.json();
      if (Array.isArray(checkRows) && isRecord(checkRows[0])) {
        if (checkRows[0].status === "paid" || (!isPaid && checkRows[0].status === "failed")) {
          return response("OK", 200);
        }
      }
    }

    return response("Transaction state was not updated", 500);
  } catch (error) {
    console.error("duitku-callback error:", error instanceof Error ? error.message : "Unknown error");
    return response("Internal server error", 500);
  }
});
