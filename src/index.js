
const BRAIN_URL = "https://maya-brain-v1.mahehassan69.workers.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "maya-brain-telegram-test",
        status: "online"
      });
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      if (!env.WEBHOOK_SETUP_KEY ||
          request.headers.get("X-Setup-Key") !== env.WEBHOOK_SETUP_KEY) {
        return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      }

      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "Missing Telegram secrets" }, { status: 500 });
      }

      const response = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"]
      });

      return Response.json({ ok: true, telegram: response });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN ||
          !env.TELEGRAM_WEBHOOK_SECRET ||
          !env.TEST_OWNER_TELEGRAM_ID) {
        return Response.json({ error: "Configuration incomplete" }, { status: 500 });
      }

      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
          env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ error: "Unauthorized webhook" }, { status: 401 });
      }

      const update = await request.json();
      await handleUpdate(update, env);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
};

async function telegram(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error("Telegram API request failed");
  }

  return result;
}

async function sendText(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message?.from || !message.chat || message.chat.type !== "private") return;

  // Restrict this test bot to your own Telegram account.
  if (String(message.from.id) !== String(env.TEST_OWNER_TELEGRAM_ID)) return;

  const chatId = message.chat.id;
  const userId = `maya-telegram-test:${message.from.id}`;

  if (!message.text) {
    await sendText(env, chatId, "Bro, for this test, please send a text message.");
    return;
  }

  const text = message.text.trim();

  // Consent is explicit and kept in Cloudflare KV.
  if (text === "/start") {
    await sendText(
      env,
      chatId,
      "Hi! I'm Maya Brain Test 🧠\n\nBefore chatting, please choose:\n\n/consent — allow this test to send your messages to Maya Brain for replies.\n/no — keep the test disabled.\n\nYour messages may be processed by the configured AI provider. This test does not enable long-term memory."
    );
    return;
  }

  if (text === "/no") {
    await env.TEST_STATE?.delete(userId);
    await sendText(env, chatId, "Okay. The test is disabled. Send /start if you want to review the choices again.");
    return;
  }

  if (text === "/consent") {
    if (!env.TEST_STATE) {
      await sendText(env, chatId, "Setup incomplete: the TEST_STATE KV namespace is not configured yet.");
      return;
    }

    await env.TEST_STATE.put(userId, "consented");
    await sendText(env, chatId, "Consent saved for this test. Send a message to chat with Maya.");
    return;
  }

  if (text.startsWith("/")) {
    await sendText(env, chatId, "Commands: /start, /consent, /no");
    return;
  }

  if (!env.TEST_STATE || await env.TEST_STATE.get(userId) !== "consented") {
    await sendText(env, chatId, "Please send /start, then /consent before chatting.");
    return;
  }

  if (!env.BRAIN_API_SECRET) {
    await sendText(env, chatId, "The brain connection is not configured yet.");
    return;
  }

  // Unique conversation ID for this test chat.
  const conversationId = `telegram-test-${message.from.id}`;

  try {
    const response = await fetch(`${BRAIN_URL}/reply`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.BRAIN_API_SECRET}`,
        "Content-Type": "application/json"
      }, 
      body: JSON.stringify({
        userId,
        conversationId,
        message: text
