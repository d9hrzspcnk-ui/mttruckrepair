// MT Truck & Trailer Repair — AI proxy Worker
// Keeps the Anthropic API key AND Twilio credentials on the server. The app
// posts a request; this Worker adds the secret credentials and forwards it.
//
// Required secrets (set in dashboard, NOT in this code):
//   ANTHROPIC_API_KEY
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_MESSAGING_SERVICE_SID
//   CLOVER_API_TOKEN      -> Ecommerce/Hosted Checkout API token from Clover
//                            (Account & Setup -> Ecommerce API tokens)
//   CLOVER_MERCHANT_ID    -> Merchant ID shown on that same Clover page
//   CLOVER_WEBHOOK_SECRET  -> Signing secret from Clover's Hosted Checkout webhook
//                             setup (Settings -> Ecommerce -> Hosted Checkout ->
//                             Webhook URL -> Generate). Used to verify that payment
//                             webhooks really came from Clover, not to send anything.
//
// Only requests coming from the shop's own site are allowed (Origin check),
// which stops random people from using this as a free Claude/Twilio proxy.
// The one exception is /clover-webhook, which Clover's own servers call
// directly (no Origin header) and which is authenticated by signature instead.
//
// Routes:
//   POST /                -> forwards body as-is to Anthropic's /v1/messages (unchanged)
//   POST /send-sms         -> sends a text via Twilio. Body: { "to": "+1XXXXXXXXXX", "body": "message text" }
//   POST /create-checkout  -> creates a Clover Hosted Checkout session for an exact invoice
//                             amount so the customer never has to type it in. Body is either
//                             a single invoice { "amount": 123.45, "invoiceNum": "3112" } or
//                             several bundled into one charge:
//                             { "invoices": [{ "num": "3112", "amount": 123.45 }, ...] }.
//                             Returns { success, href } where href is the one-time Clover
//                             checkout page (expires in ~15 min, which is fine since it's
//                             created the moment the customer taps Pay). Also remembers
//                             which invoice(s) this checkout session was for, so the
//                             webhook below can mark them paid automatically.
//   POST /clover-webhook   -> called by Clover when a Hosted Checkout payment completes.
//                             Verifies the Clover-Signature header, looks up which
//                             invoice(s) that checkout session was for, and marks them
//                             paid (or partial, for a partial payment) in the shop's data.
//
// Cron Trigger (set in dashboard under Triggers - not in this code):
//   Runs sendInvoiceReminders() once a day. Texts a reminder for every
//   invoice that's Unpaid/Partial, has a phone on file, hasn't opted out of
//   invoice messages, and hasn't been reminded in 7+ days - up to 4 reminders
//   per invoice. After the 4th, it stops and flags the invoice (reminderCapped)
//   so the office sees it needs a personal follow-up instead of another text.

const ALLOWED_ORIGINS = [
  "https://mttruckandtrailerrepair.com",
  "https://www.mttruckandtrailerrepair.com",
  "https://d9hrzspcnk-ui.github.io"
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    // Clover calls this directly (no Origin header) and is authenticated by
    // signature instead, so it must be handled before the origin check below.
    if (url.pathname === "/clover-webhook") {
      return handleCloverWebhook(request, env);
    }

    // Only allow calls from the shop's own site
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: "Forbidden origin" }), {
        status: 403,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/send-sms") {
      return handleSendSms(request, env, origin);
    }

    if (url.pathname === "/create-checkout") {
      return handleCreateCheckout(request, env, origin);
    }

    return handleAnthropic(request, env, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendInvoiceReminders(env));
  }
};

async function handleAnthropic(request, env, origin) {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "Server key not configured" }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  let body;
  try {
    body = await request.text();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Bad request body" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: body
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Upstream error", detail: String(e) }), {
      status: 502,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }
}

async function handleSendSms(request, env, origin) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_MESSAGING_SERVICE_SID) {
    return new Response(JSON.stringify({ success: false, error: "Twilio not configured" }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "Bad request body" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  const to = ((payload && payload.to) || "").trim();
  const body = ((payload && payload.body) || "").trim();
  if (!to || !body) {
    return new Response(JSON.stringify({ success: false, error: "Missing 'to' or 'body'" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  try {
    const result = await sendTwilioSms(env, to, body);
    if (result.ok) {
      return new Response(JSON.stringify({ success: true, sid: result.sid, status: result.status }), {
        status: 200,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
      });
    } else {
      return new Response(JSON.stringify({ success: false, code: result.code, message: result.message }), {
        status: result.httpStatus,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "Upstream error", detail: String(e) }), {
      status: 502,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }
}

async function handleCreateCheckout(request, env, origin) {
  if (!env.CLOVER_API_TOKEN || !env.CLOVER_MERCHANT_ID) {
    return new Response(JSON.stringify({ success: false, error: "Clover not configured" }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  const cloverToken = env.CLOVER_API_TOKEN;
  const cloverMerchantId = env.CLOVER_MERCHANT_ID;

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "Bad request body" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  // Two request shapes: a single invoice ({ amount, invoiceNum }), or several
  // bundled into one charge ({ invoices: [{ num, amount }, ...] }).
  let items;
  if (Array.isArray(payload && payload.invoices) && payload.invoices.length) {
    items = payload.invoices.map(function (i) {
      return { num: String((i && i.num) || "").slice(0, 40), amount: parseFloat(i && i.amount) };
    });
  } else {
    items = [{ num: String((payload && payload.invoiceNum) || "").slice(0, 40), amount: parseFloat(payload && payload.amount) }];
  }
  if (!items.length || items.some(function (i) { return !i.num || !i.amount || i.amount <= 0; })) {
    return new Response(JSON.stringify({ success: false, error: "Invalid amount" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }

  const invoiceNums = items.map(function (i) { return i.num; });
  const base = "https://mttruckandtrailerrepair.com/shop.html?inv=" + encodeURIComponent(invoiceNums[0]);
  const lineItems = items.map(function (i) {
    return { name: "Invoice #" + i.num, price: Math.round(i.amount * 100), unitQty: 1 };
  });

  // Clover requires a non-null customer object, but we deliberately leave it
  // empty rather than pre-filling name/email: Clover locks any field that
  // arrives pre-filled, and the shop wants customers to be able to type in
  // whatever name/email is right for that particular payment.
  const customer = {};

  try {
    const cloverRes = await fetch("https://api.clover.com/invoicingcheckoutservice/v1/checkouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": "Bearer " + cloverToken,
        "X-Clover-Merchant-Id": cloverMerchantId
      },
      body: JSON.stringify({
        customer: customer,
        shoppingCart: {
          lineItems: lineItems
        },
        redirectUrls: { success: base + "&paid=" + encodeURIComponent(invoiceNums.join(",")), failure: base }
      })
    });

    const data = await cloverRes.json();
    if (cloverRes.ok && data && data.href) {
      // Remember which invoice(s) this checkout was for, keyed by Clover's
      // session id, so the webhook can mark the right invoice(s) paid without
      // having to guess from Clover's side what the line items meant.
      const sessionId = data.checkoutSessionId || (data.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
      if (sessionId) {
        await sbPut("mttr-cksession-" + sessionId, { invoices: items, createdAt: new Date().toISOString() });
      }
      return new Response(JSON.stringify({ success: true, href: data.href }), {
        status: 200,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, error: (data && (data.message || data.error)) || "Clover error" }), {
      status: cloverRes.status || 502,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "Upstream error", detail: String(e) }), {
      status: 502,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" }
    });
  }
}

// Verifies Clover's "Clover-Signature: t=<timestamp>,v1=<hex>" header by
// recomputing the HMAC-SHA256 of "<timestamp>.<rawBody>" with the webhook
// secret and comparing it to v1. Without this, anyone who found the webhook
// URL could fake a "payment approved" call and get an invoice marked paid
// for free.
async function verifyCloverSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(",").forEach(function (kv) {
    const idx = kv.indexOf("=");
    if (idx > -1) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  });
  if (!parts.t || !parts.v1) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(parts.t + "." + rawBody));
  const sigHex = Array.from(new Uint8Array(sigBuf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  return sigHex === parts.v1;
}

// Called by Clover when a Hosted Checkout payment completes. Looks up which
// invoice(s) that checkout session was created for (saved in handleCreateCheckout)
// and marks them paid/partial. Always responds 200 once the signature checks
// out, even if there's nothing to do, since Clover retries on non-2xx responses.
async function handleCloverWebhook(request, env) {
  const rawBody = await request.text();
  const sig = request.headers.get("Clover-Signature");

  if (!env.CLOVER_WEBHOOK_SECRET || !(await verifyCloverSignature(rawBody, sig, env.CLOVER_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Bad body", { status: 400 });
  }

  if (!event || event.Type !== "PAYMENT" || event.Status !== "APPROVED" || !event.Data) {
    return new Response("OK", { status: 200 });
  }

  const mapping = await sbGet("mttr-cksession-" + event.Data);
  if (!mapping || !mapping.invoices || !mapping.invoices.length) {
    return new Response("OK", { status: 200 });
  }

  const invoices = await sbGet("mttr-inv");
  if (!invoices) return new Response("OK", { status: 200 });

  let changed = false;
  for (const item of mapping.invoices) {
    const inv = invoices.find(function (i) { return i && String(i.num) === String(item.num); });
    if (!inv) continue;
    if (!inv.payments) inv.payments = [];
    // Idempotency: Clover may deliver the same webhook more than once.
    if (inv.payments.some(function (p) { return p.cloverPaymentId === event.Id; })) continue;

    inv.payments.push({ amt: item.amount, method: "Clover", date: new Date().toLocaleString(), cloverPaymentId: event.Id });
    const paidTotal = inv.payments.reduce(function (s, p) { return s + (parseFloat(p.amt) || 0); }, 0);
    const total = parseFloat(inv.total) || 0;
    if (total > 0 && paidTotal >= total - 0.005) {
      inv.status = "Paid";
      inv.paidDate = new Date().toISOString().slice(0, 10);
    } else if (paidTotal > 0.005) {
      inv.status = "Partial";
    }
    if (!inv.history) inv.history = [];
    inv.history.push({ type: "clover-payment", at: new Date().toLocaleString(), amt: item.amount, status: "sent" });
    changed = true;
  }

  if (changed) await sbPut("mttr-inv", invoices);
  return new Response("OK", { status: 200 });
}

// Shared by the /send-sms route and the daily reminder cron job.
async function sendTwilioSms(env, to, body) {
  const form = new URLSearchParams();
  form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  form.set("To", to);
  form.set("Body", body);

  const auth = btoa(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN);

  const twilioRes = await fetch(
    "https://api.twilio.com/2010-04-01/Accounts/" + env.TWILIO_ACCOUNT_SID + "/Messages.json",
    {
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );
  const data = await twilioRes.json();
  return {
    ok: twilioRes.ok,
    httpStatus: twilioRes.status,
    sid: data.sid,
    status: data.status,
    code: data.code,
    message: data.message
  };
}

// ── Supabase (same store the app reads/writes from the browser) ──
const SB_URL = "https://hkiydqsvvorhvazpmkwb.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhraXlkcXN2dm9yaHZhenBta3diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTM5NjAsImV4cCI6MjA5NDcyOTk2MH0.LKEcb5SlZqT2RYQRx9Pr3gW6H3pVCboIXGrSjqq5f_0";

async function sbGet(key) {
  const r = await fetch(SB_URL + "/rest/v1/shop_data?key=eq." + key + "&select=value", {
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY }
  });
  const rows = await r.json();
  return rows[0] ? JSON.parse(rows[0].value) : null;
}

async function sbPut(key, value) {
  await fetch(SB_URL + "/rest/v1/shop_data", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key: key, value: JSON.stringify(value), updated_at: new Date().toISOString() })
  });
}

function toE164(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.charAt(0) === "1") return "+" + digits;
  return "";
}

async function sendInvoiceReminders(env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_MESSAGING_SERVICE_SID) return;

  const [invoices, customers, shop] = await Promise.all([
    sbGet("mttr-inv"),
    sbGet("mttr-cust"),
    sbGet("mttr-shop")
  ]);
  if (!invoices || !customers) return;

  const shopName = (shop && shop.name) || "MT Truck & Trailer Repair";
  const shopPhone = (shop && shop.phone) || "(909) 550-5331";
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const inv of invoices) {
    if (!inv || inv.deleted) continue;
    if (inv.status !== "Unpaid" && inv.status !== "Partial") continue;

    const reminderCount = inv.reminderCount || 0;
    if (reminderCount >= 4) continue;

    const paid = (inv.payments || []).reduce((s, p) => s + (parseFloat(p.amt) || 0), 0);
    const bal = (parseFloat(inv.total) || 0) - paid;
    if (bal <= 0.005) continue;

    const cust = customers.find(c => c && c.name === inv.customer);
    if (cust && cust.prefs && cust.prefs.inv === false) continue; // opted out of invoice messages

    const tel = toE164((cust && cust.phone) || inv.phone || "");
    if (!tel) continue;

    const lastAt = inv.lastReminderAt ? new Date(inv.lastReminderAt).getTime() : new Date(inv.date).getTime();
    if (isNaN(lastAt) || now - lastAt < SEVEN_DAYS_MS) continue;

    const nextCount = reminderCount + 1;
    const link = "https://mttruckandtrailerrepair.com/shop.html?inv=" + inv.num;
    const msg = "Reminder " + nextCount + "/4 from " + shopName + ": Invoice #" + inv.num +
      " - $" + bal.toFixed(2) + " still due. View/pay: " + link + " Questions? Call " + shopPhone;

    try {
      const result = await sendTwilioSms(env, tel, msg);
      if (result.ok) {
        inv.reminderCount = nextCount;
        inv.lastReminderAt = new Date().toISOString();
        if (!inv.history) inv.history = [];
        inv.history.push({ type: "auto-reminder", at: new Date().toLocaleString(), to: tel, status: "sent" });
        if (nextCount >= 4) inv.reminderCapped = true;
        changed = true;
      }
    } catch (e) {
      // Leave lastReminderAt untouched so it's retried on the next run.
    }
  }

  if (changed) await sbPut("mttr-inv", invoices);
}
