import { hmacSha256Hex, isRecord } from "../_shared/duitku.ts";

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
    if (isRecord(parsed) && typeof parsed.default === "string" && parsed.default.length > 0) {
      return parsed.default;
    }
    throw new Error(`${jsonEnvName} must contain a default key`);
  }
  return requiredEnv(legacyEnvName);
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

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toSafeAmount(value: unknown): number | null {
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0
    ? amount
    : null;
}

function validPaymentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function transactionResponse(row: Record<string, unknown>) {
  return {
    transactionId: row.id,
    merchantOrderId: row.merchant_order_id,
    reference: row.duitku_reference,
    paymentUrl: row.payment_url,
    amount: toSafeAmount(row.amount),
    currency: row.currency ?? "IDR",
    status: row.status,
  };
}

async function loadActiveTransaction(
  supabaseUrl: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const query = new URLSearchParams({
    select: "id,merchant_order_id,duitku_reference,payment_url,amount,currency,status",
    order_id: `eq.${orderId}`,
    status: "in.(pending,paid)",
    limit: "1",
  });
  const response = await dbRequest(supabaseUrl, `duitku_transactions?${query.toString()}`);
  if (!response.ok) throw new Error("Could not check existing payment transaction");
  const rows: unknown = await response.json();
  return Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let transactionId: string | null = null;

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const userId = await getAuthenticatedUserId(req, supabaseUrl);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);

    const input: unknown = await req.json().catch(() => null);
    if (!isRecord(input)) {
      return json({ success: false, error: "Request body must be a JSON object" }, 400);
    }
    if (!validUuid(input.orderId)) {
      return json({ success: false, error: "A valid orderId is required" }, 400);
    }

    const paymentMethod = typeof input.paymentMethod === "string" ? input.paymentMethod.trim() : "";
    if (paymentMethod && !/^[A-Za-z0-9]{1,10}$/.test(paymentMethod)) {
      return json({ success: false, error: "paymentMethod format is invalid" }, 400);
    }

    const orderQuery = new URLSearchParams({
      select: "id,user_id,amount,currency,product_details,customer_email,customer_phone,status,expires_at",
      id: `eq.${input.orderId}`,
      user_id: `eq.${userId}`,
      limit: "1",
    });
    const orderResponse = await dbRequest(supabaseUrl, `duitku_payment_orders?${orderQuery.toString()}`);
    if (!orderResponse.ok) {
      console.error("Could not load payment order:", await orderResponse.text());
      return json({ success: false, error: "Could not load payment order" }, 500);
    }

    const orderRows: unknown = await orderResponse.json();
    if (!Array.isArray(orderRows) || !isRecord(orderRows[0])) {
      return json({ success: false, error: "Payment order not found" }, 404);
    }
    const order = orderRows[0];

    if (order.status !== "pending") {
      return json({ success: false, error: "Payment order is not payable", orderStatus: order.status }, 409);
    }

    if (order.expires_at) {
      const expiresAt = Date.parse(String(order.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return json({ success: false, error: "Payment order has expired" }, 409);
      }
    }

    const amount = toSafeAmount(order.amount);
    const productDetails = typeof order.product_details === "string" ? order.product_details.trim() : "";
    const email = typeof order.customer_email === "string" ? order.customer_email.trim() : "";
    const phoneNumber = typeof order.customer_phone === "string" ? order.customer_phone.trim() : "";

    if (
      amount === null ||
      order.currency !== "IDR" ||
      !productDetails ||
      productDetails.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      console.error("Trusted payment order contains invalid invoice data", { orderId: input.orderId });
      return json({ success: false, error: "Payment order data is invalid" }, 422);
    }
    if (phoneNumber && !/^\+?[0-9]{8,20}$/.test(phoneNumber)) {
      return json({ success: false, error: "Payment order phone number is invalid" }, 422);
    }

    const existing = await loadActiveTransaction(supabaseUrl, input.orderId);
    if (existing) {
      if (existing.status === "paid") {
        return json({ success: false, error: "Payment order has already been paid" }, 409);
      }
      if (typeof existing.payment_url === "string" && validPaymentUrl(existing.payment_url)) {
        return json({ success: true, data: transactionResponse(existing), reused: true });
      }
      return json({
        success: false,
        error: "An invoice request is already in progress or requires reconciliation",
        transactionId: existing.id,
      }, 409);
    }

    const merchantCode = requiredEnv("DUITKU_MERCHANT_CODE");
    const merchantKey = requiredEnv("DUITKU_MERCHANT_KEY");
    const callbackUrl = requiredEnv("DUITKU_CALLBACK_URL");
    const returnUrl = requiredEnv("DUITKU_RETURN_URL");
    const environment = (Deno.env.get("DUITKU_ENV") ?? "sandbox").toLowerCase();

    if (environment !== "sandbox" && environment !== "production") {
      return json({ success: false, error: "DUITKU_ENV must be sandbox or production" }, 500);
    }
    for (const [name, value] of [["DUITKU_CALLBACK_URL", callbackUrl], ["DUITKU_RETURN_URL", returnUrl]]) {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") {
        return json({ success: false, error: `${name} must use HTTPS` }, 500);
      }
    }

    const merchantOrderId = `TRX-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    const insertResponse = await dbRequest(supabaseUrl, "duitku_transactions?select=id,merchant_order_id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        order_id: input.orderId,
        user_id: userId,
        merchant_order_id: merchantOrderId,
        merchant_code: merchantCode,
        amount,
        currency: "IDR",
        product_details: productDetails,
        customer_email: email,
        customer_phone: phoneNumber || null,
        payment_method: paymentMethod || null,
        status: "pending",
      }),
    });

    if (!insertResponse.ok) {
      const detail = await insertResponse.text();
      console.error("Could not initialize Duitku transaction:", detail);
      const raced = await loadActiveTransaction(supabaseUrl, input.orderId);
      if (raced?.status === "pending" && typeof raced.payment_url === "string" && validPaymentUrl(raced.payment_url)) {
        return json({ success: true, data: transactionResponse(raced), reused: true });
      }
      return json({
        success: false,
        error: "A payment attempt already exists or the transaction could not be initialized",
      }, 409);
    }

    const createdRows: unknown = await insertResponse.json();
    if (!Array.isArray(createdRows) || !isRecord(createdRows[0]) || typeof createdRows[0].id !== "string") {
      return json({ success: false, error: "Transaction initialization returned an invalid response" }, 500);
    }
    transactionId = createdRows[0].id;

    const payload: Record<string, unknown> = {
      paymentAmount: amount,
      merchantOrderId,
      productDetails,
      email,
      callbackUrl,
      returnUrl,
    };
    if (phoneNumber) payload.phoneNumber = phoneNumber;
    if (paymentMethod) payload.paymentMethod = paymentMethod;

    if (order.expires_at) {
      const remainingMinutes = Math.ceil((Date.parse(String(order.expires_at)) - Date.now()) / 60000);
      payload.expiryPeriod = Math.min(10080, Math.max(1, remainingMinutes));
    }

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
      // A timeout/network error is ambiguous: Duitku may have created the invoice.
      // Keep the row pending so a retry cannot silently create a second invoice.
      await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
        method: "PATCH",
        body: JSON.stringify({ failure_reason: "Duitku request outcome is unknown; reconcile before retrying" }),
      });
      console.error("Duitku request outcome is unknown:", error instanceof Error ? error.message : "Unknown error");
      return json({
        success: false,
        error: "Duitku request outcome is unknown; transaction requires reconciliation",
        transactionId,
      }, 502);
    }

    const responseText = await duitkuResponse.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }

    if (!duitkuResponse.ok) {
      if (duitkuResponse.status >= 500) {
        await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
          method: "PATCH",
          body: JSON.stringify({ failure_reason: "Duitku server error; reconcile before retrying" }),
        });
        return json({ success: false, error: "Duitku server error; transaction requires reconciliation", transactionId }, 502);
      }

      await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          duitku_status_code: isRecord(responseData) ? String(responseData.statusCode ?? "") : null,
          duitku_status_message: isRecord(responseData) ? String(responseData.statusMessage ?? "") : null,
          failure_reason: "Duitku rejected the invoice request",
        }),
      });
      return json({ success: false, error: "Duitku invoice request was rejected" }, 502);
    }

    if (isRecord(responseData) && responseData.statusCode !== "00") {
      await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          duitku_status_code: String(responseData.statusCode ?? ""),
          duitku_status_message: String(responseData.statusMessage ?? ""),
          failure_reason: "Duitku did not create the invoice",
        }),
      });
      return json({
        success: false,
        error: "Duitku invoice request failed",
        duitkuStatusCode: responseData.statusCode ?? null,
      }, 502);
    }

    if (
      !isRecord(responseData) ||
      responseData.statusCode !== "00" ||
      typeof responseData.reference !== "string" ||
      !responseData.reference ||
      !validPaymentUrl(responseData.paymentUrl)
    ) {
      // A malformed success response may still represent a created invoice.
      // Keep the transaction locked for manual reconciliation.
      await dbRequest(supabaseUrl, `duitku_transactions?id=eq.${transactionId}`, {
        method: "PATCH",
        body: JSON.stringify({ failure_reason: "Duitku response could not be validated; reconcile before retrying" }),
      });
      return json({
        success: false,
        error: "Duitku response could not be validated; transaction requires reconciliation",
        transactionId,
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
        expires_at: order.expires_at ?? null,
      }),
    });

    if (!updateResponse.ok) {
      console.error("Invoice created but transaction update failed:", await updateResponse.text());
      return json({
        success: false,
        error: "Invoice was created but could not be saved; transaction requires reconciliation",
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
        amount,
        currency: "IDR",
        status: "pending",
      },
    });
  } catch (error) {
    console.error("duitku-create-invoice error:", error instanceof Error ? error.message : "Unknown error");
    return json({
      success: false,
      error: "Internal server error",
      ...(transactionId ? { transactionId } : {}),
    }, 500);
  }
});
