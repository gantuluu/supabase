import {
  isRecord,
  verifyPoketoSignature,
} from "../_shared/poketo.ts";

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

function safeAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 10000
    ? value
    : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response("Method not allowed", 405);

  try {
    const rawBody = await req.text();
    if (rawBody.length > 65536) return response("Webhook payload too large", 413);

    const signature = req.headers.get("Poketo-Signature") ?? "";
    const webhookSecret = requiredEnv("POKETO_WEBHOOK_SECRET");
    if (!await verifyPoketoSignature(rawBody, signature, webhookSecret)) {
      console.warn("Rejected Poketo webhook: invalid or stale signature");
      return response("Invalid signature", 400);
    }

    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return response("Invalid JSON body", 400);
    }
    if (!isRecord(event) || typeof event.id !== "string" || typeof event.type !== "string") {
      return response("Invalid event envelope", 400);
    }

    const eventId = req.headers.get("Poketo-Event-Id") ?? "";
    const eventType = req.headers.get("Poketo-Event") ?? "";
    if (
      !eventId ||
      eventId.length > 128 ||
      event.id !== eventId ||
      event.type !== eventType
    ) {
      return response("Event header mismatch", 400);
    }

    const environment = typeof event.environment === "string" ? event.environment : "";
    const invoice = isRecord(event.data) ? event.data : null;
    const isInvoiceEvent = eventType.startsWith("invoice.");
    const invoiceId = invoice && typeof invoice.id === "string" ? invoice.id : null;
    const referenceId = invoice && typeof invoice.referenceId === "string" ? invoice.referenceId : null;
    const amount = invoice ? safeAmount(invoice.amount) : null;
    const currency = invoice && typeof invoice.currency === "string" ? invoice.currency : null;
    const invoiceStatus = invoice && typeof invoice.status === "string" ? invoice.status : null;

    if (isInvoiceEvent) {
      if (
        environment !== "sandbox" ||
        !invoiceId ||
        !referenceId ||
        amount === null ||
        currency !== "IDR" ||
        !invoiceStatus
      ) {
        return response("Invalid sandbox invoice event", 400);
      }
      if (
        eventType === "invoice.paid" && invoiceStatus !== "paid" ||
        eventType === "invoice.expired" && invoiceStatus !== "expired" ||
        eventType === "invoice.cancelled" && invoiceStatus !== "cancelled" ||
        eventType === "invoice.refunded" && invoiceStatus !== "refunded"
      ) {
        return response("Invoice event status mismatch", 400);
      }
    } else if (environment !== "sandbox") {
      return response("Unexpected Poketo environment", 400);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const rpcResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/apply_poketo_webhook_event`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          p_event_id: eventId,
          p_event_type: eventType,
          p_environment: environment,
          p_invoice_id: invoiceId,
          p_reference_id: referenceId,
          p_amount: amount,
          p_currency: currency,
          p_invoice_status: invoiceStatus,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!rpcResponse.ok) {
      console.error("Could not persist Poketo webhook:", await rpcResponse.text());
      return response("Temporary database error", 500);
    }

    const result: unknown = await rpcResponse.json();
    if (!isRecord(result) || typeof result.outcome !== "string") {
      return response("Invalid reconciliation response", 500);
    }

    switch (result.outcome) {
      case "paid":
      case "already_paid":
      case "already_refunded":
      case "expired":
      case "cancelled":
      case "refunded":
      case "ignored":
      case "duplicate":
        return response("OK", 200);
      case "not_found":
        return response("Payment order not found", 404);
      case "transaction_mismatch":
      case "invalid_event":
        return response("Payment event validation failed", 400);
      default:
        console.error("Unexpected Poketo webhook outcome:", result.outcome);
        return response("Could not reconcile webhook", 500);
    }
  } catch (error) {
    console.error("poketo-webhook error:", error instanceof Error ? error.message : "Unknown error");
    return response("Internal server error", 500);
  }
});
