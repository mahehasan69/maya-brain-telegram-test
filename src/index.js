
const BRAIN_URL = "https://maya-brain-v1.mahehasan69.workers.dev";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
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
        return json({ error: "Unauthorized" }, 401);
      }

      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ error: "Telegram configuration is incomplete" }, 503);
      }

      try {
        const result = await telegram(env, "setWebhook", {
          url: `${url.origin}/telegram`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: false
        });

        return json({ ok: true, webhook: result });
      } catch {
        return json({ error: "Unable to configure Telegram webhook" }, 502);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (
        !env.TELEGRAM_BOT_TOKEN ||
        !env.TELEGRAM_WEBHOOK_SECRET ||
        !env.BRAIN_API_SECRET ||
        !env.TEST_STATE ||
        !env.TEST_OWNER_TELEGRAM_ID
      ) {
        return json({ error: "Worker configuration is incomplete" }, 503);
      }

      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return json({ error: "Unauthorized" }, 401);
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      try {
        await handleUpdate(update, env);
      } catch (error) {
        // Do not log tokens, secrets, message content, or personal data.
        console.error("Telegram update handling failed:", String(error));
      }

      // Return success to Telegram to avoid endless webhook retries.
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
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

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed`);
  }

  return data.result;
}

async function sendText(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000)
  });
}

async function callBrain(env, path, body) {
  const response = await fetch(`${BRAIN_URL}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.BRAIN_API_SECRET}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok !== true) {
    throw new Error(`Brain API request failed: ${response.status}`);
  }

  return data;
}

function stateKey(telegramId) {
  return `maya-test-user:${telegramId}`;
}

async function getState(env, telegramId) {
  const raw = await env.TEST_STATE.get(stateKey(telegramId));

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleUpdate(update, env) {
  const message = update?.message;

  if (!message || message.chat?.type !== "private") return;
  if (typeof message.text !== "string") return;
  if (!message.from || !message.chat?.id) return;

  const telegramId = String(message.from.id);

  // This is a private test bot for one configured owner.
  if (telegramId !== String(env.TEST_OWNER_TELEGRAM_ID)) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const userId = `maya-telegram-test:${telegramId}`;

  if (command === "/start") {
    await sendText(
      env,
      chatId,
      "Hi! This is the private Maya Brain test bot.\n\n" +
      "Before chatting, choose whether you allow message retention for replies.\n\n" +
      "• /consent — allow message retention for the test; AI-training consent remains NO.\n" +
      "• /no — decline or withdraw retention consent and stop using the bot.\n\n" +
      "History and long-term memory remain disabled by default. " +
      "This test does not offer a data-deletion command."
    );
    return;
  }

  if (command === "/no") {
    try {
      // Record the user's choice in the Brain database first.
      await callBrain(env, "/onboarding", {
        userId,
        retentionConsent: false,
        trainingConsent: false
      });

      await env.TEST_STATE.delete(stateKey(telegramId));

      await sendText(
        env,
        chatId,
        "Retention consent is now disabled. The bot will not process further messages until you consent again. Previously stored data has not been deleted."
      );
    } catch {
      await sendText(
        env,
        chatId,
        "I couldn't update your consent right now. Please try /no again later."
      );
    }
    return;
  }

  if (command === "/consent") {
    try {
      const result = await callBrain(env, "/onboarding", {
        userId,
        retentionConsent: true,
        trainingConsent: false
      });

      if (!result.conversationId) {
        throw new Error("Conversation was not created");
      }

      await env.TEST_STATE.put(
        stateKey(telegramId),
        JSON.stringify({
          consented: true,
          conversationId: result.conversationId
        })
      );

      await sendText(
        env,
        chatId,
        "Consent saved. AI-training consent is NO. History and long-term memory are still disabled. You can now send me a message."
      );
    } catch {
      await sendText(
        env,
        chatId,
        "I couldn't finish setup. Please try /consent again later."
      );
    }
    return;
  }

  if (command.startsWith("/")) {
    await sendText(
      env,
      chatId,
      "Commands:\n/start — show information\n/consent — allow message retention for replies\n/no — withdraw retention consent"
    );
    return;
  }

  const state = await getState(env, telegramId);

  if (!state?.consented || !state?.conversationId) {
    await sendText(
      env,
      chatId,
      "Please read the information first using /start, then send /consent if you agree."
    );
    return;
  }

  try {
    const result = await callBrain(env, "/reply", {
      userId,
      conversationId: state.conversationId,
      message: text
    });

    if (typeof result.reply !== "string" || !result.reply.trim()) {
      throw new Error("Brain returned an empty reply");
    }

    await sendText(env, chatId, result.reply);
  } catch {
    await sendText(
      env,
      chatId,
      "Maya Brain couldn't generate a reply right now. Please try again shortly."
    );
  }
}
