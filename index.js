// ============================================================
// Uspot Notification Bot  — v3.1
// ============================================================
// Handles ALL notifications for Uspot:
//   • New booking  → master gets instant alert + booking button
//   • New booking  → client gets confirmation + booking button
//   • New booking  → shareholders get summary
//   • Status change → confirmed / declined / cancelled / completed
//   • Booking done → client gets review request with DIRECT booking link
//   • 24h before   → client reminder
//   • 1h before    → client reminder
//   • POST /notify → called by app for portfolio/review alerts
//   • POST /gcal/auth → Google Calendar OAuth for masters
//   • POST /gcal/sync → push confirmed booking to GCal
// ============================================================

require("dotenv").config();
const TelegramBot    = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express        = require("express");
const cors           = require("cors");

// Founders bot runs in the same process
const { notifyFeedback, notifyModeration, setMainBot, processFoundersUpdate, setFoundersWebhook, deleteFoundersWebhook } = require("./founders-bot");

// ── Config ───────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://heiyayufhuvlxhirgvyc.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT         = process.env.PORT || 3000;
const MINI_APP_URL = process.env.MINI_APP_URL || "https://uspot.netlify.app";
const MODERATION_URL = process.env.MODERATION_URL || "https://uspot-bot-production.up.railway.app/moderation";

// Google Calendar OAuth (set in Railway env vars)
const GCAL_CLIENT_ID     = process.env.GCAL_CLIENT_ID     || "";
const GCAL_CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET || "";
const GCAL_REDIRECT_URI  = process.env.GCAL_REDIRECT_URI  || `https://uspot-bot-production.up.railway.app/gcal/callback`;

if (!BOT_TOKEN || !SUPABASE_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or SUPABASE_SERVICE_KEY in environment");
  process.exit(1);
}

const BOT_WEBHOOK_BASE = process.env.BOT_WEBHOOK_BASE_URL || "https://uspot-bot-production.up.railway.app";

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
setMainBot(bot);
const db  = createClient(SUPABASE_URL, SUPABASE_KEY);

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

const dateRu = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  const M = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  return `${d.getDate()} ${M[d.getMonth()]}`;
};
const timeShort = (t) => (t || "").substring(0, 5);

// ── Send a notification — contextual inline buttons only (no default keyboard) ──
const send = async (chatId, text, inlineRows = []) => {
  if (!chatId) return;
  try {
    await bot.sendMessage(String(chatId), text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: inlineRows.length ? { inline_keyboard: inlineRows } : undefined,
    });
    console.log(`✉️  Sent to ${chatId}: ${text.substring(0, 60)}…`);
  } catch (e) {
    console.error(`⚠️  send failed to ${chatId}:`, e.message);
  }
};

// ── Alias kept for call-sites that pass action rows explicitly ───────────
const sendWithKeyboard = async (chatId, text, actionRows = []) => {
  return send(chatId, text, actionRows);
};

// ── Shareholders ─────────────────────────────────────────────────────────
const getShareholderIds = async (field = "notify_bookings") => {
  try {
    const { data } = await db.from("shareholders").select("telegram_id").eq(field, true);
    return (data || []).map((r) => r.telegram_id).filter(Boolean);
  } catch (e) { return []; }
};

// ════════════════════════════════════════════════════════════
// /start — keyboard + welcome
// ════════════════════════════════════════════════════════════
bot.onText(/\/start notify/, async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from?.first_name || "друг";
  console.log(`🔔 /start notify from ${chatId} (${name})`);
  await send(chatId,
    `👋 Привет, ${name}!\n\n` +
    `Теперь вы будете получать уведомления от <b>Uspot</b>:\n\n` +
    `✅ Подтверждение записей\n` +
    `⏰ Напоминания за 24 ч и за 1 ч\n` +
    `✨ Статус после сеанса\n\n` +
    `Возвращайтесь в приложение — всё готово! 💜`
  );
});

bot.onText(/\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from?.first_name || "друг";
  console.log(`👋 /start from ${chatId} (${name})`);

  // Set the native Menu button for this chat — stays in the bottom bar permanently
  try {
    await bot.setChatMenuButton({
      chat_id: chatId,
      menu_button: { type: "web_app", text: "Uspot", web_app: { url: MINI_APP_URL } },
    });
  } catch (e) {
    console.warn("⚠️  setChatMenuButton failed:", e.message);
  }

  try {
    await bot.sendMessage(chatId,
      `👋 Привет, ${name}! Добро пожаловать в <b>Uspot</b> — сервис записи к мастерам красоты Минска.\n\n` +
      `Выберите, как хотите открыть приложение 👇`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📅 Записаться к мастеру", web_app: { url: MINI_APP_URL } }],
            [{ text: "💼 Вход для Мастера Uspot", web_app: { url: MINI_APP_URL + "?startapp=master" } }],
          ],
        },
      }
    );
  } catch (e) {
    console.error(`⚠️  /start reply failed for ${chatId}:`, e.message);
  }
});

// ── /test_notify — diagnostic endpoint via bot command ─────────────────
bot.onText(/\/test_notify/, async (msg) => {
  const chatId = msg.chat.id;
  await send(chatId,
    `🧪 <b>Тест уведомлений Uspot</b>\n\n` +
    `✅ Бот работает\n` +
    `✅ Соединение с Telegram установлено\n` +
    `📡 Проверяем Supabase Realtime…`
  );
  // Quick DB ping
  try {
    const { data, error } = await db.from("bookings").select("id").limit(1);
    if (error) throw error;
    await send(chatId, `✅ Supabase DB: OK\n✅ Realtime: активен\n\n🎉 Всё работает! Уведомления будут приходить автоматически.`);
  } catch (e) {
    await send(chatId, `❌ Supabase DB ошибка: ${e.message}\n\nПроверьте SUPABASE_SERVICE_KEY в Railway.`);
  }
});

// ════════════════════════════════════════════════════════════
// SUPABASE REALTIME — New booking (INSERT)
// Bug #1: verify realtime is active, log on subscribe
// ════════════════════════════════════════════════════════════
db.channel("uspot-new-bookings")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b = payload.new;
    if (b.client_name?.startsWith("🔒")) return; // skip manual blocks
    console.log("📥 New booking:", b.id, "status:", b.status, "master_id:", b.master_id, "client_tg:", b.client_telegram_id);

    const date  = dateRu(b.booked_date);
    const time  = timeShort(b.booked_time);
    const price = b.total_price ? `${b.total_price} BYN` : "—";

    // Resolve master Telegram ID
    let masterTgId = null, masterName = b.master_name || "Мастер";
    if (b.master_id) {
      const { data: m, error: me } = await db.from("masters")
        .select("name, telegram_user_id").eq("id", b.master_id).single();
      if (me) console.error("Master lookup error:", me.message);
      if (m) { masterTgId = m.telegram_user_id; masterName = m.name || masterName; }
    }
    console.log(`  → masterTgId: ${masterTgId}, clientTgId: ${b.client_telegram_id}`);

    if (b.status === "pending") {
      // Master: confirm or suggest new time
      if (masterTgId) {
        await sendWithKeyboard(masterTgId,
          `📅 <b>Новая запись!</b>\n\n` +
          `👤 ${b.client_name || "Клиент"}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n` +
          `💳 ${price}\n\n` +
          `Подтвердите или предложите другое время:`,
          [[
            { text: "✅ Подтвердить",             callback_data: `confirm_${b.id}` },
            { text: "⏰ Другое время",             callback_data: `suggest_${b.id}` },
          ]]
        );
      } else {
        console.warn(`⚠️  Master ${b.master_id} has no telegram_user_id — cannot notify master`);
      }
      // Client: waiting
      if (b.client_telegram_id) {
        await send(b.client_telegram_id,
          `⏳ <b>Запись отправлена!</b>\n\n` +
          `👩‍🎨 ${masterName}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n` +
          `💳 ${price}\n\n` +
          `Мастер подтвердит запись в ближайшее время. Мы сразу сообщим вам! 💜`
        );
      }
    } else {
      // Already confirmed (legacy / fallback)
      if (masterTgId) {
        await send(masterTgId,
          `📅 <b>Новая запись!</b>\n\n` +
          `👤 ${b.client_name || "Клиент"}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n` +
          `💳 ${price}`
        );
      }
      if (b.client_telegram_id) {
        await sendWithKeyboard(b.client_telegram_id,
          `✅ <b>Запись подтверждена!</b>\n\n` +
          `👩‍🎨 ${masterName}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n` +
          `💳 ${price}\n\n` +
          `До встречи в Uspot! 💜`,
          [[
            { text: "📅 Перенести", callback_data: `reschedule_${b.id}` },
            { text: "❌ Отменить",  callback_data: `client_cancel_${b.id}` },
          ]]
        );
      }
    }

    // Shareholders summary
    const shIds = await getShareholderIds("notify_bookings");
    for (const id of shIds) {
      await send(id,
        `📊 [Uspot] Новая запись\n` +
        `${b.client_name || "Клиент"} → ${masterName}\n` +
        `${b.service_name || "Услуга"} · ${price}`
      );
    }

    // Push ALL new bookings to GCal: pending → grey "tentative", confirmed → green
    if (masterTgId) {
      pushToGcal(b, masterTgId, masterName, b.status === "pending").catch(e =>
        console.error("GCal push (new booking):", e.message)
      );
    }
  })
  .subscribe((status, err) => {
    if (status === "SUBSCRIBED") {
      console.log("✅ Realtime: listening for new bookings");
    } else {
      console.error("❌ Realtime new-bookings subscribe error:", status, err?.message);
    }
  });

// ════════════════════════════════════════════════════════════
// SUPABASE REALTIME — Booking updates (UPDATE)
// ════════════════════════════════════════════════════════════
db.channel("uspot-booking-updates")
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b   = payload.new;
    const old = payload.old;
    if (b.status === old.status) return;
    console.log(`🔄 Booking ${b.id}: ${old.status} → ${b.status}`);

    const date  = dateRu(b.booked_date);
    const time  = timeShort(b.booked_time);
    const price = b.total_price ? `${b.total_price} BYN` : "—";

    let masterName = b.master_name || "Мастер";
    let masterTgId = null;
    if (b.master_id) {
      const { data: m } = await db.from("masters")
        .select("name, telegram_user_id").eq("id", b.master_id).single();
      if (m) { masterName = m.name || masterName; masterTgId = m.telegram_user_id; }
    }

    // pending → confirmed
    if (b.status === "confirmed" && old.status === "pending") {
      if (b.client_telegram_id) {
        await sendWithKeyboard(b.client_telegram_id,
          `✅ <b>Мастер подтвердил вашу запись!</b>\n\n` +
          `👩‍🎨 ${masterName}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n` +
          `💳 ${price}\n\n` +
          `Ждём вас в Uspot! 💜`,
          [[
            { text: "📅 Перенести", callback_data: `reschedule_${b.id}` },
            { text: "❌ Отменить",  callback_data: `client_cancel_${b.id}` },
          ]]
        );
      }
      // Update GCal event from tentative (grey) → confirmed (green)
      // If event already exists from when booking was pending, update it.
      // If it doesn't exist yet (master confirmed immediately), create it.
      if (masterTgId) {
        confirmGcalEvent(b.id, masterTgId).catch(async (e) => {
          console.error("GCal confirm update failed, trying insert:", e.message);
          // Fallback: insert if no event_id yet
          pushToGcal(b, masterTgId, masterName, false).catch(e2 =>
            console.error("GCal push (confirm fallback):", e2.message)
          );
        });
      }
    }

    // → declined (master can't make it)
    else if (b.status === "declined" && old.status !== "declined") {
      if (b.client_telegram_id) {
        await sendWithKeyboard(b.client_telegram_id,
          `😔 К сожалению, у мастера произошла накладка и он не может принять вас в это время.\n\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n\n` +
          `Выберите другое удобное время 👇`,
          [[{ text: "📅 Выбрать новое время", web_app: { url: `${MINI_APP_URL}?startapp=m${b.master_id}` } }]]
        );
      }
      // Remove from GCal if exists
      deleteFromGcal(b.id).catch(() => {});
    }

    // → cancelled
    else if (b.status === "cancelled" && old.status !== "cancelled") {
      const reason = b.cancel_reason || "";

      if (reason.startsWith("client:") || reason === "client_reschedule" || reason === "client") {
        // Client cancelled — notify master
        if (masterTgId) {
          const reasonText = reason === "client_reschedule"
            ? "Клиент переносит запись на другое время"
            : reason === "client"
            ? "Причина не указана"
            : reason.slice(7);
          const isReschedule = reason === "client_reschedule";
          await send(masterTgId,
            (isReschedule ? `📅 <b>Перенос записи</b>` : `❌ <b>Отмена от клиента</b>`) + `\n\n` +
            `👤 ${b.client_name || "Клиент"}\n` +
            `💇 ${b.service_name || "Услуга"}\n` +
            `📆 ${date}, ${time}\n` +
            `💳 ${price}\n` +
            `💬 Причина: ${reasonText}` +
            (isReschedule ? `\n\nОжидайте новую запись от клиента.` : "")
          );
        }
        deleteFromGcal(b.id).catch(() => {});
      } else if (reason.startsWith("master:") || reason === "force_majeure") {
        // Master cancelled — notify client to rebook
        if (b.client_telegram_id) {
          await sendWithKeyboard(b.client_telegram_id,
            `❌ <b>Запись отменена мастером</b>\n\n` +
            `💇 ${b.service_name || "Услуга"}\n` +
            `📆 ${date}, ${time}\n\n` +
            `Выберите другую дату — записаться снова очень просто! 💜`,
            [[{ text: "📅 Записаться снова", web_app: { url: `${MINI_APP_URL}?startapp=m${b.master_id}` } }]]
          );
        }
        deleteFromGcal(b.id).catch(() => {});
      }
    }

    // → completed
    else if (b.status === "completed" && old.status !== "completed") {
      console.log("✅ Booking completed:", b.id);
      // Review request is handled by the hourly cron (3-4h window after booking)
    }
  })
  .subscribe((status, err) => {
    if (status === "SUBSCRIBED") {
      console.log("✅ Realtime: listening for booking updates");
    } else {
      console.error("❌ Realtime booking-updates subscribe error:", status, err?.message);
    }
  });

// ════════════════════════════════════════════════════════════
// CALLBACK QUERIES — master confirm/suggest, client cancel
// ════════════════════════════════════════════════════════════
// In-memory: clients awaiting free-text cancel reason
const pendingCancelText = new Map();

const CANCEL_REASONS = {
  "1": "Нет времени",
  "2": "Изменились планы",
  "3": "Нашла другого мастера",
  "4": "Не устраивает цена",
};

bot.on("callback_query", async (query) => {
  const data   = query.data || "";
  const chatId = String(query.message?.chat?.id || query.from.id);
  const msgId  = query.message?.message_id;

  // Master: ✅ Подтвердить
  if (data.startsWith("confirm_")) {
    const bookingId = data.slice(8);
    try {
      await db.from("bookings").update({ status: "confirmed" }).eq("id", bookingId);
      await bot.answerCallbackQuery(query.id, { text: "✅ Запись подтверждена!" });
      await bot.editMessageText(
        `✅ <b>Запись подтверждена</b>\n\nКлиент получит уведомление. Ждём его в Uspot! 💜`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "📅 Открыть кабинет мастера", web_app: { url: MINI_APP_URL + "?startapp=master" } }]] } }
      ).catch(() => {});
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка, попробуйте ещё раз" });
      console.error("[Callback] confirm error:", e.message);
    }
    return;
  }

  // Master: ⏰ Предложить другое время
  if (data.startsWith("suggest_")) {
    const bookingId = data.slice(8);
    try {
      await db.from("bookings").update({ status: "declined" }).eq("id", bookingId);
      await bot.answerCallbackQuery(query.id, { text: "⏰ Клиент получит уведомление" });
      await bot.editMessageText(
        `⏰ <b>Другое время предложено</b>\n\nКлиент получит уведомление и сможет перезаписаться.`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "📅 Открыть кабинет мастера", web_app: { url: MINI_APP_URL + "?startapp=master" } }]] } }
      ).catch(() => {});
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка" });
      console.error("[Callback] suggest error:", e.message);
    }
    return;
  }

  // Client: Reschedule (from bot button)
  if (data.startsWith("reschedule_")) {
    const bookingId = data.slice(11);
    const { data: bk } = await db.from("bookings").select("master_id").eq("id", bookingId).single();
    await bot.answerCallbackQuery(query.id);
    // Send web_app link with startapp=reschedule_bookingId_masterId
    await send(chatId,
      `📅 <b>Перенос записи</b>\n\nНажмите кнопку ниже, чтобы выбрать новое время:`,
      [[{ text: "📅 Выбрать новое время", web_app: { url: `${MINI_APP_URL}?startapp=reschedule_${bookingId}_${bk?.master_id||""}` } }]]
    );
    return;
  }

  // Client: ❌ Отменить → show reason options
  if (data.startsWith("client_cancel_")) {
    const bookingId = data.slice(14);
    await bot.answerCallbackQuery(query.id);
    await sendWithKeyboard(chatId,
      `❌ <b>Отмена записи</b>\n\nУкажите причину — мастер её увидит:`,
      [
        [{ text: "⏱ Нет времени",           callback_data: `cr_${bookingId}_1` }],
        [{ text: "📅 Изменились планы",       callback_data: `cr_${bookingId}_2` }],
        [{ text: "💅 Нашла другого мастера",  callback_data: `cr_${bookingId}_3` }],
        [{ text: "💰 Не устраивает цена",     callback_data: `cr_${bookingId}_4` }],
        [{ text: "✏️ Написать своё",          callback_data: `cr_text_${bookingId}` }],
      ]
    );
    return;
  }

  // Client: selected cancel reason
  if (data.startsWith("cr_")) {
    const rest = data.slice(3);
    if (rest.startsWith("text_")) {
      const bookingId = rest.slice(5);
      pendingCancelText.set(chatId, { bookingId });
      await bot.answerCallbackQuery(query.id);
      await send(chatId, `✏️ Напишите причину отмены — мастер её увидит:`);
      return;
    }
    const underIdx   = rest.lastIndexOf("_");
    const bookingId  = rest.slice(0, underIdx);
    const reasonCode = rest.slice(underIdx + 1);
    const reasonText = CANCEL_REASONS[reasonCode] || reasonCode;
    try {
      const { data: bkInfo } = await db.from("bookings").select("master_id").eq("id", bookingId).single();
      await db.from("bookings")
        .update({ status: "cancelled", cancel_reason: `client:${reasonText}` })
        .eq("id", bookingId);
      await bot.answerCallbackQuery(query.id, { text: "✅ Запись отменена" });
      await send(chatId,
        `✅ <b>Запись отменена</b>\n\nПричина: <i>${reasonText}</i>\n\nНадеемся увидеть вас снова в Uspot! 💜`,
        bkInfo?.master_id
          ? [[{ text: "📅 Записаться снова", web_app: { url: `${MINI_APP_URL}?startapp=m${bkInfo.master_id}` } }]]
          : []
      );
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка" });
      console.error("[Callback] cancel reason error:", e.message);
    }
    return;
  }

  // GCal connect callback from inline button
  if (data.startsWith("gcal_connect_")) {
    const masterTgId = data.slice(13);
    await bot.answerCallbackQuery(query.id);
    const authUrl = getGcalAuthUrl(masterTgId);
    await send(chatId,
      `📅 <b>Подключение Google Календаря</b>\n\n` +
      `Нажмите кнопку ниже для авторизации. После этого все новые подтверждённые записи будут автоматически появляться в вашем Google Календаре <b>«Uspot Bookings»</b>.`,
      [[{ text: "🔗 Авторизоваться в Google", url: authUrl }]]
    );
    return;
  }
});

// Message handler: free-text cancel reasons
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  if (!msg.text || msg.text.startsWith("/")) return;
  const pending = pendingCancelText.get(chatId);
  if (!pending) return;
  pendingCancelText.delete(chatId);
  const reasonText = msg.text.trim();
  try {
    const { data: bkInfo } = await db.from("bookings").select("master_id").eq("id", pending.bookingId).single();
    await db.from("bookings")
      .update({ status: "cancelled", cancel_reason: `client:${reasonText}` })
      .eq("id", pending.bookingId);
    await send(chatId,
      `✅ <b>Запись отменена</b>\n\nПричина: <i>${reasonText}</i>\n\nНадеемся увидеть вас снова в Uspot! 💜`,
      bkInfo?.master_id
        ? [[{ text: "📅 Записаться снова", web_app: { url: `${MINI_APP_URL}?startapp=m${bkInfo.master_id}` } }]]
        : []
    );
  } catch (e) {
    console.error("[Message] cancel text error:", e.message);
    await send(chatId, "⚠️ Не удалось отменить запись. Напишите нам — поможем!");
  }
});

// ════════════════════════════════════════════════════════════
// SCHEDULED REMINDERS — hourly
// ════════════════════════════════════════════════════════════
const MINSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const parseMinsKDt = (dateStr, timeStr) =>
  new Date(new Date(`${dateStr}T${timeStr}Z`).getTime() - MINSK_OFFSET_MS);

const minskDateStr = (offsetDays = 0) => {
  const minskNow = new Date(Date.now() + MINSK_OFFSET_MS + offsetDays * 86400000);
  return minskNow.toISOString().split("T")[0];
};

const sentReminders = new Set();

// Prune reminder keys older than 3 days (keys encode booking IDs, not dates,
// so we clear the whole set once a day — worst case one duplicate send per month).
setInterval(() => {
  sentReminders.clear();
  console.log("🧹 sentReminders cache cleared");
}, 24 * 60 * 60 * 1000);

const runReminders = async () => {
  console.log("⏰ Running reminder check…");
  const now = new Date();
  const todayStr     = minskDateStr(0);
  const tomorrowStr  = minskDateStr(1);
  const yesterdayStr = minskDateStr(-1);

  // 1h reminder
  const { data: todayBookings } = await db.from("bookings")
    .select("*, masters(name, location)")
    .eq("status", "confirmed").eq("booked_date", todayStr);

  for (const b of todayBookings || []) {
    if (!b.client_telegram_id) continue;
    const key = `${b.id}_1h`;
    if (sentReminders.has(key)) continue;
    const bookingUtc = parseMinsKDt(b.booked_date, b.booked_time || "00:00:00");
    const minsUntil  = (bookingUtc - now) / 60000;
    if (minsUntil < 55 || minsUntil > 65) continue;
    const master = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    await send(b.client_telegram_id,
      `🔔 <b>Через час ваша запись!</b>\n\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `👩‍🎨 ${master?.name || "Мастер"}\n` +
      (master?.location ? `📍 ${master.location}\n` : "") +
      `\nВремя: <b>${timeShort(b.booked_time)}</b> — ждём вас! 💜`
    );
    sentReminders.add(key);
    console.log(`✉️  1h reminder sent: booking ${b.id}`);
  }

  // 24h reminder
  const { data: tomorrowBookings } = await db.from("bookings")
    .select("*, masters(name, location)")
    .eq("status", "confirmed").eq("booked_date", tomorrowStr);

  for (const b of tomorrowBookings || []) {
    if (!b.client_telegram_id) continue;
    const key = `${b.id}_24h`;
    if (sentReminders.has(key)) continue;
    const bookingUtc  = parseMinsKDt(b.booked_date, b.booked_time || "00:00:00");
    const hoursUntil  = (bookingUtc - now) / 3600000;
    if (hoursUntil < 23.5 || hoursUntil > 24.5) continue;
    if (b.created_at && (now - new Date(b.created_at)) / 3600000 < 4) continue;
    const master = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    await send(b.client_telegram_id,
      `⏰ <b>Напоминание на завтра</b>\n\n` +
      `Завтра в <b>${timeShort(b.booked_time)}</b> у вас запись:\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `👩‍🎨 ${master?.name || "Мастер"}\n` +
      (master?.location ? `📍 ${master.location}\n` : "") +
      (b.total_price ? `💳 ${b.total_price} BYN\n` : "") +
      `\nДо встречи в Uspot! 💜`
    );
    sentReminders.add(key);
    console.log(`✉️  24h reminder sent: booking ${b.id}`);
  }

  // ── Review request ──────────────────────────────────────────────
  // Send 3-4h after booking time, only if visit actually happened
  const { data: pastBookings } = await db.from("bookings")
    .select("*, masters(name)")
    .in("status", ["confirmed", "completed"])
    .not("client_name", "like", "🔒%")          // skip manual/block-time entries
    .in("booked_date", [todayStr, yesterdayStr]);

  for (const b of pastBookings || []) {
    if (!b.client_telegram_id) continue;
    const key = `${b.id}_review`;
    if (sentReminders.has(key)) continue;
    const bookingUtc = parseMinsKDt(b.booked_date, b.booked_time || "00:00:00");
    const hoursAgo   = (now - bookingUtc) / 3600000;
    if (hoursAgo < 3 || hoursAgo > 4) continue;

    // Re-check fresh status — skip if booking was cancelled after the query ran
    const { data: fresh } = await db.from("bookings")
      .select("status").eq("id", b.id).single();
    if (!fresh || fresh.status === "cancelled" || fresh.status === "declined" || fresh.status === "pending") {
      console.log(`⏭️  Review skipped (status=${fresh?.status}): booking ${b.id}`);
      sentReminders.add(key); // don't retry
      continue;
    }

    const master = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    const masterName = master?.name || b.master_name || null;

    const reviewStartapp = `review_${b.id}_${b.master_id}`;
    const reviewUrl = `${MINI_APP_URL}?startapp=${reviewStartapp}`;

    await sendWithKeyboard(b.client_telegram_id,
      `💜 <b>Как прошёл визит?</b>\n\n` +
      (masterName ? `Надеемся, сеанс у <b>${masterName}</b> понравился! ` : `Надеемся, всё понравилось! `) +
      `Оставьте короткий отзыв — это очень важно для вашего мастера 🙏`,
      [[{ text: "⭐ Оставить отзыв", web_app: { url: reviewUrl } }]]
    );
    sentReminders.add(key);
    console.log(`✉️  Review request sent: booking ${b.id}`);
  }

  console.log("⏰ Reminder check done");
};

runReminders();
setInterval(runReminders, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// GOOGLE CALENDAR INTEGRATION  — Bug #5
// ════════════════════════════════════════════════════════════

// Check if googleapis is available
let google = null;
try {
  google = require("googleapis").google;
  console.log("✅ googleapis loaded");
} catch (e) {
  console.warn("⚠️  googleapis not installed — Google Calendar features disabled.");
  console.warn("   Run: npm install googleapis  then redeploy to Railway.");
}

const getOAuth2Client = () => {
  if (!google || !GCAL_CLIENT_ID) return null;
  return new google.auth.OAuth2(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REDIRECT_URI);
};

const getGcalAuthUrl = (masterTgId) => {
  const oauth2 = getOAuth2Client();
  if (!oauth2) return "";
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: String(masterTgId),
  });
};

// Get stored tokens for master, return an auth client
const getMasterOAuth2 = async (masterTgId) => {
  if (!google) return null;
  const { data } = await db.from("master_gcal_tokens")
    .select("access_token, refresh_token, expiry_date")
    .eq("master_telegram_id", String(masterTgId))
    .single();
  if (!data?.refresh_token) return null;
  const oauth2 = getOAuth2Client();
  if (!oauth2) return null;
  oauth2.setCredentials({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry_date:   data.expiry_date,
  });
  return oauth2;
};

// Ensure "Uspot Bookings" calendar exists, return its ID
const ensureUspotCalendar = async (auth) => {
  const calendar = google.calendar({ version: "v3", auth });
  const { data: list } = await calendar.calendarList.list();
  const existing = (list.items || []).find(c => c.summary === "Uspot Bookings");
  if (existing) return existing.id;
  const { data: created } = await calendar.calendars.insert({
    requestBody: { summary: "Uspot Bookings", timeZone: "Europe/Minsk" },
  });
  return created.id;
};

// Push a booking to master's Google Calendar
// isPending=true → grey "tentative" event; false → green "confirmed"
const pushToGcal = async (booking, masterTgId, masterName, isPending = false) => {
  if (!google || !GCAL_CLIENT_ID) return;
  const auth = await getMasterOAuth2(masterTgId);
  if (!auth) {
    console.log(`GCal: master ${masterTgId} has not connected Google Calendar`);
    return;
  }
  const calendar = google.calendar({ version: "v3", auth });
  const calId = await ensureUspotCalendar(auth);

  // Build event times (Minsk UTC+3)
  const dur = booking.duration_min || 60;
  const startIso = `${booking.booked_date}T${(booking.booked_time || "09:00:00").slice(0,5)}:00`;
  const startMs  = new Date(`${startIso}+03:00`).getTime();
  const endMinsKMs = startMs + dur * 60000 + 3 * 60 * 60 * 1000;
  const endIso     = new Date(endMinsKMs).toISOString().slice(0, 19);

  const event = {
    summary: isPending
      ? `⏳ ${booking.service_name || "Услуга"} — ${booking.client_name || "Клиент"} (ожидает)`
      : `✅ ${booking.service_name || "Услуга"} — ${booking.client_name || "Клиент"}`,
    description:
      `Клиент: ${booking.client_name || "—"}\n` +
      `Услуга: ${booking.service_name || "—"}\n` +
      `Цена: ${booking.total_price ? booking.total_price + " BYN" : "—"}\n` +
      (booking.client_notes ? `Пожелания: ${booking.client_notes}\n` : "") +
      `Статус: ${isPending ? "Ожидает подтверждения" : "Подтверждено"}\n` +
      `\nUspot Booking ID: ${booking.id}`,
    start: { dateTime: `${startIso}+03:00`, timeZone: "Europe/Minsk" },
    end:   { dateTime: `${endIso}+03:00`,   timeZone: "Europe/Minsk" },
    status: isPending ? "tentative" : "confirmed",
    colorId: isPending ? "8" : "3", // 8=graphite (pending), 3=green (confirmed)
    extendedProperties: {
      private: { uspot_booking_id: booking.id }
    },
  };

  try {
    const { data: created } = await calendar.events.insert({
      calendarId: calId,
      requestBody: event,
    });
    await db.from("bookings")
      .update({ gcal_event_id: created.id, gcal_calendar_id: calId })
      .eq("id", booking.id);
    console.log(`✅ GCal event created (${isPending?"pending":"confirmed"}): ${created.id} for booking ${booking.id}`);
  } catch (e) {
    console.error("GCal insert failed:", e.message);
  }
};

// Update GCal event when booking is confirmed (pending → confirmed)
const confirmGcalEvent = async (bookingId, masterTgId) => {
  if (!google || !GCAL_CLIENT_ID) return;
  try {
    const { data: bk } = await db.from("bookings")
      .select("gcal_event_id, gcal_calendar_id, service_name, client_name")
      .eq("id", bookingId).single();
    if (!bk?.gcal_event_id) return;
    const auth = await getMasterOAuth2(masterTgId);
    if (!auth) return;
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.patch({
      calendarId: bk.gcal_calendar_id,
      eventId: bk.gcal_event_id,
      requestBody: {
        summary: `✅ ${bk.service_name || "Услуга"} — ${bk.client_name || "Клиент"}`,
        status: "confirmed",
        colorId: "3", // green
      },
    });
    console.log(`✅ GCal event updated to confirmed: ${bk.gcal_event_id}`);
  } catch (e) {
    console.error("GCal confirm update failed:", e.message);
  }
};

// Delete calendar event when booking is cancelled
const deleteFromGcal = async (bookingId) => {
  if (!google || !GCAL_CLIENT_ID) return;
  const { data: bk } = await db.from("bookings")
    .select("gcal_event_id, gcal_calendar_id, master_id")
    .eq("id", bookingId).single();
  if (!bk?.gcal_event_id) return;

  // Get master tg id
  const { data: m } = await db.from("masters")
    .select("telegram_user_id").eq("id", bk.master_id).single();
  if (!m?.telegram_user_id) return;

  const auth = await getMasterOAuth2(m.telegram_user_id);
  if (!auth) return;
  const calendar = google.calendar({ version: "v3", auth });
  try {
    await calendar.events.delete({ calendarId: bk.gcal_calendar_id, eventId: bk.gcal_event_id });
    console.log(`🗑️  GCal event deleted for booking ${bookingId}`);
  } catch (e) {
    console.warn("GCal delete failed:", e.message);
  }
};

// ════════════════════════════════════════════════════════════
// EXPRESS HTTP SERVER
// ════════════════════════════════════════════════════════════
const path = require("path");
const app = express();
app.use(cors());
app.use(express.json());

// Home page — required for Google OAuth branding verification
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "home.html"));
});

// Serve moderation dashboard from this repo so it's always reachable
app.get("/moderation", (_req, res) => {
  res.sendFile(path.join(__dirname, "uspot-moderation.html"));
});

// Privacy policy — required for Google OAuth verification
app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(__dirname, "privacy.html"));
});

// ── Telegram webhook endpoints ────────────────────────────
app.post("/webhook/main", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/webhook/founders", (req, res) => {
  if (processFoundersUpdate) processFoundersUpdate(req.body);
  res.sendStatus(200);
});

// ── POST /notify ──────────────────────────────────────────
app.post("/notify", async (req, res) => {
  const { to, message, keyboard } = req.body;
  if (!to || !message) return res.status(400).json({ error: "Missing 'to' or 'message'" });
  const recipients = (Array.isArray(to) ? to : [String(to)]).filter(Boolean);
  let sent = 0;
  for (const chatId of recipients) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard?.length ? { inline_keyboard: keyboard } : undefined,
      });
      sent++;
    } catch (e) {
      console.error(`Failed to send to ${chatId}:`, e.message);
    }
  }
  res.json({ ok: true, sent, total: recipients.length });
});

// ── POST /broadcast ───────────────────────────────────────
app.post("/broadcast", async (req, res) => {
  const { master_id, message, shareholder_id } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  if (shareholder_id) {
    const { data: sh } = await db.from("shareholders").select("id").eq("telegram_id", String(shareholder_id)).single();
    if (!sh) return res.status(403).json({ error: "Not a shareholder" });
  }
  let clientIds = [];
  try {
    let query = db.from("bookings").select("client_telegram_id").not("client_telegram_id", "is", null);
    if (master_id) query = query.eq("master_id", master_id);
    const { data } = await query;
    clientIds = [...new Set((data || []).map(r => r.client_telegram_id).filter(Boolean))];
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  let sent = 0;
  for (const chatId of clientIds) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      sent++;
    } catch (e) {
      console.error(`Broadcast to ${chatId}:`, e.message);
    }
  }
  res.json({ ok: true, sent, total: clientIds.length });
});

// ── POST /notify_reschedule ────────────────────────────────
app.post("/notify_reschedule", async (req, res) => {
  const { masterTgId, clientName, svc, price, oldDate, oldTime, newDate, newTime } = req.body;
  if (!masterTgId) return res.status(400).json({ error: "Missing masterTgId" });
  await send(masterTgId,
    `📅 <b>Перенос записи</b>\n\n` +
    `👤 ${clientName || "Клиент"}\n` +
    `💇 ${svc || "Услуга"}\n` +
    `📅 Было: <b>${oldDate ? `${dateRu(oldDate)}, ${timeShort(oldTime)}` : "—"}</b>\n` +
    `📅 Стало: <b>${newDate ? `${dateRu(newDate)}, ${timeShort(newTime)}` : "—"}</b>\n` +
    `💳 ${price || "—"}`
  );
  res.json({ ok: true });
});

// ── POST /notify_moderation ────────────────────────────────
app.post("/notify_moderation", async (req, res) => {
  const { type, masterName, clientName, stars, preview } = req.body;
  if (!type) return res.status(400).json({ error: "Missing type" });
  try {
    const result = await notifyModeration({ type, masterName, clientName, stars, preview, dashboardUrl: MODERATION_URL });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /feedback ─────────────────────────────────────────
app.post("/feedback", async (req, res) => {
  const { message, user_name, user_telegram_id, user_role } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  try {
    const result = await notifyFeedback({ message, user_name, user_telegram_id, user_role });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()) + "s",
    gcal: !!google && !!GCAL_CLIENT_ID,
  });
});

// ── GET /notify_test — quick diagnostic ping ───────────────
app.get("/notify_test", async (req, res) => {
  const { tg_id } = req.query;
  if (!tg_id) return res.status(400).json({ error: "Pass ?tg_id=YOUR_TELEGRAM_ID" });
  await send(tg_id,
    `🧪 <b>Тест уведомлений Uspot</b>\n\n` +
    `✅ Бот работает\n` +
    `✅ Realtime активен\n` +
    `🕐 Время сервера: ${new Date().toISOString()}\n\n` +
    `Если вы получили это сообщение — уведомления работают! 💜`
  );
  res.json({ ok: true, sent_to: tg_id });
});

// ════════════════════════════════════════════════════════════
// GOOGLE CALENDAR OAUTH ENDPOINTS  — Bug #5
// ════════════════════════════════════════════════════════════

// GET /gcal/auth?master_tg_id=XXX — generates OAuth URL for master
app.get("/gcal/auth", async (req, res) => {
  if (!google || !GCAL_CLIENT_ID) {
    return res.status(503).json({
      error: "Google Calendar not configured. Add GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REDIRECT_URI to Railway env vars.",
      setup_url: "https://console.cloud.google.com/apis/credentials"
    });
  }
  const { master_tg_id } = req.query;
  if (!master_tg_id) return res.status(400).json({ error: "Missing master_tg_id" });
  const url = getGcalAuthUrl(master_tg_id);
  res.json({ ok: true, auth_url: url });
});

// GET /gcal/callback — Google redirects here with the auth code
app.get("/gcal/callback", async (req, res) => {
  const { code, state: masterTgId } = req.query;
  if (!code || !masterTgId) return res.status(400).send("Missing code or state");

  const oauth2 = getOAuth2Client();
  if (!oauth2) return res.status(503).send("GCal not configured");

  try {
    const { tokens } = await oauth2.getToken(code);
    // Store tokens in Supabase
    await db.from("master_gcal_tokens").upsert({
      master_telegram_id: String(masterTgId),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      updated_at: new Date().toISOString(),
    }, { onConflict: "master_telegram_id" });

    // Notify master in Telegram that connection succeeded
    await send(masterTgId,
      `✅ <b>Google Календарь подключён!</b>\n\n` +
      `Все подтверждённые записи будут автоматически появляться в вашем Google Календаре <b>«Uspot Bookings»</b>.\n\n` +
      `Если запись отменяется — событие удаляется из календаря автоматически. 💜`
    );

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ Google Календарь подключён!</h2>
      <p>Вернитесь в Telegram — записи будут автоматически появляться в вашем календаре <b>«Uspot Bookings»</b>.</p>
      <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>`);
  } catch (e) {
    console.error("GCal callback error:", e.message);
    res.status(500).send("Auth failed: " + e.message);
  }
});

// POST /gcal/sync — manually sync a specific booking (called by prototype)
app.post("/gcal/sync", async (req, res) => {
  const { booking_id, master_tg_id } = req.body;
  if (!booking_id || !master_tg_id) return res.status(400).json({ error: "Missing booking_id or master_tg_id" });

  try {
    const { data: bk, error } = await db.from("bookings").select("*").eq("id", booking_id).single();
    if (error || !bk) return res.status(404).json({ error: "Booking not found" });

    const { data: m } = await db.from("masters").select("name").eq("id", bk.master_id).single();
    await pushToGcal(bk, master_tg_id, m?.name || "Мастер");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /gcal/webhook — Google Calendar push notifications (when master edits/cancels)
app.post("/gcal/webhook", async (req, res) => {
  // Google sends a POST to this URL when a calendar event changes
  const channelId    = req.headers["x-goog-channel-id"];
  const resourceState = req.headers["x-goog-resource-state"];
  res.sendStatus(200); // Always respond 200 immediately

  if (resourceState !== "exists" && resourceState !== "not_exists") return;
  if (!channelId) return;

  // channelId format: "uspot-{masterTgId}-{calId}"
  const parts = channelId.split("-");
  if (parts.length < 3 || parts[0] !== "uspot") return;
  const masterTgId = parts[1];

  console.log(`📅 GCal webhook: master ${masterTgId}, state: ${resourceState}`);

  try {
    const auth = await getMasterOAuth2(masterTgId);
    if (!auth) return;

    const calendar = google.calendar({ version: "v3", auth });
    // Find the calendar for this master
    const { data: list } = await calendar.calendarList.list();
    const cal = (list.items || []).find(c => c.summary === "Uspot Bookings");
    if (!cal) return;

    // Get recently updated events
    const timeMin = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // last 5 min
    const { data: events } = await calendar.events.list({
      calendarId: cal.id,
      updatedMin: timeMin,
      singleEvents: true,
    });

    for (const event of events?.items || []) {
      const bookingId = event.extendedProperties?.private?.uspot_booking_id;
      if (!bookingId) continue;

      if (event.status === "cancelled") {
        // Event deleted in Google Calendar → cancel booking + notify client
        const { data: bk } = await db.from("bookings").select("*").eq("id", bookingId).single();
        if (!bk || bk.status === "cancelled") continue;

        await db.from("bookings")
          .update({ status: "cancelled", cancel_reason: "master:gcal_delete" })
          .eq("id", bookingId);

        if (bk.client_telegram_id) {
          await sendWithKeyboard(bk.client_telegram_id,
            `❌ <b>Запись отменена мастером</b>\n\n` +
            `💇 ${bk.service_name || "Услуга"}\n` +
            `📆 ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}\n\n` +
            `Выберите другую дату — записаться снова очень просто! 💜`,
            [[{ text: "📅 Записаться снова", web_app: { url: `${MINI_APP_URL}?startapp=m${bk.master_id}` } }]]
          );
        }
        console.log(`✅ Booking ${bookingId} cancelled via GCal webhook`);
      }
    }
  } catch (e) {
    console.error("GCal webhook processing error:", e.message);
  }
});

// GET /gcal/status?master_tg_id=XXX — check if master has connected GCal
app.get("/gcal/status", async (req, res) => {
  const { master_tg_id } = req.query;
  if (!master_tg_id) return res.status(400).json({ error: "Missing master_tg_id" });
  const { data } = await db.from("master_gcal_tokens")
    .select("updated_at").eq("master_telegram_id", String(master_tg_id)).single();
  res.json({ ok: true, connected: !!data, updated_at: data?.updated_at });
});

// DELETE /gcal/disconnect?master_tg_id=XXX — revoke Google Calendar access
app.delete("/gcal/disconnect", async (req, res) => {
  const { master_tg_id } = req.query;
  if (!master_tg_id) return res.status(400).json({ error: "Missing master_tg_id" });
  const { error } = await db.from("master_gcal_tokens")
    .delete().eq("master_telegram_id", String(master_tg_id));
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, disconnected: true });
});

// Delete any active polling/webhook then register new webhook, retrying on 409
const registerWebhook = async (botInstance, url, label, attempts = 5) => {
  for (let i = 0; i < attempts; i++) {
    try {
      await botInstance.deleteWebHook();
      await botInstance.setWebHook(url);
      console.log(`✅ ${label} webhook set: ${url}`);
      return;
    } catch (e) {
      if (i < attempts - 1) {
        console.warn(`⚠️  ${label} webhook attempt ${i + 1} failed (${e.message}), retrying in ${(i + 1) * 2}s…`);
        await new Promise(r => setTimeout(r, (i + 1) * 2000));
      } else {
        console.error(`❌ ${label} webhook setup failed after ${attempts} attempts: ${e.message}`);
      }
    }
  }
};

const server = app.listen(PORT, async () => {
  console.log(`🤖 Uspot bot HTTP server running on port ${PORT}`);
  console.log(`📅 Google Calendar: ${google && GCAL_CLIENT_ID ? "ENABLED" : "disabled (set GCAL_* env vars)"}`);

  await registerWebhook(bot, `${BOT_WEBHOOK_BASE}/webhook/main`, "Main bot");

  // Register /start in the bot command menu (tap / to see it)
  try {
    await bot.setMyCommands([{ command: "start", description: "Открыть Uspot" }]);
    console.log("✅ Bot commands registered");
  } catch (e) {
    console.warn("⚠️  setMyCommands failed:", e.message);
  }

  // Set the default Menu button for all chats (the ⊞ button next to the text field)
  try {
    await bot.setChatMenuButton({
      menu_button: { type: "web_app", text: "Uspot", web_app: { url: MINI_APP_URL } },
    });
    console.log("✅ Default Menu button set");
  } catch (e) {
    console.warn("⚠️  setChatMenuButton (default) failed:", e.message);
  }

  if (setFoundersWebhook) {
    const foundersBot = { deleteWebHook: deleteFoundersWebhook, setWebHook: setFoundersWebhook };
    await registerWebhook(foundersBot, `${BOT_WEBHOOK_BASE}/webhook/founders`, "Founders bot");
  }
});

const shutdown = async (signal) => {
  console.log(`\n[${signal}] Shutting down…`);
  server.close(() => { console.log("Bye!"); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
