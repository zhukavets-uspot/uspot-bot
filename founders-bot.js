// ============================================================
// Uspot Founders Bot — private notification channel for shareholders
// ============================================================
// Deploy: set FOUNDERS_BOT_TOKEN + FOUNDER_IDS in Railway env vars.
//   FOUNDERS_BOT_TOKEN — token from BotFather for the founders bot
//   FOUNDER_IDS        — comma-separated allowed Telegram user IDs
//                        e.g. "123456789,987654321"
//                        If empty, anyone who starts the bot is registered.
//
// Commands:
//   /start   — register for notifications
//   /today   — all bookings for today with status
//   /recent  — last 5 bookings
//   /stats   — 7-day summary (count, revenue, cancellations)
//   /help    — command list
//
// Notifications:
//   • Every new booking (Realtime INSERT)
//   • Booking cancelled (Realtime UPDATE → cancelled)
// ============================================================

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const FOUNDERS_BOT_TOKEN = process.env.FOUNDERS_BOT_TOKEN;
const SUPABASE_URL        = process.env.SUPABASE_URL || "https://heiyayufhuvlxhirgvyc.supabase.co";
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY;

// ── Early exit if token not configured ───────────────────────
if (!FOUNDERS_BOT_TOKEN) {
  console.log("ℹ️  FOUNDERS_BOT_TOKEN not set — Founders bot disabled. Set it in Railway env vars to enable.");
  module.exports = {};
  return;
}

// ── Whitelist: who is allowed to register ───────────────────
// If FOUNDER_IDS is empty, anyone who knows the bot can join.
// Recommended: set it to a comma-separated list of your Telegram IDs.
const ALLOWED_IDS = new Set(
  (process.env.FOUNDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const isAllowed = (chatId) => ALLOWED_IDS.size === 0 || ALLOWED_IDS.has(String(chatId));

const bot = new TelegramBot(FOUNDERS_BOT_TOKEN, { polling: true });
const db  = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Registered founders (in-memory, repopulated from Supabase on start) ─
const registeredFounders = new Set();

// ── Helpers ──────────────────────────────────────────────────
const send = async (chatId, text) => {
  try {
    await bot.sendMessage(String(chatId), text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error(`[Founders] Failed to send to ${chatId}:`, e.message);
  }
};

const broadcast = async (text) => {
  for (const chatId of registeredFounders) {
    await send(chatId, text);
  }
};

const M = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
const dateRu = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00");
  return `${d.getDate()} ${M[d.getMonth()]}`;
};
const t5 = (t) => (t || "").substring(0, 5);
const STATUS = { pending: "🟡", confirmed: "🟢", completed: "✅", cancelled: "❌" };

// ── Load registered founders from Supabase on startup ────────
const loadFounders = async () => {
  try {
    let q = db.from("shareholders").select("telegram_id").not("telegram_id", "is", null);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of data || []) {
      const id = String(row.telegram_id);
      if (isAllowed(id)) registeredFounders.add(id);
    }
    console.log(`[Founders] Loaded ${registeredFounders.size} registered founder(s)`);
  } catch (e) {
    console.error("[Founders] Could not load founders from Supabase:", e.message);
  }
};

// ── /start ───────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  const name   = msg.from?.first_name || "Founder";

  if (!isAllowed(chatId)) {
    await send(chatId,
      `⛔️ Доступ закрыт.\n\n` +
      `Этот бот предназначен только для акционеров Uspot.\n` +
      `Если вы акционер — обратитесь к команде.`
    );
    console.log(`[Founders] Rejected /start from ${chatId} (${name}) — not in whitelist`);
    return;
  }

  registeredFounders.add(chatId);
  console.log(`[Founders] Registered founder: ${chatId} (${name})`);

  // Persist to shareholders table so registration survives redeploys
  try {
    await db.from("shareholders").upsert(
      { telegram_id: chatId, name, notify_bookings: true },
      { onConflict: "telegram_id" }
    );
  } catch (e) {
    // Non-fatal: in-memory registration still works
    console.warn("[Founders] Could not persist to Supabase:", e.message);
  }

  await send(chatId,
    `👋 Привет, <b>${name}</b>!\n\n` +
    `Добро пожаловать в <b>Uspot Founders</b> — ваш приватный канал акционера.\n\n` +
    `Вы будете получать:\n` +
    `📅 Уведомление о каждой новой записи\n` +
    `❌ Уведомление об отменах\n\n` +
    `Команды для аналитики:\n` +
    `/today — все записи на сегодня\n` +
    `/recent — последние 5 записей\n` +
    `/stats — сводка за 7 дней\n` +
    `/help — список команд\n\n` +
    `Уведомления подключены. 💜`
  );
});

// ── /help ────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!registeredFounders.has(chatId)) return;

  await send(chatId,
    `<b>Uspot Founders — команды</b>\n\n` +
    `/today  — записи на сегодня\n` +
    `/recent — последние 5 записей\n` +
    `/stats  — сводка за 7 дней\n` +
    `/help   — этот список`
  );
});

// ── /today ───────────────────────────────────────────────────
bot.onText(/\/today/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!registeredFounders.has(chatId)) return;

  const todayStr = new Date().toISOString().split("T")[0];

  const { data, error } = await db
    .from("bookings")
    .select("*, masters(name)")
    .eq("booked_date", todayStr)
    .order("booked_time", { ascending: true });

  if (error) { await send(chatId, "⚠️ Ошибка при получении данных."); return; }

  // Filter out manual calendar blocks
  const bookings = (data || []).filter((b) => !b.client_name?.startsWith("🔒"));

  if (!bookings.length) {
    await send(chatId, `📅 <b>Сегодня, ${dateRu(todayStr)}</b>\n\nЗаписей нет.`);
    return;
  }

  const lines = bookings.map((b) => {
    const m   = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    const s   = STATUS[b.status] || "⚪";
    const who = b.client_name || "—";
    const to  = m?.name || b.master_name || "—";
    const svc = b.service_name ? ` · ${b.service_name}` : "";
    const prc = b.total_price  ? ` · ${b.total_price} BYN` : "";
    return `${s} <b>${t5(b.booked_time)}</b> ${who} → ${to}${svc}${prc}`;
  });

  const activeRevenue = bookings
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + (b.total_price || 0), 0);

  await send(chatId,
    `📅 <b>Сегодня, ${dateRu(todayStr)}</b> — ${bookings.length} записей\n\n` +
    lines.join("\n") + "\n\n" +
    `💰 Ожидаемая выручка: <b>${activeRevenue} BYN</b>`
  );
});

// ── /recent ──────────────────────────────────────────────────
bot.onText(/\/recent/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!registeredFounders.has(chatId)) return;

  const { data, error } = await db
    .from("bookings")
    .select("*, masters(name)")
    .not("client_name", "like", "🔒%")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) { await send(chatId, "⚠️ Ошибка при получении данных."); return; }

  if (!data?.length) {
    await send(chatId, "📋 Записей пока нет.");
    return;
  }

  const lines = data.map((b) => {
    const m   = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    const s   = STATUS[b.status] || "⚪";
    const prc = b.total_price ? `${b.total_price} BYN` : "—";
    return (
      `${s} ${dateRu(b.booked_date)} ${t5(b.booked_time)} · ` +
      `<b>${b.client_name || "—"}</b> → ${m?.name || b.master_name || "—"}\n` +
      `   ${b.service_name || "Услуга"} · ${prc}`
    );
  });

  await send(chatId,
    `🕐 <b>Последние записи</b>\n\n` + lines.join("\n\n")
  );
});

// ── /stats ───────────────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const chatId = String(msg.chat.id);
  if (!registeredFounders.has(chatId)) return;

  const now      = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const weekAgo  = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().split("T")[0];

  const { data, error } = await db
    .from("bookings")
    .select("status, total_price, master_name, masters(name)")
    .gte("booked_date", weekAgo)
    .lte("booked_date", todayStr)
    .not("client_name", "like", "🔒%");

  if (error) { await send(chatId, "⚠️ Ошибка при получении данных."); return; }

  if (!data?.length) {
    await send(chatId, "📊 За последние 7 дней записей нет.");
    return;
  }

  const total     = data.length;
  const confirmed = data.filter((b) => b.status === "confirmed").length;
  const completed = data.filter((b) => b.status === "completed").length;
  const cancelled = data.filter((b) => b.status === "cancelled").length;
  const pending   = data.filter((b) => b.status === "pending").length;
  const revenue   = data
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + (b.total_price || 0), 0);
  const cancelRate = total ? Math.round((cancelled / total) * 100) : 0;

  await send(chatId,
    `📊 <b>Сводка за 7 дней</b>\n\n` +
    `📅 Всего записей: <b>${total}</b>\n` +
    `🟡 Ожидает: <b>${pending}</b>\n` +
    `🟢 Подтверждено: <b>${confirmed}</b>\n` +
    `✅ Завершено: <b>${completed}</b>\n` +
    `❌ Отменено: <b>${cancelled}</b> (${cancelRate}%)\n\n` +
    `💰 Ожидаемая выручка: <b>${revenue} BYN</b>`
  );
});

// ════════════════════════════════════════════════════════════
// REALTIME — New booking → notify all founders instantly
// ════════════════════════════════════════════════════════════
db.channel("uspot-founders-inserts")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b = payload.new;

    // Skip personal/manual calendar blocks
    if (b.client_name?.startsWith("🔒")) return;

    console.log(`[Founders] New booking → broadcasting to ${registeredFounders.size} founders`);

    // Resolve master name if missing
    let masterName = b.master_name || "—";
    if (b.master_id && !b.master_name) {
      const { data: m } = await db.from("masters").select("name").eq("id", b.master_id).single();
      if (m?.name) masterName = m.name;
    }

    const price = b.total_price ? `${b.total_price} BYN` : "—";

    await broadcast(
      `📅 <b>Новая запись!</b>\n\n` +
      `👤 ${b.client_name || "Клиент"}\n` +
      `👩‍🎨 ${masterName}\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `📆 ${dateRu(b.booked_date)}, ${t5(b.booked_time)}\n` +
      `💳 ${price}`
    );
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log("[Founders] Realtime: listening for new bookings");
  });

// ════════════════════════════════════════════════════════════
// REALTIME — Booking cancelled → founders notified
// ════════════════════════════════════════════════════════════
db.channel("uspot-founders-cancellations")
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b   = payload.new;
    const old = payload.old;
    if (b.status !== "cancelled" || old.status === "cancelled") return;
    if (b.client_name?.startsWith("🔒")) return;

    console.log(`[Founders] Booking ${b.id} cancelled → notifying founders`);

    let masterName = b.master_name || "—";
    if (b.master_id && !b.master_name) {
      const { data: m } = await db.from("masters").select("name").eq("id", b.master_id).single();
      if (m?.name) masterName = m.name;
    }

    await broadcast(
      `❌ <b>Запись отменена</b>\n\n` +
      `👤 ${b.client_name || "Клиент"}\n` +
      `👩‍🎨 ${masterName}\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `📆 ${dateRu(b.booked_date)}, ${t5(b.booked_time)}\n` +
      `💳 ${b.total_price ? b.total_price + " BYN" : "—"}`
    );
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log("[Founders] Realtime: listening for cancellations");
  });

// ── Init ─────────────────────────────────────────────────────
loadFounders();
console.log("[Founders] Uspot Founders bot started ✅");

module.exports = {};
