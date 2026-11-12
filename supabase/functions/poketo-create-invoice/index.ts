import {
  isRecord,
  isValidPoketoPaymentUrl,
} from "../_shared/poketo.ts";

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
    if (isRecord(parsed) && typeof parsed.default === "string" && parsed.default) {
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
    headers: { apikey: publishableKey, Authorization: `Bearer ${match[1]}` },
  });
  if (!response.ok) return null;

  const user: unknown = await response.json();
  return isRecord(user) && typeof user.id === "string" ? user.id : null;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeAmount(value: unknown): number | null {
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 10000
    ? amount
    : null;
}

function transactionResponse(row: Record<string, unknown>) {
  return {
    transactionId: row.id,
    invoiceId: row.invoice_id,
    referenceId: row.reference_id,
    paymentUrl: row.payment_url,
    amount: safeAmount(row.amount),
    currency: row.currency,
    status: row.status,
  };
}

async function loadPendingTransaction(
  supabaseUrl: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const query = new URLSearchParams({
    select: "id,reference_id,idempotency_key,invoice_id,payment_url,amount,currency,status",
    order_id: `eq.${orderId}`,
    status: "eq.pending",
    limit: "1",
  });
  const response = await dbRequest(supabaseUrl, `poketo_transactions?${query}`);
  if (!response.ok) throw new Error("Could not check existing Poketo transaction");
  const rows: unknown = await response.json();
  return Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let transactionId: string | null = null;

  try {
    const secretKey = requiredEnv("POKETO_SECRET_KEY");
    if (!secretKey.startsWith("sk_test_")) {
      return json({ success: false, error: "Only a Poketo sandbox secret key (sk_test_) is allowed" }, 500);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const userId = await getAuthenticatedUserId(req, supabaseUrl);
    if (!userId) return json({ success: false, error: "Unauthorized" }, 401);

    const input: unknown = await req.json().catch(() => null);
    if (!isRecord(input) || !validUuid(input.orderId)) {
      return json({ success: false, error: "A valid orderId is required" }, 400);
    }

    const orderQuery = new URLSearchParams({
      select: "id,user_id,source_order_id,amount,currency,title,description,customer_name,customer_email,customer_phone,status,expires_at",
      id: `eq.${input.orderId}`,
      user_id: `eq.${userId}`,
      limit: "1",
    });
    const orderResponse = await dbRequest(supabaseUrl, `poketo_payment_orders?${orderQuery}`);
    if (!orderResponse.ok) {
      console.error("Could not load Poketo payment order:", await orderResponse.text());
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

    if (
      typeof order.source_order_id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(order.source_order_id) ||
      typeof order.title !== "string" ||
      !order.title.trim() ||
      order.title.length > 255 ||
      typeof order.customer_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.customer_email)
    ) {
      return json({ success: false, error: "Trusted payment order data is invalid" }, 422);
    }

    const amount = safeAmount(order.amount);
    if (amount === null || order.currency !== "IDR") {
      return json({ success: false, error: "Poketo requires an IDR amount of at least Rp 10.000" }, 422);
    }

    let expiresInMinutes: number | undefined;
    if (order.expires_at) {
      const expiresAt = Date.parse(String(order.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return json({ success: false, error: "Payment order has expired" }, 409);
      }
      const remainingMinutes = Math.floor((expiresAt - Date.now()) / 60000);
      if (remainingMinutes < 5) {
        return json({ success: false, error: "Payment order expires too soon for Poketo's minimum invoice lifetime" }, 409);
      }
      expiresInMinutes = Math.min(43200, remainingMinutes);
    }

    const phone = typeof order.customer_phone === "string" ? order.customer_phone.trim() : "";
    if (phone && !/^\+?[0-9]{8,20}$/.test(phone)) {
      return json({ success: false, error: "Trusted customer phone number is invalid" }, 422);
    }

    let transaction = await loadPendingTransaction(supabaseUrl, String(order.id));
    if (transaction?.payment_url && isValidPoketoPaymentUrl(transaction.payment_url)) {
      return json({ success: true, data: transactionResponse(transaction), reused: true });
    }
    if (transaction && typeof transaction.id === "string") {
      transactionId = transaction.id;
    } else {
      const referenceId = order.source_order_id;
      const idempotencyKey = `poketo-${referenceId}`;
      const insertResponse = await dbRequest(supabaseUrl, "poketo_transactions?select=id,reference_id,idempotency_key", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          order_id: order.id,
          reference_id: referenceId,
          idempotency_key: idempotencyKey,
          amount,
          currency: "IDR",
          environment: "sandbox",
          status: "pending",
        }),
      });

      if (!insertResponse.ok) {
        const raced = await loadPendingTransaction(supabaseUrl, String(order.id));
        if (raced && typeof raced.id === "string") {
          transaction = raced;
          transactionId = raced.id;
          if (raced.payment_url && isValidPoketoPaymentUrl(raced.payment_url)) {
            return json({ success: true, data: transactionResponse(raced), reused: true });
          }
        } else {
          console.error("Could not initialize Poketo transaction:", await insertResponse.text());
          return json({ success: false, error: "A payment attempt already exists or could not be initialized" }, 409);
        }
      } else {
        const rows: unknown = await insertResponse.json();
        if (!Array.isArray(rows) || !isRecord(rows[0]) || typeof rows[0].id !== "string") {
          return json({ success: false, error: "Transaction initialization returned an invalid response" }, 500);
        }
        transactionId = rows[0].id;
        transaction = {
          ...rows[0],
          amount,
          currency: "IDR",
          status: "pending",
        };
      }
    }

    const idempotencyKey = typeof transaction?.idempotency_key === "string"
      ? transaction.idempotency_key
      : `poketo-${order.source_order_id}`;

    const customer: Record<string, unknown> = { email: order.customer_email };
    if (typeof order.customer_name === "string" && order.customer_name.trim()) {
      customer.name = order.customer_name.trim();
    }
    if (phone) customer.phone = phone;

    const payload: Record<string, unknown> = {
      referenceId: order.source_order_id,
      amount,
      title: order.title.trim(),
      customer,
      metadata: { orderId: order.id, sourceOrderId: order.source_order_id },
    };
    if (typeof order.description === "string" && order.description.trim()) {
      payload.description = order.description.trim();
    }
    if (expiresInMinutes !== undefined) payload.expiresInMinutes = expiresInMinutes;

    const redirectUrl = Deno.env.get("POKETO_REDIRECT_URL")?.trim();
    if (redirectUrl) {
      const parsedRedirect = new URL(redirectUrl);
      if (parsedRedirect.protocol !== "https:") {
        return json({ success: false, error: "POKETO_REDIRECT_URL must use HTTPS" }, 500);
      }
      payload.redirectUrl = redirectUrl;
    }

    let providerResponse: Response;
    try {
      providerResponse = await fetch("https://poketo.id/api/v1/invoices", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      console.error("Poketo invoice request outcome is unknown:", error instanceof Error ? error.message : "Unknown error");
      return json({
        success: false,
        error: "Poketo invoice request outcome is unknown; retry safely using the same order reference",
        transactionId,
      }, 502);
    }

    const responseText = await providerResponse.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }

    if (!providerResponse.ok) {
      const apiError = isRecord(responseData) && isRecord(responseData.error)
        ? responseData.error
        : null;
      console.error("Poketo invoice request failed:", {
        status: providerResponse.status,
        code: apiError?.code ?? "unknown_error",
      });
      return json({
        success: false,
        error: "Poketo invoice request failed",
        code: typeof apiError?.code === "string" ? apiError.code : "provider_error",
        retryAfter: providerResponse.headers.get("Retry-After"),
        transactionId,
      }, providerResponse.status === 429 || providerResponse.status >= 500 ? 503 : 502);
    }

    const invoice = isRecord(responseData) && isRecord(responseData.data)
      ? responseData.data
      : null;
    if (
      !invoice ||
      typeof invoice.id !== "string" ||
      invoice.referenceId !== order.source_order_id ||
      invoice.environment !== "sandbox" ||
      invoice.status !== "pending" ||
      safeAmount(invoice.amount) !== amount ||
      !isValidPoketoPaymentUrl(invoice.paymentUrl)
    ) {
      console.error("Poketo returned an invoice that failed validation", { transactionId });
      return json({
        success: false,
        error: "Poketo response could not be validated; reconcile the invoice before retrying",
        transactionId,
      }, 502);
    }

    const updateResponse = await dbRequest(
      supabaseUrl,
      `poketo_transactions?id=eq.${transactionId}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          invoice_id: invoice.id,
          payment_url: invoice.paymentUrl,
          provider_status: invoice.status,
          provider_payload: invoice,
          expires_at: typeof invoice.expiresAt === "string" ? invoice.expiresAt : null,
        }),
      },
    );

    if (!updateResponse.ok) {
      console.error("Poketo invoice created but local transaction update failed:", await updateResponse.text());
      return json({
        success: false,
        error: "Invoice was created but could not be saved; retry safely for the same reference",
        transactionId,
      }, 500);
    }

    return json({
      success: true,
      data: {
        transactionId,
        invoiceId: invoice.id,
        referenceId: invoice.referenceId,
        paymentUrl: invoice.paymentUrl,
        amount,
        currency: "IDR",
        status: "pending",
      },
    });
  } catch (error) {
    console.error("poketo-create-invoice error:", error instanceof Error ? error.message : "Unknown error");
    return json({
      success: false,
      error: "Internal server error",
      ...(transactionId ? { transactionId } : {}),
    }, 500);
  }
});
