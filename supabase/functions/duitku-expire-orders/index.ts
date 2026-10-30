import { isRecord, safeEqual } from "../_shared/duitku.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const expectedSecret = requiredEnv("PAYMENT_EXPIRY_SECRET");
    const receivedSecret = req.headers.get("x-expiry-secret") ?? "";
    if (!receivedSecret || !safeEqual(expectedSecret, receivedSecret)) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const rpcResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/expire_pending_payment_orders`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ p_as_of: new Date().toISOString() }),
      },
    );

    if (!rpcResponse.ok) {
      console.error("Could not expire payment orders:", await rpcResponse.text());
      return json({ success: false, error: "Could not expire payment orders" }, 500);
    }

    const expiredCount: unknown = await rpcResponse.json();
    if (typeof expiredCount !== "number" || !Number.isInteger(expiredCount) || expiredCount < 0) {
      console.error("Payment expiry RPC returned an invalid count");
      return json({ success: false, error: "Invalid expiry response" }, 500);
    }

    return json({ success: true, expiredOrders: expiredCount });
  } catch (error) {
    console.error("duitku-expire-orders error:", error instanceof Error ? error.message : "Unknown error");
    return json({ success: false, error: "Internal server error" }, 500);
  }
});
