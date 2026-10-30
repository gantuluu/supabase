import {
  hmacSha256Hex,
  isRecord,
  isSupportedCallbackResultCode,
  safeEqual,
} from "../_shared/duitku.ts";

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

function adminHeaders(): Record<string, string> {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed: unknown = JSON.parse(secretKeys);
    if (!isRecord(parsed) || typeof parsed.default !== "string" || !parsed.default) {
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
    for (const [key, value] of params.entries()) {
      // Reject duplicate keys instead of silently accepting the last value.
      if (Object.hasOwn(data, key)) return response("Duplicate callback parameter", 400);
      data[key] = value;
    }

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
      !reference ||
      reference.length > 100 ||
      !isSupportedCallbackResultCode(resultCode) ||
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

    const callbackPayload = {
      merchantCode: receivedMerchantCode,
      amount: amountText,
      merchantOrderId,
      productDetail: data.productDetail ?? null,
      additionalParam: data.additionalParam ?? null,
      paymentCode: data.paymentCode ?? null,
      resultCode,
      reference,
      publisherOrderId: data.publisherOrderId ?? null,
      settlementDate: data.settlementDate ?? null,
    };

    const rpcResponse = await dbRequest(supabaseUrl, "rpc/apply_duitku_callback", {
      method: "POST",
      body: JSON.stringify({
        p_merchant_order_id: merchantOrderId,
        p_amount: Number(amountText),
        p_merchant_code: receivedMerchantCode,
        p_result_code: resultCode,
        p_reference: reference,
        p_callback_payload: callbackPayload,
      }),
    });

    if (!rpcResponse.ok) {
      console.error("Could not persist Duitku callback:", await rpcResponse.text());
      return response("Temporary database error", 500);
    }

    const result: unknown = await rpcResponse.json();
    if (!isRecord(result) || typeof result.outcome !== "string") {
      console.error("Duitku callback RPC returned an invalid response");
      return response("Invalid reconciliation response", 500);
    }

    switch (result.outcome) {
      case "paid":
      case "failed":
      case "already_paid":
        return response("OK", 200);
      case "not_found":
        return response("Transaction not found", 404);
      case "transaction_mismatch":
      case "reference_required":
      case "reference_mismatch":
        return response("Transaction validation failed", 400);
      case "unsupported_result_code":
        return response("Unsupported result code", 422);
      default:
        console.error("Unexpected Duitku callback outcome:", result.outcome);
        return response("Could not reconcile callback", 500);
    }
  } catch (error) {
    console.error("duitku-callback error:", error instanceof Error ? error.message : "Unknown error");
    return response("Internal server error", 500);
  }
});
