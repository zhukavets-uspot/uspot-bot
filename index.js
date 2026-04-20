// ============================================================
// Uspot Notification Bot
// ============================================================
// Handles ALL notifications for Uspot:
//   • New booking  → master gets instant alert
//   • New booking  → client gets confirmation
//   • New booking  → shareholders get summary
//   • Booking done → client gets completion + payment summary
//   • 24h before   → client reminder
//   • 1h before    → client reminder
//   • /notify HTTP → called by the app for portfolio/review alerts
// ============================================================

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");

// ── Config ───────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://heiyayufhuvlxhirgvyc.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT         = process.env.PORT || 3000;

if (!BOT_TOKEN || !SUPABASE_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or SUPABASE_SERVICE_KEY in environment");
  process.exit(1);
}

// polling: true so the bot can receive /start messages from users
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db  = createClient(SUPABASE_URL, SUPABASE_KEY);

// ════════════════════════════════════════════════════════════
// /start — user taps "Start" in bot chat for the first time.
// This is REQUIRED before the bot can send them any messages.
// The Mini App shows an "Enable notifications" button that
// opens this chat. One tap = notifications unlocked forever.
// ════════════════════════════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from?.first_name || "друг";
  console.log(`👋 /start from ${chatId} (${name})`);

  await send(chatId,
    `👋 Привет, ${name}!\n\n` +
    `Теперь вы будете получать уведомления от <b>Uspot</b>:\n\n` +
    `✅ Подтверждение записей\n` +
    `⏰ Напоминания за 24 ч и за 1 ч\n` +
    `✨ Статус после сеанса\n\n` +
    `Возвращайтесь в приложение — всё готово! 💜`
  );
});

// ── Helper: send a Telegram message safely ───────────────────
const send = async (chatId, text) => {
  if (!chatId) return;
  try {
    await bot.sendMessage(String(chatId), text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    console.log(`✉️  Sent to ${chatId}: ${text.substring(0, 60)}…`);
  } catch (e) {
    console.error(`⚠️  Failed to send to ${chatId}:`, e.message);
  }
};

// ── Helper: get shareholders by notification type ────────────
const getShareholderIds = async (field = "notify_bookings") => {
  try {
    const { data } = await db.from("shareholders").select("telegram_id").eq(field, true);
    return (data || []).map((r) => r.telegram_id).filter(Boolean);
  } catch (e) {
    return [];
  }
};

// ── Helper: format date to Russian ──────────────────────────
const dateRu = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  const M = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  return `${d.getDate()} ${M[d.getMonth()]}`;
};

const timeShort = (t) => (t || "").substring(0, 5);

// ════════════════════════════════════════════════════════════
// 1. SUPABASE REALTIME — New booking (INSERT)
//    Fires instantly when a client books any service
// ════════════════════════════════════════════════════════════
db.channel("uspot-new-bookings")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b = payload.new;
    console.log("📥 New booking inserted:", b.id);

    const date = dateRu(b.booked_date);
    const time = timeShort(b.booked_time);
    const price = b.total_price ? `${b.total_price} BYN` : "—";

    // Get master's Telegram ID (needed for notification)
    let masterTgId = null;
    let masterName = b.master_name || "Мастер";
    if (b.master_id) {
      const { data: master } = await db
        .from("masters")
        .select("name, telegram_user_id")
        .eq("id", b.master_id)
        .single();
      if (master) {
        masterTgId = master.telegram_user_id;
        masterName = master.name || masterName;
      }
    }

    // → Master: new booking alert
    if (masterTgId) {
      await send(masterTgId,
        `📅 <b>Новая запись!</b>\n\n` +
        `👤 ${b.client_name || "Клиент"}\n` +
        `💇 ${b.service_name || "Услуга"}\n` +
        `📆 ${date}, ${time}\n` +
        `💳 ${price}\n\n` +
        `Откройте Uspot для подтверждения.`
      );
    }

    // → Client: booking confirmation
    if (b.client_telegram_id) {
      await send(b.client_telegram_id,
        `✅ <b>Запись подтверждена!</b>\n\n` +
        `👩‍🎨 ${masterName}\n` +
        `💇 ${b.service_name || "Услуга"}\n` +
        `📆 ${date}, ${time}\n` +
        `💳 ${price}\n\n` +
        `До встречи в Uspot! 💜`
      );
    }

    // → Shareholders: summary
    const shareholderIds = await getShareholderIds("notify_bookings");
    for (const id of shareholderIds) {
      await send(id,
        `📊 [Uspot] Новая запись\n` +
        `${b.client_name || "Клиент"} → ${masterName}\n` +
        `${b.service_name || "Услуга"} · ${price}`
      );
    }
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log("✅ Realtime: listening for new bookings");
  });

// ════════════════════════════════════════════════════════════
// 2. SUPABASE REALTIME — Booking completed (UPDATE)
//    Fires when master marks session as done
// ════════════════════════════════════════════════════════════
db.channel("uspot-completed-bookings")
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b   = payload.new;
    const old = payload.old;

    // Only react when status changes to "completed"
    if (b.status !== "completed" || old.status === "completed") return;
    console.log("✅ Booking completed:", b.id);

    if (!b.client_telegram_id) return;

    const finalPrice = b.final_price ?? b.total_price;
    const origPrice  = b.total_price || 0;
    const diff = finalPrice - (b.payment_status === "paid" ? Math.round(origPrice * 0.30) : 0);

    let payLine = "";
    if (b.payment_status === "paid") {
      if (diff < 0)      payLine = `\n↩️ Возврат: <b>${Math.abs(diff)} BYN</b>`;
      else if (diff > 0) payLine = `\n💵 Доплата: <b>${diff} BYN</b>`;
    } else {
      payLine = `\n💵 К оплате: <b>${finalPrice} BYN</b>`;
    }

    await send(b.client_telegram_id,
      `✨ <b>Сеанс завершён!</b>\n\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `💳 Итого: <b>${finalPrice} BYN</b>${payLine}\n\n` +
      `Спасибо! Оставьте отзыв в Uspot 💜`
    );
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log("✅ Realtime: listening for completed bookings");
  });

// ════════════════════════════════════════════════════════════
// 3. SCHEDULED REMINDERS — runs every hour
//    Sends 24h and 1h reminders to clients
// ════════════════════════════════════════════════════════════
const runReminders = async () => {
  console.log("⏰ Running reminder check…");
  const now = new Date();

  // 1-hour reminder — today's bookings 50-70 min from now
  const todayStr = now.toISOString().split("T")[0];
  const { data: todayBookings } = await db
    .from("bookings")
    .select("*, masters(name, location)")
    .eq("status", "confirmed")
    .eq("booked_date", todayStr);

  for (const b of todayBookings || []) {
    const bookingDt = new Date(`${b.booked_date}T${b.booked_time}`);
    const minsUntil = (bookingDt - now) / 60000;
    if (minsUntil < 50 || minsUntil > 70) continue;

    const master = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    await send(b.client_telegram_id,
      `🔔 <b>Через час ваша запись!</b>\n\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `👩‍🎨 ${master?.name || "Мастер"}\n` +
      (master?.location ? `📍 ${master.location}\n` : "") +
      `\nВремя: <b>${timeShort(b.booked_time)}</b> — ждём вас! 💜`
    );
  }

  // 24-hour reminder — tomorrow's bookings 23-25h from now
  const tomorrowStr = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().split("T")[0];
  const { data: tomorrowBookings } = await db
    .from("bookings")
    .select("*, masters(name, location)")
    .eq("status", "confirmed")
    .eq("booked_date", tomorrowStr);

  for (const b of tomorrowBookings || []) {
    const bookingDt = new Date(`${b.booked_date}T${b.booked_time}`);
    const hoursUntil = (bookingDt - now) / 3600000;
    if (hoursUntil < 23 || hoursUntil > 25) continue;

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
  }

  console.log("⏰ Reminder check done");
};

// Run immediately on start, then every hour
runReminders();
setInterval(runReminders, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════
// 4. EXPRESS HTTP SERVER
//    Called by the prototype for portfolio/review notifications
//    POST /notify  { to: "id" | ["id1","id2"], message: "text" }
//    GET  /health  → uptime check
// ════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json());

app.post("/notify", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "Missing 'to' or 'message'" });
  }

  const recipients = (Array.isArray(to) ? to : [String(to)]).filter(Boolean);
  let sent = 0;

  for (const chatId of recipients) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      sent++;
    } catch (e) {
      console.error(`Failed to send to ${chatId}:`, e.message);
    }
  }

  res.json({ ok: true, sent, total: recipients.length });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) + "s" });
});

app.listen(PORT, () => {
  console.log(`🤖 Uspot bot HTTP server running on port ${PORT}`);
  console.log(`📡 POST /notify  — send Telegram messages`);
  console.log(`💚 GET  /health  — uptime check`);
});
