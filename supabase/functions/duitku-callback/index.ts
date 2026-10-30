import {
  isRecord,
  md5Hex,
  isSupportedCallbackResultCode,
  safeEqual,
  verifyPopCallbackSignature,
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
      reference.length > 100 ||
      !isSupportedCallbackResultCode(resultCode) ||
      !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(receivedSignature)
    ) {
      return response("Invalid callback parameters", 400);
    }

    const signatureValid = await verifyPopCallbackSignature(
      receivedMerchantCode,
      amountText,
      merchantOrderId,
      merchantKey,
      receivedSignature,
    );
    if (!signatureValid) {
      console.warn("Rejected Duitku callback: invalid signature");
      return response("Invalid signature", 401);
    }

    // Verify the provider's current transaction state before applying the callback.
    // This endpoint is specifically exposed by Duitku's official POP PHP library.
    const environment = (Deno.env.get("DUITKU_ENV") ?? "sandbox").toLowerCase();
    if (environment !== "sandbox" && environment !== "production") {
      return response("Invalid Duitku environment configuration", 500);
    }

    const statusSignature = md5Hex(merchantCode + merchantOrderId + merchantKey);
    const statusEndpoint = environment === "production"
      ? "https://api-prod.duitku.com/api/merchant/transactionStatus"
      : "https://api-sandbox.duitku.com/api/merchant/transactionStatus";

    let statusResponse: Response;
    try {
      statusResponse = await fetch(statusEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantCode,
          merchantOrderId,
          signature: statusSignature,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      console.error("Duitku status verification unavailable:", error instanceof Error ? error.message : "Unknown error");
      return response("Transaction status verification unavailable", 503);
    }

    const statusText = await statusResponse.text();
    let statusData: unknown;
    try {
      statusData = JSON.parse(statusText);
    } catch {
      statusData = null;
    }

    if (!statusResponse.ok || !isRecord(statusData)) {
      console.error("Duitku status verification failed:", statusResponse.status);
      return response("Transaction status verification failed", 503);
    }

    const verifiedAmountValue = typeof statusData.amount === "string" && /^\d+$/.test(statusData.amount)
      ? Number(statusData.amount)
      : statusData.amount;
    if (
      statusData.merchantOrderId !== merchantOrderId ||
      typeof verifiedAmountValue !== "number" ||
      !Number.isSafeInteger(verifiedAmountValue) ||
      verifiedAmountValue !== Number(amountText)
    ) {
      console.warn("Duitku status response did not match callback transaction", { merchantOrderId });
      return response("Verified transaction details mismatch", 400);
    }

    const verifiedStatusCode = statusData.statusCode;
    if (verifiedStatusCode === "01") {
      return response("Duitku transaction is still pending", 503);
    }
    if (verifiedStatusCode !== "00" && verifiedStatusCode !== "02") {
      console.error("Unsupported Duitku transaction status:", verifiedStatusCode);
      return response("Unsupported verified transaction status", 503);
    }

    const statusReference = typeof statusData.reference === "string" ? statusData.reference : "";
    if (reference && statusReference && reference !== statusReference) {
      console.warn("Duitku callback reference did not match status response", { merchantOrderId });
      return response("Transaction reference mismatch", 400);
    }

    const callbackPayload = {
      merchantCode: receivedMerchantCode,
      amount: amountText,
      merchantOrderId,
      productDetail: data.productDetail ?? null,
      additionalParam: data.additionalParam ?? null,
      paymentCode: data.paymentCode ?? null,
      callbackResultCode: resultCode,
      verifiedStatusCode,
      callbackReference: reference || null,
      statusReference: statusReference || null,
      statusMessage: typeof statusData.statusMessage === "string" ? statusData.statusMessage : null,
      publisherOrderId: data.publisherOrderId ?? null,
      settlementDate: data.settlementDate ?? null,
    };

    const rpcResponse = await dbRequest(supabaseUrl, "rpc/apply_duitku_callback", {
      method: "POST",
      body: JSON.stringify({
        p_merchant_order_id: merchantOrderId,
        p_amount: Number(amountText),
        p_merchant_code: receivedMerchantCode,
        p_result_code: verifiedStatusCode,
        p_reference: statusReference || null,
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
      case "pending":
        return response("Duitku transaction is still pending", 503);
      case "not_found":
        return response("Transaction not found", 404);
      case "transaction_mismatch":
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
