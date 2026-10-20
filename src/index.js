
const BRAIN_URL = "https://maya-brain-v1.mahehassan69.workers.dev";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "maya-brain-telegram-test",
        status: "online"
      });
    }

    if (request.method === "POST" && url.pathname === "/setup") {
      if (
        !env.WEBHOOK_SETUP_KEY ||
        request.headers.get("X-Setup-Key") !== env.WEBHOOK_SETUP_KEY
      ) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false, error: "Telegram secrets are missing" }, 500);
      }

      try {
        const result = await telegram(env, "setWebhook", {
          url: `${url.origin}/telegram`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: false
        });

        return json({ ok: true, webhook_set: result.ok });
      } catch {
        return json({ ok: false, error: "Webhook setup failed" }, 502);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (
        !env.TELEGRAM_BOT_TOKEN ||
        !env.TELEGRAM_WEBHOOK_SECRET ||
        !env.TEST_OWNER_TELEGRAM_ID ||
        !env.TEST_STATE ||
        !env.BRAIN_API_SECRET
      ) {
        return json({ ok: false, error: "Worker configuration is incomplete" }, 500);
      }

      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return json({ ok: false, error: "Unauthorized webhook" }, 401);
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      try {
        await handleUpdate(update, env);
        return json({ ok: true });
      } catch (error) {
        console.error("Update handling failed:", String(error).slice(0, 200));
        return json({ ok: true });
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
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

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} request failed`);
  }

  return result;
}

async function sendText(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000)
  });
}

async function handleUpdate(update, env) {
  const message = update.message;

  if (
    !message?.from ||
    !message.chat ||
    message.chat.type !== "private"
  ) {
    return;
  }

  // This test bot is restricted to the configured owner.
  if (String(message.from.id) !== String(env.TEST_OWNER_TELEGRAM_ID)) {
    return;
  }

  const chatId = message.chat.id;
  const userId = `maya-telegram-test:${message.from.id}`;

  if (typeof message.text !== "string") {
    await sendText(env, chatId, "Please send a text message for this test.");
    return;
  }

  const text = message.text.trim();

  if (text === "/start") {
    await sendText(
      env,
      chatId,
      "Hi! I'm Maya Brain Test 🧠\n\n" +
      "Before using this test, please read the choices:\n\n" +
      "/consent — allow your messages to be sent to Maya Brain for replies.\n" +
      "/no — decline or withdraw consent and disable this test.\n\n" +
      "Messages may be processed by the configured AI provider. " +
      "This command does not enable long-term memory."
    );
    return;
  }

  if (text === "/no") {
    await env.TEST_STATE.delete(userId);
    await sendText(
      env,
      chatId,
      "The test is disabled. Send /start if you want to review the choices again."
    );
    return;
  }

  if (text === "/consent") {
    await env.TEST_STATE.put(userId, "consented");
    await sendText(
      env,
      chatId,
      "Your test consent choice has been saved. Send a message to try the brain."
    );
    return;
  }

  if (text.startsWith("/")) {
    await sendText(env, chatId, "Available commands: /start, /consent, /no");
    return;
  }

  const consent = await env.TEST_STATE.get(userId);

  if (consent !== "consented") {
    await sendText(env, chatId, "Please send /start, then /consent before chatting.");
    return;
  }

  const conversationId = `telegram-test-${message.from.id}`;

  try {
    const response = await fetch(`${BRAIN_URL}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.BRAIN_API_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId,
        conversationId,
        message: text
      })
    });

    const result = await response.json().catch(() => ({}));

    if (
      !response.ok ||
      result.ok !== true ||
      typeof result.reply !== "string"
    ) {
      console.error("Brain API returned an unsuccessful response:", response.status);
      await sendText(
        env,
        chatId,
        "Maya Brain couldn't reply. The brain's consent or conversation setup may need attention."
      );
      return;
    }

    await sendText(env, chatId, result.reply);
  } catch (error) {
    console.error("Brain request failed:", String(error).slice(0, 200));
    await sendText(env, chatId, "I couldn't reach Maya Brain. Please try again later.");
  }
}
