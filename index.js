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
  // Telegram requires numeric IDs; usernames must have @ prefix.
  // If stored without @, add it so Telegram can resolve the username.
  let id = String(chatId).trim();
  if (id && !/^\d+$/.test(id) && !id.startsWith("@") && !id.startsWith("-")) {
    id = "@" + id;
  }
  try {
    await bot.sendMessage(id, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: inlineRows.length ? { inline_keyboard: inlineRows } : undefined,
    });
    console.log(`✉️  Sent to ${id}: ${text.substring(0, 60)}…`);
  } catch (e) {
    // "chat not found" usually means user hasn't started the bot yet — not a code bug
    if (e.message?.includes("chat not found") || e.message?.includes("user not found")) {
      console.warn(`⚠️  Cannot reach ${id} — user hasn't started the bot yet (store their numeric ID after first /start)`);
    } else {
      console.error(`⚠️  send failed to ${id}:`, e.message);
    }
  }
};

// ── Alias kept for call-sites that pass action rows explicitly ───────────
const sendWithKeyboard = async (chatId, text, actionRows = []) => {
  return send(chatId, text, actionRows);
};

/* ─── Адрес мастера ───────────────────────────────────────────────
   В базе лежит сырая строка геокодера («58, улица Максима Богдановича,
   Комаровка, Советский район, Минск, 220123»). Клиенту в подтверждении
   и в календаре нужен человеческий вид и способ доехать — иначе адрес
   приходится искать, возвращаясь в приложение. Логика та же, что в
   приложении (fmtAddr), чтобы адрес выглядел одинаково везде.        */
const STREET_TYPES = [
  [/^улиц[аы]$/i, "ул."], [/^ул\.?$/i, "ул."],
  [/^проспе?кт$/i, "просп."], [/^просп\.?$/i, "просп."], [/^пр-?т$/i, "просп."],
  [/^переулок$/i, "пер."], [/^пер\.?$/i, "пер."],
  [/^бульвар$/i, "бул."], [/^б-?р$/i, "бул."],
  [/^шоссе$/i, "ш."], [/^площадь$/i, "пл."], [/^пл\.?$/i, "пл."],
  [/^набережная$/i, "наб."], [/^проезд$/i, "проезд"],
  [/^тракт$/i, "тракт"], [/^алле[яи]$/i, "аллея"],
  [/^микрорайон$/i, "мкр"], [/^мкр\.?$/i, "мкр"],
];
const abbrevType = (w) => { for (const [re, ab] of STREET_TYPES) if (re.test(w)) return ab; return null; };
const isHouse    = (t) => /^\d+[а-яa-z]?(\s*(к|корп|стр)\.?\s*\d+[а-яa-z]?)?$/i.test(t);
const isPostal   = (t) => /^\d{5,6}$/.test(t);
const isDistrict = (t) => /(^|[^\p{L}])(район|область|области|сельсовет)([^\p{L}]|$)/iu.test(t);
const isCountry  = (t) => /^(республика\s+)?беларусь$|^belarus$/i.test(t.trim());

const fmtAddr = (raw = "") => {
  const src = String(raw || "").trim();
  if (!src) return "";
  const parts = src.split(",").map((t) => t.trim()).filter(Boolean);
  if (parts.length < 2) return src;
  let house = null, street = null, city = null;
  const rest = [];
  for (const t of parts) {
    if (isPostal(t)) continue;
    if (isHouse(t)) { if (!house) house = t; continue; }
    if (isDistrict(t) || isCountry(t)) continue;
    const words = t.split(/\s+/);
    const first = abbrevType(words[0]), last = abbrevType(words[words.length - 1]);
    if (!street && (first || last)) {
      street = first ? first + " " + words.slice(1).join(" ")
                     : last  + " " + words.slice(0, -1).join(" ");
      continue;
    }
    rest.push(t);
  }
  if (!city && rest.length) city = rest[rest.length - 1];
  if (!street) {
    const clean = parts.filter((t) => !isPostal(t) && !isDistrict(t));
    return clean.slice(0, 2).join(", ") || src;
  }
  const streetHouse = house ? `${street}, ${house}` : street;
  return city ? `${city}, ${streetHouse}` : streetHouse;
};

// Адрес + маршрут одной строкой. Пусто, если адреса нет — лишней строки не будет.
const addrBlock = (m) => {
  const a = fmtAddr(m?.location || "");
  if (!a) return "";
  const q = encodeURIComponent(a);
  const pt = (m?.lat && m?.lng) ? `${m.lat},${m.lng}` : null;
  const ya = pt ? `https://yandex.by/maps/?rtext=~${pt}&rtt=auto` : `https://yandex.by/maps/?text=${q}`;
  const gg = pt ? `https://www.google.com/maps/dir/?api=1&destination=${pt}`
                : `https://www.google.com/maps/search/?api=1&query=${q}`;
  return `📍 ${a}\n🗺 Маршрут: <a href="${ya}">Яндекс</a> · <a href="${gg}">Google</a>\n`;
};

/* ─── Захват права на отправку ────────────────────────────────────
   Каждое разовое сообщение о записи (подтверждение, напоминания, опрос)
   отправляется из двух мест: по событию Realtime и из сверки, которая
   чинит пропущенное. Оба раньше работали так: «посмотреть отметку →
   отправить → поставить отметку». Между «посмотреть» и «поставить»
   помещается второй отправитель — и клиент получает два сообщения.
   Именно так 3 сентября пришли подряд «Запись перенесена по вашей
   просьбе» и «Мастер подтвердил вашу запись» об одной записи.

   Лечится не проверкой, а захватом: отметка ставится ОДНИМ условным
   запросом «поставь, если пусто». База выполняет его атомарно, поэтому
   выигрывает ровно один отправитель, сколько бы их ни было и в каком бы
   порядке они ни пришли. Проигравший молчит.                        */
const claimOnce = async (bookingId, column) => {
  try {
    const { data, error } = await db.from("bookings")
      .update({ [column]: new Date().toISOString() })
      .eq("id", bookingId).is(column, null).select("id");
    if (error) { console.error(`claimOnce ${column}:`, error.message); return false; }
    return Array.isArray(data) && data.length > 0;
  } catch (e) { console.error(`claimOnce ${column}:`, e.message); return false; }
};

// Отправка не удалась — отпускаем захват, чтобы сообщение ушло со следующей сверкой
const releaseClaim = async (bookingId, column) => {
  try { await db.from("bookings").update({ [column]: null }).eq("id", bookingId); } catch (e) {}
};

/* ─── Временны́е границы ──────────────────────────────────────────
   Мастеру нужно время доехать: запись «через пятнадцать минут» ставит
   его в положение, из которого нет выхода. И симметрично — отмена за
   десять минут до визита оставляет окно пустым, заработать в него уже
   нельзя. Обе границы проверяются здесь, на сервере: клиент — сторона
   недоверенная, любые ограничения в интерфейсе обходятся.

   Мастера и салоны границы не касаются: они распоряжаются своим
   временем сами, в том числе в форс-мажоре.                         */
const BOOK_LEAD_MIN     = 60;    // записаться можно не позже чем за час
const CHANGE_CUTOFF_MIN = 120;   // отменить или перенести — не позже чем за два часа

// Сколько минут осталось до начала записи (минус — уже началась)
const minutesUntil = (dateIso, timeStr) => {
  const t = String(timeStr || "00:00").slice(0, 5);
  const startUtcMs = new Date(`${dateIso}T${t}:00+03:00`).getTime();   // Минск круглый год UTC+3
  return Math.round((startUtcMs - Date.now()) / 60000);
};

const humanLead = (min) => {
  if (min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? "час" : h < 5 ? `${h} часа` : `${h} часов`;
  }
  return `${min} минут`;
};

/* Поздно ли клиенту менять запись. Возвращает текст отказа или null.
   Отказ обязан давать выход: человек с настоящим форс-мажором должен
   иметь возможность достучаться, а не упереться в стену. */
const tooLateToChange = async (bookingId, what = "отменить") => {
  const { data: bk } = await db.from("bookings")
    .select("booked_date, booked_time, status, service_name").eq("id", bookingId).single();
  if (!bk) return null;
  if (bk.status === "cancelled" || bk.status === "declined") return null;
  const left = minutesUntil(bk.booked_date, bk.booked_time);
  if (left >= CHANGE_CUTOFF_MIN) return null;
  const when = left < 0 ? "уже началась" : `начнётся через ${left} мин`;
  return `⏳ <b>Поздно ${what}</b>\n\n` +
    `Запись ${when}. Менять её можно не позже чем за ${humanLead(CHANGE_CUTOFF_MIN)} до начала — ` +
    `мастер уже держит для вас время и не успеет занять окно.\n\n` +
    `Если случился форс-мажор — напишите нам, разберёмся вручную.`;
};
const forceMajeureKb = (bookingId) => ([[
  { text: "✉️ Написать нам", web_app: { url: `${MINI_APP_URL}?startapp=help_${bookingId}` } },
]]);

/* ─── Поиск свободных окон мастера ────────────────────────────────
   Нужен для переноса по инициативе мастера: бот предлагает конкретные
   времена, а не отправляет мастера искать их вручную. Учитывает недельный
   шаблон, переопределения на конкретную дату и уже занятое время.
   Возвращает первые `count` окон начиная с завтрашнего дня.            */
const minutesOf = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const freeSlotsFor = async (masterId, durMin = 60, count = 6, daysAhead = 14, skipBookingId = null, perDay = 0) => {
  if (!masterId) return [];
  const [{ data: week }, { data: overrides }] = await Promise.all([
    db.from("master_schedule").select("day_of_week, is_working, start_time, end_time").eq("master_id", masterId),
    db.from("master_schedule_dates").select("date, is_working, start_time, end_time").eq("master_id", masterId),
  ]);
  const weekMap = {};
  (week || []).forEach((r) => { weekMap[r.day_of_week] = r; });
  const ovMap = {};
  (overrides || []).forEach((r) => { ovMap[r.date] = r; });

  const fromIso = minskDateStr(1);                         // с завтрашнего дня
  const toIso   = minskDateStr(daysAhead);
  const { data: booked } = await db.from("bookings")
    .select("id, booked_date, booked_time, duration_min")
    .eq("master_id", masterId).gte("booked_date", fromIso).lte("booked_date", toIso)
    .not("status", "in", "(cancelled,declined)");
  const busyByDate = {};
  (booked || []).forEach((b) => {
    if (skipBookingId && b.id === skipBookingId) return;    // саму переносимую запись не учитываем
    (busyByDate[b.booked_date] ||= []).push({
      s: minutesOf(b.booked_time), e: minutesOf(b.booked_time) + (+b.duration_min || 60),
    });
  });

  const out = [];
  for (let d = 1; d <= daysAhead && out.length < count; d++) {
    const iso = minskDateStr(d);
    const jsDay = new Date(iso + "T12:00:00").getDay();
    const dow = jsDay === 0 ? 6 : jsDay - 1;               // 0 = понедельник
    const row = ovMap[iso] || weekMap[dow];
    if (!row || row.is_working === false) continue;
    const from = minutesOf(row.start_time || "09:00");
    const to   = minutesOf(row.end_time   || "18:00");
    const busy = busyByDate[iso] || [];
    /* perDay ограничивает число окон с одного дня. Без него мастеру
       предлагались шесть подряд идущих получасовок одного утра — выбирать
       по сути не из чего. С разбросом видно разные дни и время суток. */
    const dayHits = [];
    for (let t = from; t + durMin <= to; t += 30) {
      if (busy.some((b) => b.s < t + durMin && b.e > t)) continue;
      dayHits.push(hhmm(t));
    }
    if (!dayHits.length) continue;
    const take = perDay > 0 ? Math.min(perDay, dayHits.length) : dayHits.length;
    // Берём равномерно по дню: утро, середина, вечер — а не первые подряд
    for (let k = 0; k < take && out.length < count; k++) {
      const idx = take === 1 ? 0 : Math.round((k * (dayHits.length - 1)) / (take - 1));
      out.push({ date: iso, time: dayHits[idx] });
    }
  }
  return out;
};

/* Мёртвая привязка календаря.
   invalid_grant означает, что refresh-токен больше не действует: доступ
   отозвали, токен протух (выданные, пока приложение было в режиме
   тестирования, живут 7 дней) или аккаунт удалён. Такой токен не
   «полечится» повторной попыткой — раньше бот молча долбился в него
   каждые 10 минут и засорял логи, а владелец не знал, что синхронизация
   давно умерла. Теперь: убираем запись и один раз зовём переподключиться. */
const deadGrantNotified = new Set();
const isDeadGrant = (e) => {
  const t = `${e?.message || ""} ${JSON.stringify(e?.response?.data || {})}`;
  return /invalid_grant|Token has been expired or revoked|unauthorized_client/i.test(t);
};
const dropDeadGrant = async (tgId, where = "") => {
  const id = String(tgId || "");
  if (!id) return;
  try { await db.from("master_gcal_tokens").delete().eq("master_telegram_id", id); } catch (e) {}
  console.warn(`🔌 GCal: привязка ${id} мертва (${where}) — удалена, нужно переподключение`);
  if (deadGrantNotified.has(id)) return;
  deadGrantNotified.add(id);
  // Кому вообще принадлежит эта привязка: мастеру, клиенту или никому
  let owner = null;
  try {
    const { data: m } = await db.from("masters").select("id").eq("telegram_user_id", id).limit(1);
    if (m?.length) owner = "master";
    else {
      const { data: c } = await db.from("clients").select("telegram_user_id").eq("telegram_user_id", id).limit(1);
      if (c?.length) owner = "client";
    }
  } catch (e) {}
  if (!owner) return;                       // осиротевшая тестовая привязка — молча убрали
  try {
    await send(id,
      `⚠️ <b>Google Календарь отключился</b>\n\n` +
      `Google отозвал доступ — так бывает, если сменился пароль или доступ убрали в настройках аккаунта.\n\n` +
      `Записи в календарь пока не попадают. Подключить заново: ` +
      (owner === "master" ? `<b>Профиль → Google Календарь</b>.` : `<b>Профиль → Google Календарь</b> в Uspot.`));
  } catch (e) {}
};

// Мастер целиком — для сообщений, где нужен ещё и адрес
const masterCache1h = new Map();
const getMasterFull = async (masterId) => {
  if (!masterId) return null;
  const hit = masterCache1h.get(masterId);
  if (hit && Date.now() - hit.t < 60 * 60 * 1000) return hit.m;
  const { data } = await db.from("masters")
    .select("name, telegram_user_id, location, city, lat, lng").eq("id", masterId).single();
  masterCache1h.set(masterId, { m: data || null, t: Date.now() });
  return data || null;
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
// REALTIME RESILIENCE
// Supabase channels die on "heartbeat timeout" / socket close and do NOT
// recover on their own. When that happened silently on 2026-08-25, every new
// booking stopped notifying the master AND stopped syncing to Google Calendar
// until the process was restarted. These helpers resubscribe on failure and a
// watchdog re-checks state periodically (a dead socket does not always fire
// the status callback).
// ════════════════════════════════════════════════════════════
const rtRetries = {};
// Bookings this process has already announced to the master. Used by the
// reconciler below so a repair sweep never double-alerts.
const handledBookings = new Set();
const BOOT_AT = new Date().toISOString();
/* Переподписка съедала сама себя. subXxx() удаляет старый канал, тот
   отдаёт статус CLOSED, его же обработчик видит CLOSED и планирует ещё
   одну переподписку — и так по кругу. Сверху сторож каждые две минуты
   добавлял свои. Каналы копились, и одно изменение записи приходило
   клиенту столько раз, сколько их накопилось: отсюда двойные сообщения.

   Лечим тремя вещами: у каждого канала есть поколение, отклик старого
   поколения игнорируется; одновременная переподписка блокируется флагом;
   и на всякий случай события отсеиваются по (запись + статус). */
const rtGeneration = {};
const rtResubBusy  = {};
const rtStatus = (label, resubscribe, gen) => (status, err) => {
  if (gen !== rtGeneration[label]) return;          // отклик отменённого канала
  if (status === "SUBSCRIBED") {
    rtRetries[label] = 0;
    rtResubBusy[label] = false;
    console.log(`✅ Realtime: listening for ${label}`);
    return;
  }
  console.error(`❌ Realtime ${label}: ${status}`, err?.message || "");
  if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
    // Попытка закончилась неудачей — снимаем флаг, иначе и сторож, и
    // повторная попытка окажутся заблокированы навсегда
    rtResubBusy[label] = false;
    const n = rtRetries[label] = (rtRetries[label] || 0) + 1;
    const delay = Math.min(5000 * n, 60000);
    console.log(`🔁 Realtime ${label}: reconnecting in ${delay / 1000}s (attempt ${n})`);
    setTimeout(resubscribe, delay);
  }
};

/* Отсев повторов. Даже если каналов почему-то окажется два, один и тот
   же переход записи не будет объявлен дважды. Ключ живёт 10 минут —
   этого хватает на любые задержки доставки. */
const rtSeen = new Map();
const rtFirstTime = (key) => {
  const now = Date.now();
  for (const [k, t] of rtSeen) if (now - t > 10 * 60 * 1000) rtSeen.delete(k);
  if (rtSeen.has(key)) { console.warn(`↩️  Повтор события пропущен: ${key}`); return false; }
  rtSeen.set(key, now);
  return true;
};

// ════════════════════════════════════════════════════════════
// SUPABASE REALTIME — New booking (INSERT)
// Bug #1: verify realtime is active, log on subscribe
// ════════════════════════════════════════════════════════════
let chNewBookings = null;
const subNewBookings = () => {
  const gen = (rtGeneration["new bookings"] = (rtGeneration["new bookings"] || 0) + 1);
  rtResubBusy["new bookings"] = true;
  if (chNewBookings) { try { db.removeChannel(chNewBookings); } catch (e) {} }
  chNewBookings = db.channel("uspot-new-bookings")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b = payload.new;
    if (b.client_name?.startsWith("🔒")) return; // skip manual blocks
    if (!rtFirstTime(`new:${b.id}`)) return;
    handledBookings.add(b.id);
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
        // Перенос показываем как перенос: видно, что было и что стало
        let wasLine = "";
        if (b.reschedule_of) {
          const { data: prev } = await db.from("bookings")
            .select("booked_date, booked_time").eq("id", b.reschedule_of).single();
          if (prev) wasLine = `📅 Было: ${dateRu(prev.booked_date)}, ${timeShort(prev.booked_time)}\n`;
        }
        await sendWithKeyboard(masterTgId,
          (b.reschedule_of ? `📅 <b>Клиент просит перенести запись</b>\n\n` : `📅 <b>Новая запись!</b>\n\n`) +
          `👤 ${b.client_name || "Клиент"}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          wasLine +
          `${b.reschedule_of ? "📅 Стало: " : "📆 "}${date}, ${time}\n` +
          `💳 ${price}\n\n` +
          (b.reschedule_of ? `Подтвердите перенос или предложите другое время:`
                           : `Подтвердите или предложите другое время:`),
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
          (b.reschedule_of ? `⏳ <b>Запрос на перенос отправлен</b>\n\n` : `⏳ <b>Запись отправлена!</b>\n\n`) +
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
    // То же событие — в календарь клиента, если он подключал свой
    pushClientGcal(b, masterName, b.status === "pending").catch(e =>
      console.error("GCal клиента (новая запись):", e.message)
    );
  })
  .subscribe(rtStatus("new bookings", subNewBookings, gen));
};
subNewBookings();

// ════════════════════════════════════════════════════════════
// SUPABASE REALTIME — Booking updates (UPDATE)
// ════════════════════════════════════════════════════════════
let chBookingUpdates = null;
const subBookingUpdates = () => {
  const gen = (rtGeneration["booking updates"] = (rtGeneration["booking updates"] || 0) + 1);
  rtResubBusy["booking updates"] = true;
  if (chBookingUpdates) { try { db.removeChannel(chBookingUpdates); } catch (e) {} }
  chBookingUpdates = db.channel("uspot-booking-updates")
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "bookings",
  }, async (payload) => {
    const b   = payload.new;
    const old = payload.old || {};
    /* Postgres по умолчанию кладёт в поток репликации только ключ старой
       строки, поэтому old.status бывает пустым. Раньше на этом молча
       умирала ветка подтверждения. Теперь отличаем «статус был другим»
       от «мы не знаем, каким он был». */
    const oldKnown  = Object.keys(old).length > 1;
    const oldStatus = oldKnown ? old.status : undefined;
    if (!oldKnown) console.warn(`⚠️  Realtime: старая строка не пришла (REPLICA IDENTITY не FULL) — применяю патч v15`);

    // ── Салон переназначил запись на другого мастера ──────────────
    // Отдельная ветка: статус при этом не меняется, поэтому проверку
    // ниже она бы не прошла. Клиенту сообщаем честно, кто его примет.
    if (b.master_id && old.master_id && b.master_id !== old.master_id) {
      // Ветка идёт до общего отсева повторов, поэтому нужен свой ключ
      if (!rtFirstTime(`reassign:${b.id}:${b.master_id}`)) return;
      console.log(`🔀 Booking ${b.id}: мастер ${old.master_id} → ${b.master_id}`);
      try {
        const [{ data: newM }, { data: oldM }] = await Promise.all([
          db.from("masters").select("name, telegram_user_id, salon_id").eq("id", b.master_id).single(),
          db.from("masters").select("name, telegram_user_id").eq("id", old.master_id).single(),
        ]);
        const d = dateRu(b.booked_date), t = timeShort(b.booked_time);

        if (b.client_telegram_id) {
          await sendWithKeyboard(b.client_telegram_id,
            `🔀 <b>Вашу запись передали другому мастеру</b>\n\n` +
            `Было: ${oldM?.name || "мастер"}\n` +
            `Стало: <b>${newM?.name || "мастер"}</b>\n\n` +
            `💇 ${b.service_name || "Услуга"}\n` +
            `📆 ${d}, ${t} — время прежнее\n` +
            `💳 ${b.total_price ? b.total_price + " BYN" : "—"}\n\n` +
            `Если так не подходит — выберите другое время, мы всё сохраним.`,
            [[
              { text: "✅ Подходит",           callback_data: `keep_${b.id}` },
              { text: "📅 Другое время",       callback_data: `reschedule_${b.id}` },
            ]]
          );
        }
        if (newM?.telegram_user_id) {
          await send(newM.telegram_user_id,
            `📅 <b>Вам передали запись</b>\n\n` +
            `👤 ${b.client_name || "Клиент"}\n💇 ${b.service_name || "Услуга"}\n📆 ${d}, ${t}`);
        }
        if (oldM?.telegram_user_id) {
          await send(oldM.telegram_user_id,
            `↪️ <b>Запись передана другому мастеру</b>\n\n` +
            `👤 ${b.client_name || "Клиент"}\n📆 ${d}, ${t}\n\nОна больше не в вашем расписании.`);
        }
        // Календарь: убираем у прежнего мастера, заводим у нового
        await deleteFromGcal(b.id).catch(() => {});
        await db.from("bookings").update({ gcal_event_id: null, gcal_calendar_id: null }).eq("id", b.id);
        if (newM?.telegram_user_id) {
          pushToGcal({ ...b, gcal_event_id: null }, newM.telegram_user_id, newM.name || "Мастер",
                     b.status === "pending").catch(e => console.error("GCal reassign:", e.message));
        }
        // У клиента событие не удаляем, а переписываем: время то же, мастер другой
        updateClientGcal(b, newM?.name || "Мастер", b.status === "pending")
          .catch(e => console.error("GCal клиента (передача):", e.message));
      } catch (e) {
        console.error("Ошибка переназначения:", e.message);
      }
    }

    if (oldKnown && b.status === oldStatus) return;
    if (!rtFirstTime(`upd:${b.id}:${b.status}`)) return;
    console.log(`🔄 Booking ${b.id}: ${oldStatus ?? "?"} → ${b.status}`);

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
    /* Отметка — единственный источник правды о том, сказали ли клиенту.
       Перенос по предложению мастера отправляет своё сообщение и ставит
       отметку сам, поэтому обычное «мастер подтвердил» сюда не приходит. */
    if (b.status === "confirmed" && !b.client_confirm_notified_at &&
        (oldStatus === "pending" || !oldKnown)) {
      // Захват до отправки: если сверка успела раньше — молчим
      if (b.client_telegram_id && await claimOnce(b.id, "client_confirm_notified_at")) {
        const mFull = await getMasterFull(b.master_id);
        try {
        await sendWithKeyboard(b.client_telegram_id,
          (b.reschedule_of
            ? `✅ <b>Запись перенесена по вашей просьбе</b>\n\n`
            : `✅ <b>Мастер подтвердил вашу запись!</b>\n\n`) +
          `👩‍🎨 ${masterName}\n` +
          `💇 ${b.service_name || "Услуга"}\n` +
          `📆 ${date}, ${time}\n` +
          `💳 ${price}\n` +
          addrBlock(mFull) +
          (b.reschedule_of ? `\nЖдём вас в новое время! 💜` : `\nЖдём вас в Uspot! 💜`),
          [[
            { text: "📅 Перенести", callback_data: `reschedule_${b.id}` },
            { text: "❌ Отменить",  callback_data: `client_cancel_${b.id}` },
          ]]
        );
        /* Номер спрашиваем здесь, а не при создании записи: сразу после
           отправки человек ждёт ответа мастера, и просьба о телефоне в тот
           же миг читается как лишнее уведомление. Пауза — чтобы это была
           отдельная мысль, а не часть очереди сообщений. */
        } catch (e) {
          // Не ушло — отпускаем захват, сверка попробует ещё раз
          console.error("Подтверждение клиенту не отправлено:", e.message);
          await releaseClaim(b.id, "client_confirm_notified_at");
          throw e;
        }
        setTimeout(() => { askPhoneOnce(b.client_telegram_id).catch(() => {}); }, 15000);
        // Серое «ожидает» в календаре клиента становится зелёным подтверждённым
        updateClientGcal(b, masterName, false).catch(e =>
          console.error("GCal клиента (подтверждение):", e.message)
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
    else if (b.status === "declined" && oldStatus !== "declined") {
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
      deleteClientGcal(b.id).catch(() => {});
    }

    // → cancelled
    else if (b.status === "cancelled" && oldStatus !== "cancelled") {
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
        deleteClientGcal(b.id).catch(() => {});
      } else if (reason.startsWith("master:") || reason === "force_majeure") {
        /* Отмену через удаление события в календаре клиенту сообщает сама
           синхронизация — она и есть действующее лицо. Если написать ещё и
           отсюда, человек получит два одинаковых сообщения подряд: ровно
           это и было 2 сентября. У каждого сообщения один хозяин. */
        const fromCalendar = reason === "master:gcal_delete";
        // Master cancelled — notify client to rebook
        if (b.client_telegram_id && !fromCalendar) {
          await sendWithKeyboard(b.client_telegram_id,
            `❌ <b>Запись отменена мастером</b>\n\n` +
            `💇 ${b.service_name || "Услуга"}\n` +
            `📆 ${date}, ${time}\n\n` +
            `Выберите другую дату — записаться снова очень просто! 💜`,
            [[{ text: "📅 Записаться снова", web_app: { url: `${MINI_APP_URL}?startapp=m${b.master_id}` } }]]
          );
        }
        deleteFromGcal(b.id).catch(() => {});
        deleteClientGcal(b.id).catch(() => {});
      }
    }

    // → completed
    else if (b.status === "completed" && oldStatus !== "completed") {
      console.log("✅ Booking completed:", b.id);
      // Review request is handled by the hourly cron (3-4h window after booking)
    }
  })
  .subscribe(rtStatus("booking updates", subBookingUpdates, gen));
};
subBookingUpdates();

// Watchdog: a silently dropped socket does not always fire the status callback,
// so re-check both channels every 2 min and force a resubscribe if not joined.
setInterval(() => {
  const checks = [
    ["new bookings",    chNewBookings,     subNewBookings],
    ["booking updates", chBookingUpdates,  subBookingUpdates],
  ];
  for (const [label, ch, resub] of checks) {
    const state = ch?.state;
    // "joining" — нормальное промежуточное состояние; вмешиваться в него
    // значило заводить второй канал поверх ещё живого
    if (state === "joined" || state === "joining") continue;
    if (rtResubBusy[label]) continue;
    console.warn(`🩺 Realtime watchdog: ${label} state="${state}" — resubscribing`);
    resub();
  }
}, 2 * 60 * 1000);

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
  /* Мастер предлагает клиенту другое время.
     Раньше эта кнопка просто отклоняла запись и клиент оставался ни с чем.
     Теперь бот показывает мастеру его же свободные окна, мастер выбирает
     одно, и клиент получает конкретное предложение с выбором. */
  if (data.startsWith("suggest_")) {
    const bookingId = data.slice(8);
    try {
      const { data: bk } = await db.from("bookings")
        .select("master_id, duration_min, service_name, client_name, booked_date, booked_time, status")
        .eq("id", bookingId).single();
      if (!bk) { await bot.answerCallbackQuery(query.id, { text: "Запись не найдена" }); return; }
      if (bk.status === "cancelled" || bk.status === "declined") {
        await bot.answerCallbackQuery(query.id, { text: "Запись уже отменена" }); return;
      }
      const slots = await freeSlotsFor(bk.master_id, +bk.duration_min || 60, 6, 14, bookingId, 2);
      await bot.answerCallbackQuery(query.id);
      if (!slots.length) {
        await send(chatId,
          `⏰ <b>Свободных окон нет</b>\n\nНа ближайшие две недели в вашем расписании нет места ` +
          `под эту услугу. Освободите время в расписании или отклоните запись.`);
        return;
      }
      const rows = slots.map((x) => ([{
        text: `${dateRu(x.date)}, ${x.time}`,
        callback_data: `sprop_${bookingId}_${x.date}_${x.time.replace(":", "")}`,
      }]));
      await send(chatId,
        `⏰ <b>Предложить другое время</b>\n\n` +
        `👤 ${bk.client_name || "Клиент"}\n` +
        `💇 ${bk.service_name || "Услуга"}\n` +
        `Просили: ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}\n\n` +
        `Выберите, что предложить взамен — клиент подтвердит или выберет сам:`,
        rows);
      return;
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка" });
      console.error("[Callback] suggest error:", e.message);
      return;
    }
  }

  if (data.startsWith("__legacy_suggest_")) {
    const bookingId = data.slice(17);
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

  /* Мастер выбрал время → предложение уходит клиенту.
     Запись остаётся в статусе «ожидает»: пока клиент не согласился,
     ничего не меняем — иначе он придёт к отменённому времени. */
  if (data.startsWith("sprop_")) {
    const rest = data.slice(6);
    const bookingId = rest.slice(0, 36);
    const iso  = rest.slice(37, 47);
    const hm   = rest.slice(48);
    const time = `${hm.slice(0, 2)}:${hm.slice(2)}`;
    try {
      const { data: bk } = await db.from("bookings")
        .select("client_telegram_id, service_name, booked_date, booked_time, master_id, total_price")
        .eq("id", bookingId).single();
      if (!bk) { await bot.answerCallbackQuery(query.id, { text: "Запись не найдена" }); return; }
      // Двойное нажатие той же кнопки не должно слать клиенту два предложения
      if (!rtFirstTime(`sprop:${bookingId}:${iso}:${hm}`)) {
        await bot.answerCallbackQuery(query.id, { text: "Уже предложено" });
        return;
      }
      await db.from("bookings")
        .update({ proposed_date: iso, proposed_time: time + ":00" }).eq("id", bookingId);
      await bot.answerCallbackQuery(query.id, { text: "Предложение отправлено" });
      await bot.editMessageText(
        `⏰ <b>Предложено: ${dateRu(iso)}, ${time}</b>\n\nЖдём ответа клиента — сообщим сразу.`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }).catch(() => {});

      if (bk.client_telegram_id) {
        const mFull = await getMasterFull(bk.master_id);
        await sendWithKeyboard(bk.client_telegram_id,
          `⏰ <b>Мастер просит перенести запись</b>\n\n` +
          `👩‍🎨 ${mFull?.name || "Мастер"}\n` +
          `💇 ${bk.service_name || "Услуга"}\n` +
          `📅 Вы просили: ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}\n` +
          `📅 Мастер предлагает: <b>${dateRu(iso)}, ${time}</b>\n` +
          addrBlock(mFull) +
          `\nПодходит новое время?`,
          [[{ text: "✅ Подтвердить", callback_data: `sok_${bookingId}_${iso}_${hm}` }],
           [{ text: "📅 Выбрать другое время", callback_data: `reschedule_${bookingId}` }]]);
      }
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка" });
      console.error("[Callback] sprop error:", e.message);
    }
    return;
  }

  /* Клиент согласился на предложенное время.
     Слот перепроверяем: пока человек думал, мастер мог занять его другой
     записью — тогда честно говорим и предлагаем выбрать самому. */
  if (data.startsWith("sok_")) {
    const rest = data.slice(4);
    const bookingId = rest.slice(0, 36);
    const iso  = rest.slice(37, 47);
    const hm   = rest.slice(48);
    const time = `${hm.slice(0, 2)}:${hm.slice(2)}`;
    try {
      const { data: bk } = await db.from("bookings").select("*").eq("id", bookingId).single();
      if (!bk) { await bot.answerCallbackQuery(query.id, { text: "Запись не найдена" }); return; }
      if (bk.status === "cancelled" || bk.status === "declined") {
        await bot.answerCallbackQuery(query.id, { text: "Запись уже отменена" });
        await send(chatId, `Эта запись уже отменена. Выберите новое время в приложении.`);
        return;
      }
      /* Второе нажатие «Подтвердить»: запись уже стоит на этом времени.
         Без проверки перенос выполнился бы ещё раз и оба — клиент и мастер —
         получили бы по второму сообщению об одном и том же. */
      if (bk.booked_date === iso && String(bk.booked_time).slice(0, 5) === time
          && bk.status === "confirmed") {
        await bot.answerCallbackQuery(query.id, { text: "Уже перенесено" });
        return;
      }
      const free = await freeSlotsFor(bk.master_id, +bk.duration_min || 60, 200, 21, bookingId);
      if (!free.some((x) => x.date === iso && x.time === time)) {
        await bot.answerCallbackQuery(query.id, { text: "Это время уже занято" });
        await sendWithKeyboard(chatId,
          `😔 <b>Это время только что заняли</b>\n\nВыберите, пожалуйста, другое — свободные окна видно в приложении.`,
          [[{ text: "📅 Выбрать время", callback_data: `reschedule_${bookingId}` }]]);
        return;
      }
      const mFull = await getMasterFull(bk.master_id);
      await db.from("bookings").update({
        booked_date: iso, booked_time: time + ":00", status: "confirmed",
        proposed_date: null, proposed_time: null,
        // Своё сообщение уже отправим ниже — обычное «мастер подтвердил» не нужно
        client_confirm_notified_at: new Date().toISOString(),
      }).eq("id", bookingId);
      await bot.answerCallbackQuery(query.id, { text: "Перенесено!" });

      await sendWithKeyboard(chatId,
        `✅ <b>Запись перенесена</b>\n\n` +
        `👩‍🎨 ${mFull?.name || "Мастер"}\n` +
        `💇 ${bk.service_name || "Услуга"}\n` +
        `📆 <b>${dateRu(iso)}, ${time}</b>\n` +
        (bk.total_price ? `💳 ${bk.total_price} BYN\n` : "") +
        addrBlock(mFull) +
        `\nЖдём вас! 💜`,
        [[{ text: "📅 Перенести", callback_data: `reschedule_${bookingId}` },
          { text: "❌ Отменить",  callback_data: `client_cancel_${bookingId}` }]]);

      if (mFull?.telegram_user_id) {
        await send(mFull.telegram_user_id,
          `✅ <b>Клиент согласился на перенос</b>\n\n` +
          `👤 ${bk.client_name || "Клиент"}\n` +
          `💇 ${bk.service_name || "Услуга"}\n` +
          `📅 Было: ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}\n` +
          `📅 Стало: <b>${dateRu(iso)}, ${time}</b>`);
      }

      // Календари: у мастера событие пересоздаём, у клиента переписываем
      const moved = { ...bk, booked_date: iso, booked_time: time + ":00", status: "confirmed" };
      deleteFromGcal(bookingId)
        .then(() => db.from("bookings").update({ gcal_event_id: null, gcal_calendar_id: null }).eq("id", bookingId))
        .then(() => mFull?.telegram_user_id &&
          pushToGcal({ ...moved, gcal_event_id: null }, mFull.telegram_user_id, mFull.name || "Мастер", false))
        .catch((e) => console.error("GCal перенос (мастер):", e.message));
      updateClientGcal(moved, mFull?.name || "Мастер", false)
        .catch((e) => console.error("GCal перенос (клиент):", e.message));
      console.log(`📅 Перенос подтверждён клиентом: ${bookingId} → ${iso} ${time}`);
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка" });
      console.error("[Callback] sok error:", e.message);
    }
    return;
  }

  // Client: Reschedule (from bot button)
  if (data.startsWith("keep_")) {
    const id = data.replace("keep_", "");
    await bot.answerCallbackQuery(query.id, { text: "Отлично, ждём вас!" });
    await send(chatId, `✅ Спасибо! Запись сохранена, мастер вас ждёт.`);
    console.log(`👍 Клиент подтвердил замену мастера, booking ${id}`);
    return;
  }

  if (data.startsWith("reschedule_")) {
    const bookingId = data.slice(11);
    const late = await tooLateToChange(bookingId, "переносить");
    if (late) {
      await bot.answerCallbackQuery(query.id, { text: "Слишком близко к началу" });
      await sendWithKeyboard(chatId, late, forceMajeureKb(bookingId));
      return;
    }
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
    const late = await tooLateToChange(bookingId, "отменить");
    if (late) {
      await bot.answerCallbackQuery(query.id, { text: "Слишком близко к началу" });
      await sendWithKeyboard(chatId, late, forceMajeureKb(bookingId));
      return;
    }
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
      `Нажмите кнопку ниже для авторизации. После этого все новые подтверждённые записи будут автоматически появляться в вашем <b>основном Google Календаре</b>.`,
      [[{ text: "🔗 Авторизоваться в Google", url: authUrl }]]
    );
    return;
  }
});

// Message handler: free-text cancel reasons
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);

  // Клиент поделился номером кнопкой — сохраняем и убираем клавиатуру.
  // Берём только свой контакт: пересланный чужой не наш.
  if (msg.contact) {
    const c = msg.contact;
    if (String(c.user_id || "") !== chatId) {
      await bot.sendMessage(chatId, "Это чужой контакт — поделитесь, пожалуйста, своим номером.",
        { reply_markup: { remove_keyboard: true } });
      return;
    }
    const phone = String(c.phone_number || "").slice(0, 32);
    try {
      await db.from("clients").update({ phone }).eq("telegram_user_id", chatId);
      await bot.sendMessage(chatId,
        "Спасибо! Номер сохранён — позвоним только если что-то срочное по записи.",
        { reply_markup: { remove_keyboard: true } });
      console.log(`📞 Телефон сохранён для ${chatId}`);
    } catch (e) {
      console.error("phone save:", e.message);
      await bot.sendMessage(chatId, "Не получилось сохранить номер. Ничего страшного — попробуем позже.",
        { reply_markup: { remove_keyboard: true } });
    }
    return;
  }

  // Вежливый отказ на просьбу о номере — снимаем клавиатуру и больше не просим
  if (msg.text && msg.text.trim() === "Не сейчас") {
    try { await db.from("clients")
      .update({ phone_asked_at: new Date().toISOString() }).eq("telegram_user_id", chatId); } catch (e) {}
    await bot.sendMessage(chatId, "Хорошо, не будем спрашивать. Всё по записи придёт сюда.",
      { reply_markup: { remove_keyboard: true } });
    return;
  }

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
    .select("*, masters(name, location, lat, lng)")
    .eq("status", "confirmed").eq("booked_date", todayStr);

  for (const b of todayBookings || []) {
    if (!b.client_telegram_id) continue;
    const key = `${b.id}_1h`;
    if (sentReminders.has(key) || b.reminded_1h_at) continue;
    const bookingUtc = parseMinsKDt(b.booked_date, b.booked_time || "00:00:00");
    const minsUntil  = (bookingUtc - now) / 60000;
    // Окно широкое: сверка идёт часто, а отметка в базе не даёт повторов.
    // Раньше окно было 10 минут при часовом тике — напоминание почти не уходило.
    if (minsUntil < 10 || minsUntil > 75) continue;
    // Захват только когда время действительно пришло: иначе пометили бы
    // все сегодняшние записи разом, и напоминание не ушло бы вообще
    if (!(await claimOnce(b.id, "reminded_1h_at"))) continue;
    const master = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    await send(b.client_telegram_id,
      `🔔 <b>Через час ваша запись!</b>\n\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `👩‍🎨 ${master?.name || "Мастер"}\n` +
      addrBlock(master) +
      `\nВремя: <b>${timeShort(b.booked_time)}</b> — ждём вас! 💜`
    );
    sentReminders.add(key);
    console.log(`✉️  1h reminder sent: booking ${b.id}`);
  }

  // 24h reminder
  const { data: tomorrowBookings } = await db.from("bookings")
    .select("*, masters(name, location, lat, lng)")
    .eq("status", "confirmed").eq("booked_date", tomorrowStr);

  for (const b of tomorrowBookings || []) {
    if (!b.client_telegram_id) continue;
    const key = `${b.id}_24h`;
    if (sentReminders.has(key) || b.reminded_24h_at) continue;
    const bookingUtc  = parseMinsKDt(b.booked_date, b.booked_time || "00:00:00");
    const hoursUntil  = (bookingUtc - now) / 3600000;
    if (hoursUntil < 12 || hoursUntil > 26) continue;
    if (b.created_at && (now - new Date(b.created_at)) / 3600000 < 4) continue;
    if (!(await claimOnce(b.id, "reminded_24h_at"))) continue;
    const master = Array.isArray(b.masters) ? b.masters[0] : b.masters;
    await send(b.client_telegram_id,
      `⏰ <b>Напоминание на завтра</b>\n\n` +
      `Завтра в <b>${timeShort(b.booked_time)}</b> у вас запись:\n` +
      `💇 ${b.service_name || "Услуга"}\n` +
      `👩‍🎨 ${master?.name || "Мастер"}\n` +
      addrBlock(master) +
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
    if (sentReminders.has(key) || b.review_asked_at) continue;
    const bookingUtc = parseMinsKDt(b.booked_date, b.booked_time || "00:00:00");
    const hoursAgo   = (now - bookingUtc) / 3600000;
    // Не раньше трёх часов после визита и не позже полутора суток.
    // Верхняя граница была 4 часа при часовом тике — в это окно почти
    // никогда не попадали, и опрос не приходил вообще.
    if (hoursAgo < 3 || hoursAgo > 36) continue;

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

    if (!(await claimOnce(b.id, "review_asked_at"))) continue;
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
/* Раз в пять минут, а не раз в час: окна отправки короткие, и часовой
   тик в них не попадал. Повторов не будет — каждое отправленное
   сообщение отмечается в базе. */
setInterval(runReminders, 5 * 60 * 1000);

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
    // Narrowest scope that covers what we actually do: create/update/delete
    // events on the master's primary calendar. Must stay in sync with the
    // scope declared on the OAuth consent screen in Cloud Console.
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
  if (!data?.refresh_token) {
    console.warn(`GCal: no token for master ${masterTgId} — not connected`);
    return null;
  }
  const oauth2 = getOAuth2Client();
  if (!oauth2) return null;
  oauth2.setCredentials({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry_date:   data.expiry_date,
  });
  // Persist refreshed tokens back to DB so they survive Railway restarts
  oauth2.on("tokens", async (newTokens) => {
    console.log(`🔄 GCal token refreshed for master ${masterTgId}`);
    await db.from("master_gcal_tokens").upsert({
      master_telegram_id: String(masterTgId),
      access_token:  newTokens.access_token,
      refresh_token: newTokens.refresh_token || data.refresh_token,
      expiry_date:   newTokens.expiry_date,
      updated_at:    new Date().toISOString(),
    }, { onConflict: "master_telegram_id" });
  });
  return oauth2;
};

// Bookings go straight to the master's primary calendar: creating a dedicated
// "Uspot Bookings" calendar would need the full `calendar` scope.
const ensureUspotCalendar = async (_auth) => "primary";

// Push a booking to master's Google Calendar
// isPending=true → grey "tentative" event; false → green "confirmed"
const pushToGcal = async (booking, masterTgId, masterName, isPending = false) => {
  if (!google || !GCAL_CLIENT_ID) { console.log("GCal: googleapis or client_id missing"); return; }
  const auth = await getMasterOAuth2(masterTgId);
  if (!auth) {
    console.log(`GCal: master ${masterTgId} has not connected Google Calendar — skipping`);
    return;
  }
  console.log(`GCal: pushing booking ${booking.id} for master ${masterTgId} (${isPending?"pending":"confirmed"})`);
  const calendar = google.calendar({ version: "v3", auth });
  let calId;
  try {
    calId = await ensureUspotCalendar(auth);
    console.log(`GCal: using calendar ${calId}`);
  } catch (e) {
    console.error(`GCal: ensureUspotCalendar failed — ${e.message}`);
    throw e;
  }

  const masterAddrForEvent = fmtAddr((await getMasterFull(booking.master_id))?.location || "");
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
    location: masterAddrForEvent || undefined,
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
    if (isDeadGrant(e)) { await dropDeadGrant(masterTgId, "запись в календарь мастера"); return; }
    if (e.message?.includes("Insufficient Permission")) {
      console.error(`❌ GCal permission denied for master ${masterTgId}. Their token was issued without calendar.events scope. They must disconnect and reconnect Google Calendar in the app.`);
      // Notify master via Telegram so they know to reconnect
      send(masterTgId,
        `⚠️ <b>Google Календарь: нет доступа</b>\n\n` +
        `Ваш токен устарел и больше не имеет нужных прав.\n\n` +
        `Пожалуйста, зайдите в <b>Профиль → Google Календарь</b> и переподключите его. Это займёт 30 секунд.`
      );
    } else {
      console.error("GCal insert failed:", e.message);
    }
  }
};

// Update GCal event when booking is confirmed (pending → confirmed)
/* ─── Календарь клиента ───────────────────────────────────────────
   То же самое, что у мастера, но с другой стороны стойки: клиент видит
   не «услуга — имя клиента», а «услуга у мастера». Токены берутся из той
   же таблицы: она ключуется по Telegram ID, поэтому человек, подключивший
   календарь однажды, получает записи в обеих ролях.                    */
const clientEventBody = (booking, masterName, isPending, masterAddr = "") => {
  const dur = booking.duration_min || 60;
  const startIso = `${booking.booked_date}T${(booking.booked_time || "09:00:00").slice(0, 5)}:00`;
  const startMs  = new Date(`${startIso}+03:00`).getTime();
  const endIso   = new Date(startMs + dur * 60000 + 3 * 60 * 60 * 1000).toISOString().slice(0, 19);
  return {
    summary: isPending
      ? `⏳ ${booking.service_name || "Услуга"} — ${masterName} (ожидает подтверждения)`
      : `✅ ${booking.service_name || "Услуга"} — ${masterName}`,
    description:
      `Мастер: ${masterName}\n` +
      `Услуга: ${booking.service_name || "—"}\n` +
      `Стоимость: ${booking.total_price ? booking.total_price + " BYN" : "—"}\n` +
      `Статус: ${isPending ? "Ожидает подтверждения мастера" : "Подтверждено"}\n` +
      `\nЗапись через Uspot · ${MINI_APP_URL}`,
    // Адрес в отдельном поле: календарь сам делает из него карту и маршрут
    location: masterAddr || undefined,
    start: { dateTime: `${startIso}+03:00`, timeZone: "Europe/Minsk" },
    end:   { dateTime: `${endIso}+03:00`,   timeZone: "Europe/Minsk" },
    status: isPending ? "tentative" : "confirmed",
    colorId: isPending ? "8" : "3",
    extendedProperties: { private: { uspot_booking_id: booking.id, uspot_side: "client" } },
  };
};

const pushClientGcal = async (booking, masterName, isPending = false) => {
  const tg = booking.client_telegram_id;
  if (!google || !GCAL_CLIENT_ID || !tg) return;
  const auth = await getMasterOAuth2(tg);
  if (!auth) return;                       // клиент не подключал календарь — молча пропускаем
  const calendar = google.calendar({ version: "v3", auth });
  try {
    const { data: created } = await calendar.events.insert({
      calendarId: "primary",
      requestBody: clientEventBody(booking, masterName, isPending,
        fmtAddr((await getMasterFull(booking.master_id))?.location || "")),
    });
    await db.from("bookings")
      .update({ client_gcal_event_id: created.id, client_gcal_calendar_id: "primary" })
      .eq("id", booking.id);
    console.log(`✅ GCal клиента: событие ${created.id} для записи ${booking.id}`);
  } catch (e) {
    if (isDeadGrant(e)) return dropDeadGrant(tg, "запись в календарь клиента");
    console.error("GCal клиента (создание):", e.message);
  }
};

const updateClientGcal = async (booking, masterName, isPending = false) => {
  const tg = booking.client_telegram_id;
  if (!google || !GCAL_CLIENT_ID || !tg) return;
  const { data: bk } = await db.from("bookings")
    .select("client_gcal_event_id, client_gcal_calendar_id").eq("id", booking.id).single();
  // Событие могло не создаться (клиент подключил календарь позже) — тогда создаём
  if (!bk?.client_gcal_event_id) return pushClientGcal(booking, masterName, isPending);
  const auth = await getMasterOAuth2(tg);
  if (!auth) return;
  const calendar = google.calendar({ version: "v3", auth });
  try {
    await calendar.events.patch({
      calendarId: bk.client_gcal_calendar_id || "primary",
      eventId: bk.client_gcal_event_id,
      requestBody: clientEventBody(booking, masterName, isPending,
        fmtAddr((await getMasterFull(booking.master_id))?.location || "")),
    });
    console.log(`✅ GCal клиента: событие обновлено для записи ${booking.id}`);
  } catch (e) {
    if (isDeadGrant(e)) return dropDeadGrant(tg, "обновление календаря клиента");
    console.error("GCal клиента (обновление):", e.message);
  }
};

const deleteClientGcal = async (bookingId) => {
  if (!google || !GCAL_CLIENT_ID) return;
  const { data: bk } = await db.from("bookings")
    .select("client_gcal_event_id, client_gcal_calendar_id, client_telegram_id")
    .eq("id", bookingId).single();
  if (!bk?.client_gcal_event_id || !bk.client_telegram_id) return;
  const auth = await getMasterOAuth2(bk.client_telegram_id);
  if (!auth) return;
  const calendar = google.calendar({ version: "v3", auth });
  try {
    await calendar.events.delete({
      calendarId: bk.client_gcal_calendar_id || "primary", eventId: bk.client_gcal_event_id,
    });
    console.log(`🗑️  GCal клиента: событие удалено для записи ${bookingId}`);
  } catch (e) {
    if (isDeadGrant(e)) return dropDeadGrant(bk.client_telegram_id, "удаление в календаре клиента");
    console.warn("GCal клиента (удаление):", e.message);
  }
};

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
// RECONCILIATION — safety net for events Realtime never delivered
// Realtime is the ONLY trigger for master alerts and calendar sync, so a dead
// channel loses bookings silently (incident 2026-08-25). Every 10 min we sweep
// recent bookings and repair what was missed.
//   • Calendar: `gcal_event_id` in the DB is the marker, so this is idempotent
//     and keeps working across restarts.
//   • Master alert: the schema has no "notified" column, so it is guarded by an
//     in-memory set seeded at boot with everything created BEFORE this process
//     started — those were the previous process's responsibility and are never
//     re-announced. Anything created after boot is fair game for repair.
// ════════════════════════════════════════════════════════════
const RECONCILE_WINDOW_MIN = 90;
const RECONCILE_EVERY_MS   = 10 * 60 * 1000;
const MAX_GCAL_ATTEMPTS    = 3;   // stop retrying a booking that keeps failing
const gcalAttempts = {};
let reconcileReady   = false;
let reconcileRunning = false;

const seedHandledBookings = async (cutoffIso) => {
  try {
    const since = new Date(Date.now() - RECONCILE_WINDOW_MIN * 60000).toISOString();
    const { data } = await db.from("bookings")
      .select("id").gte("created_at", since).lt("created_at", cutoffIso);
    (data || []).forEach((r) => handledBookings.add(r.id));
    console.log(`🩹 Reconcile: seeded ${(data || []).length} pre-existing booking(s) — they will not be re-announced`);
  } catch (e) {
    console.error("🩹 Reconcile: seed failed:", e.message);
  } finally {
    reconcileReady = true;
  }
};

const reconcileBookings = async () => {
  if (reconcileRunning || !reconcileReady) return;
  reconcileRunning = true;
  try {
    const since = new Date(Date.now() - RECONCILE_WINDOW_MIN * 60000).toISOString();
    const { data: rows, error } = await db.from("bookings")
      .select("*").gte("created_at", since).in("status", ["pending", "confirmed"]);
    if (error) { console.error("🩹 Reconcile: query failed:", error.message); return; }
    if (!rows?.length) return;

    const { data: toks } = await db.from("master_gcal_tokens").select("master_telegram_id");
    const connected = new Set((toks || []).map((t) => String(t.master_telegram_id)));

    const masterCache = {};
    let repaired = 0;

    for (const b of rows) {
      if (b.client_name?.startsWith("🔒")) continue;   // manual slot blocks, not real bookings
      if (!b.master_id) continue;

      if (!masterCache[b.master_id]) {
        const { data: m } = await db.from("masters")
          .select("name, telegram_user_id").eq("id", b.master_id).single();
        masterCache[b.master_id] = m || {};
      }
      const m  = masterCache[b.master_id];
      const tg = m.telegram_user_id ? String(m.telegram_user_id) : null;

      // (a) Calendar catch-up
      if (!b.gcal_event_id && tg && connected.has(tg)) {
        const tries = gcalAttempts[b.id] || 0;
        if (tries < MAX_GCAL_ATTEMPTS) {
          gcalAttempts[b.id] = tries + 1;
          console.warn(`🩹 Reconcile: booking ${b.id} has no calendar event — pushing (attempt ${tries + 1})`);
          try {
            await pushToGcal(b, tg, m.name || "Мастер", b.status === "pending");
            repaired++;
          } catch (e) {
            console.error(`🩹 Reconcile: GCal push failed for ${b.id}:`, e.message);
          }
        }
      }

      /* (a2) Клиенту не сообщили о подтверждении.
         Realtime — единственный источник этого уведомления, и когда он
         молчит, человек просто не узнаёт, что его ждут. Отметка в базе
         делает починку идемпотентной и переживает перезапуск. */
      /* Захват вместо проверки: снимок строк сделан одним запросом в
         начале сверки, и за время цикла Realtime мог уже отправить своё
         сообщение. Условный запрос решает это в базе, а не по таймингу.
         Формулировка — та же, что в Realtime: два пути не должны
         говорить об одной записи разными словами. */
      if (b.status === "confirmed" && b.client_telegram_id &&
          !b.client_confirm_notified_at && await claimOnce(b.id, "client_confirm_notified_at")) {
        console.warn(`🩹 Сверка: клиенту не сообщили о подтверждении записи ${b.id} — отправляю`);
        try {
          const d = dateRu(b.booked_date), t = timeShort(b.booked_time);
          const mF = await getMasterFull(b.master_id);
          await sendWithKeyboard(b.client_telegram_id,
            (b.reschedule_of
              ? `✅ <b>Запись перенесена по вашей просьбе</b>\n\n`
              : `✅ <b>Мастер подтвердил вашу запись!</b>\n\n`) +
            `👩‍🎨 ${m.name || "Мастер"}\n` +
            `💇 ${b.service_name || "Услуга"}\n` +
            `📆 ${d}, ${t}\n` +
            `💳 ${b.total_price ? b.total_price + " BYN" : "—"}\n` +
            addrBlock(mF) +
            (b.reschedule_of ? `\nЖдём вас в новое время! 💜` : `\nЖдём вас в Uspot! 💜`),
            [[
              { text: "📅 Перенести", callback_data: `reschedule_${b.id}` },
              { text: "❌ Отменить",  callback_data: `client_cancel_${b.id}` },
            ]]
          );
          // Отметка уже стоит — её поставил захват перед отправкой
          if (tg) confirmGcalEvent(b.id, tg).catch(() => {});
          updateClientGcal(b, m.name || "Мастер", false).catch(() => {});
          repaired++;
        } catch (e) {
          console.error(`🩹 Сверка: не удалось сообщить о подтверждении ${b.id}:`, e.message);
          await releaseClaim(b.id, "client_confirm_notified_at");
        }
      }

      // (b) Master alert catch-up — only bookings this process never saw
      if (!handledBookings.has(b.id)) {
        handledBookings.add(b.id);
        if (tg && b.status === "pending") {
          console.warn(`🩹 Reconcile: booking ${b.id} was never announced — alerting master`);
          await sendWithKeyboard(tg,
            `📅 <b>Новая запись!</b>\n\n` +
            `👤 ${b.client_name || "Клиент"}\n` +
            `💇 ${b.service_name || "Услуга"}\n` +
            `📆 ${dateRu(b.booked_date)}, ${timeShort(b.booked_time)}\n` +
            `💳 ${b.total_price ? b.total_price + " BYN" : "—"}\n\n` +
            `Подтвердите или предложите другое время:`,
            [[
              { text: "✅ Подтвердить",  callback_data: `confirm_${b.id}` },
              { text: "⏰ Другое время", callback_data: `suggest_${b.id}` },
            ]]
          );
          repaired++;
        }
      }
    }
    if (repaired) console.log(`🩹 Reconcile: repaired ${repaired} item(s)`);
  } catch (e) {
    console.error("🩹 Reconcile: unexpected error:", e.message);
  } finally {
    reconcileRunning = false;
  }
};

// Boot: seed first (so we never announce what the previous process owned), then sweep.
setTimeout(async () => {
  await seedHandledBookings(BOOT_AT);
  reconcileBookings();
}, 30 * 1000);
setInterval(reconcileBookings, RECONCILE_EVERY_MS);

// Keep in-memory guards bounded. Re-seed on clear, otherwise the next sweep
// would treat everything in the window as unannounced and spam the masters.
setInterval(async () => {
  handledBookings.clear();
  for (const k of Object.keys(gcalAttempts)) delete gcalAttempts[k];
  await seedHandledBookings(new Date().toISOString());
  console.log("🧹 Reconcile caches cleared and re-seeded");
}, 24 * 60 * 60 * 1000);

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

// ════════════════════════════════════════════════════════════
// АУТЕНТИФИКАЦИЯ КЛИЕНТА
// ════════════════════════════════════════════════════════════
// Раньше личность приходила из initDataUnsafe и никем не проверялась,
// а вне Telegram подставлялась общая заглушка — все посетители сайта
// становились одним человеком. Теперь личность подтверждает Telegram,
// а подпись проверяем здесь, токеном бота.
//
// Два источника, одна проверка:
//   • Mini App внутри Telegram — initData (ключ HMAC("WebAppData", token));
//   • Login Widget на сайте    — payload виджета (ключ SHA256(token)).
//
// В ответ отдаём сессию: подписанную строку, которую фронт кладёт в
// localStorage и присылает при записи. Подделать её без секрета нельзя.

const crypto = require("crypto");
const AUTH_TTL_SEC     = 60 * 60 * 24 * 30;      // сессия на 30 дней
const AUTH_MAX_AGE_SEC = 60 * 60 * 24;           // подпись Telegram не старше суток
const SESSION_SECRET   = crypto.createHash("sha256").update("uspot-session:" + (BOT_TOKEN || "")).digest();

const checkString = (obj) => Object.keys(obj).filter(k => k !== "hash").sort()
  .map(k => `${k}=${obj[k]}`).join("\n");

// Login Widget: ключ — SHA256 от токена бота
const verifyWidget = (data) => {
  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(checkString(data)).digest("hex");
  return calc === data.hash;
};

// Mini App: ключ — HMAC("WebAppData", токен бота)
const verifyInitData = (initData) => {
  const params = new URLSearchParams(initData);
  const obj = {}; for (const [k, v] of params) obj[k] = v;
  if (!obj.hash) return null;
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(checkString(obj)).digest("hex");
  if (calc !== obj.hash) return null;
  try { return { ...obj, user: JSON.parse(obj.user || "null") }; } catch { return null; }
};

const signSession = (tgId) => {
  const body = Buffer.from(JSON.stringify({ id: String(tgId), exp: Math.floor(Date.now() / 1000) + AUTH_TTL_SEC })).toString("base64url");
  const sig  = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
};

// Возвращает telegram id или null. Используется и здесь, и позже при записи.
const readSession = (token) => {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  // сравнение постоянного времени — чтобы подпись нельзя было подобрать по таймингу
  const a = Buffer.from(sig || "", "utf8"), b = Buffer.from(expect, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.id || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return String(p.id);
  } catch { return null; }
};

// POST /auth/telegram  { mode: "widget"|"initdata", payload }
app.post("/auth/telegram", async (req, res) => {
  try {
    const { mode, payload } = req.body || {};
    let user = null, authDate = 0;

    if (mode === "initdata") {
      const d = verifyInitData(payload);
      if (!d?.user?.id) return res.status(401).json({ error: "bad_signature" });
      user = d.user; authDate = +d.auth_date || 0;
    } else if (mode === "widget") {
      if (!payload?.hash || !verifyWidget(payload)) return res.status(401).json({ error: "bad_signature" });
      user = payload; authDate = +payload.auth_date || 0;
    } else {
      return res.status(400).json({ error: "bad_mode" });
    }

    if (!authDate || (Date.now() / 1000 - authDate) > AUTH_MAX_AGE_SEC) {
      return res.status(401).json({ error: "expired" });
    }

    const tgId = String(user.id);
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Клиент";
    await db.from("clients").upsert(
      { telegram_user_id: tgId, name, photo_url: user.photo_url || null },
      { onConflict: "telegram_user_id" }
    );
    const { data: row } = await db.from("clients")
      .select("name, phone, photo_url, bio").eq("telegram_user_id", tgId).single();

    res.json({
      ok: true,
      token: signSession(tgId),
      client: { telegram_user_id: tgId, name: row?.name || name,
                phone: row?.phone || null, photo_url: row?.photo_url || user.photo_url || null,
                bio: row?.bio || "" },
    });
  } catch (e) {
    console.error("auth error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /auth/me?token=... — фронт проверяет сохранённую сессию при загрузке
app.get("/auth/me", async (req, res) => {
  const tgId = readSession(req.query.token);
  if (!tgId) return res.status(401).json({ error: "invalid_session" });
  const { data: row } = await db.from("clients")
    .select("name, phone, photo_url, bio").eq("telegram_user_id", tgId).single();
  res.json({ ok: true, client: { telegram_user_id: tgId, name: row?.name || "Клиент",
             phone: row?.phone || null, photo_url: row?.photo_url || null, bio: row?.bio || "" } });
});

// ════════════════════════════════════════════════════════════
// СОЗДАНИЕ ЗАПИСИ — только здесь
// ════════════════════════════════════════════════════════════
// Раньше браузер писал в bookings напрямую публичным ключом: этот ключ
// лежит в исходниках страницы, поэтому кто угодно мог отправить бронь от
// чужого имени, на занятое время и с любой ценой. Теперь запись создаёт
// бот сервисным ключом, а публичному ключу вставка в bookings закрыта.
//
// Ничему из присланного не верим: цену и длительность берём из услуги в
// базе, занятость и рабочие часы проверяем сами, личность — из сессии.

const toMinutes = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };

app.post("/bookings", async (req, res) => {
  try {
    const b = req.body || {};
    const tgId = readSession(b.token);
    if (!tgId) return res.status(401).json({ error: "not_authorized" });

    const masterId = b.master_id;
    const date     = String(b.booked_date || "");
    const time     = String(b.booked_time || "").slice(0, 5);
    if (!masterId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "bad_request" });
    }
    const todayIso = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Minsk" }).slice(0, 10);
    if (date < todayIso) return res.status(400).json({ error: "past_date" });

    const { data: master } = await db.from("masters")
      .select("id, name, kind, salon_id, telegram_user_id, is_active, works_from, works_until")
      .eq("id", masterId).single();
    if (!master || master.is_active === false) return res.status(404).json({ error: "master_not_found" });
    if (master.works_until && master.works_until < date) return res.status(409).json({ error: "master_left" });
    if (master.works_from  && master.works_from  > date) return res.status(409).json({ error: "master_not_started" });

    // Кто просит: сам мастер/салон заводит запись рукой или клиент себе
    const { data: ownerRows } = await db.from("masters").select("id, kind, salon_id").eq("telegram_user_id", tgId);
    const owners = ownerRows || [];
    /* Важно: «администратор» — это не про личность, а про то, откуда пришла
       запись. Мастер может записаться сам к себе как обычный клиент, и такая
       запись обязана ждать подтверждения. Раньше она подтверждалась сама,
       потому что telegram совпадал с владельцем профиля мастера. */
    const asClient = b.as === "client";
    const isAdmin = !asClient && owners.some(o =>
      o.id === masterId ||                                        // сам мастер
      (o.kind === "salon" && master.salon_id === o.id) ||         // директор салона
      (o.salon_id && master.salon_id === o.salon_id)              // коллега по салону
    );

    /* Записаться можно не позже чем за час: мастеру нужно время доехать.
       Администратора и самого мастера это не касается — они ставят записи
       вручную, в том числе «на сейчас». */
    if (!isAdmin) {
      const left = minutesUntil(date, time);
      if (left < BOOK_LEAD_MIN) {
        return res.status(409).json({ error: "too_soon", lead_min: BOOK_LEAD_MIN });
      }
    }

    // Служебная блокировка времени — без услуги и клиента
    const isBlock = !!b.block;
    let svc = null;
    if (!isBlock) {
      const { data: svcRow } = await db.from("services")
        .select("name, price, duration_min").eq("master_id", masterId)
        .eq("name", String(b.service_name || "")).eq("is_active", true).limit(1);
      svc = (svcRow || [])[0] || null;
      if (!svc) return res.status(400).json({ error: "service_not_found" });
    }
    // Цена и длительность — из базы, не из запроса
    const dur   = isBlock ? Math.max(15, Math.min(600, +b.duration_min || 60)) : (+svc.duration_min || 60);
    const price = isBlock ? 0 : (+svc.price || 0);

    // Рабочие часы мастера в этот день
    const jsDay = new Date(date + "T12:00:00").getDay();
    const dow   = jsDay === 0 ? 6 : jsDay - 1;
    const { data: schedRows } = await db.from("master_schedule")
      .select("is_working, start_time, end_time").eq("master_id", masterId).eq("day_of_week", dow).limit(1);
    const sch = (schedRows || [])[0];
    const start = toMinutes(time);
    if (!isAdmin) {                       // администратор может ставить и вне смены
      if (sch && sch.is_working === false) return res.status(409).json({ error: "day_off" });
      const from = toMinutes(sch?.start_time || "09:00"), to = toMinutes(sch?.end_time || "18:00");
      if (start < from || start + dur > to) return res.status(409).json({ error: "outside_hours" });
    }

    // Не занято ли
    const { data: busy } = await db.from("bookings")
      .select("booked_time, duration_min").eq("master_id", masterId).eq("booked_date", date)
      .not("status", "in", "(cancelled,declined)");
    const clash = (busy || []).some(x => {
      const s2 = toMinutes((x.booked_time || "").slice(0, 5)), d2 = +x.duration_min || 60;
      return s2 < start + dur && s2 + d2 > start;
    });
    // Служебную блокировку (перерыв, выходной) администратор ставит и поверх
    // занятого времени — он знает, что делает. Клиентскую запись — никогда.
    if (clash && !(isBlock && isAdmin)) return res.status(409).json({ error: "slot_taken" });

    // Клиент: сам записывающийся или тот, кого вписал администратор
    let clientName, clientTg = null;
    if (isBlock) {
      clientName = "\uD83D\uDD12 " + (String(b.client_name || "Перерыв").slice(0, 60));
    } else if (isAdmin && b.client_name) {
      clientName = String(b.client_name).slice(0, 80);
    } else {
      const { data: cl } = await db.from("clients").select("name").eq("telegram_user_id", tgId).single();
      clientName = cl?.name || "Клиент";
      clientTg = tgId;
      const { data: bl } = await db.from("master_blacklist").select("id")
        .eq("master_id", masterId).eq("client_telegram_id", tgId).limit(1);
      if ((bl || []).length) return res.status(403).json({ error: "blacklisted" });
    }

    const row = {
      master_id: masterId, master_name: master.name || null,
      salon_id: b.salon_id || master.salon_id || null,
      booked_date: date, booked_time: time + ":00", duration_min: dur,
      service_name: isBlock ? (b.service_name || "Перерыв") : svc.name,
      total_price: price,
      client_name: clientName, client_telegram_id: clientTg,
      client_notes: b.client_notes ? String(b.client_notes).slice(0, 1000) : null,
      client_photo_urls: Array.isArray(b.client_photo_urls) ? b.client_photo_urls.slice(0, 6) : null,
      // Перенос прежней записи: бот напишет мастеру одно сообщение
      // «перенос», а не «новая запись» следом за «переносом»
      reschedule_of: b.reschedule_of || null,
      // Запись от администратора не нуждается в подтверждении — он её и завёл
      status: isAdmin ? "confirmed" : "pending",
    };
    const { data: created, error } = await db.from("bookings").insert(row).select().single();
    if (error) { console.error("booking insert:", error.message); return res.status(500).json({ error: "insert_failed" }); }

    console.log(`📝 Запись ${created.id} создана через бота (${isAdmin ? "администратор" : "клиент"})`);
    // Номер здесь не просим: человек только что отправил запись и ждёт
    // ответа мастера. Просьба уходит после подтверждения — см. askPhoneOnce.
    res.json({ ok: true, booking: created });
  } catch (e) {
    console.error("POST /bookings:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /bookings/cancel { token, booking_id } — отменить может только владелец
app.post("/bookings/cancel", async (req, res) => {
  try {
    const { token, booking_id, reason } = req.body || {};
    const tgId = readSession(token);
    if (!tgId) return res.status(401).json({ error: "not_authorized" });

    const { data: bk } = await db.from("bookings").select("*").eq("id", booking_id).single();
    if (!bk) return res.status(404).json({ error: "not_found" });
    if (bk.status === "cancelled") return res.json({ ok: true, booking: bk });

    const { data: ownerRows } = await db.from("masters").select("id, kind, salon_id").eq("telegram_user_id", tgId);
    const owners = ownerRows || [];
    const isOwnerSide = owners.some(o => o.id === bk.master_id ||
      (o.kind === "salon" && o.id === bk.salon_id) || (o.salon_id && o.salon_id === bk.salon_id));
    const isClient = bk.client_telegram_id && String(bk.client_telegram_id) === tgId;
    if (!isClient && !isOwnerSide) return res.status(403).json({ error: "forbidden" });

    /* Клиент не отменяет за два часа до визита: окно уже не продать.
       Мастера и салона это не касается — форс-мажор бывает у всех, но
       решение остаётся за той стороной, которая теряет деньги. */
    if (isClient && !isOwnerSide) {
      const left = minutesUntil(bk.booked_date, bk.booked_time);
      if (left < CHANGE_CUTOFF_MIN) {
        return res.status(409).json({
          error: "too_late_to_cancel", cutoff_min: CHANGE_CUTOFF_MIN, minutes_left: left,
        });
      }
    }

    const cancelReason = isClient
      ? `client:${String(reason || "не указана").slice(0, 200)}`
      : `master:${String(reason || "salon").slice(0, 200)}`;
    const { data: upd, error } = await db.from("bookings")
      .update({ status: "cancelled", cancel_reason: cancelReason }).eq("id", booking_id).select().single();
    if (error) return res.status(500).json({ error: "update_failed" });
    res.json({ ok: true, booking: upd });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Телефон: просим один раз, после первой записи ───────────
// Номер не нужен для входа — он нужен салону, чтобы позвонить, если
// клиент не читает Telegram. Поэтому спрашиваем мягко и однократно.
// Спрашиваем, если номера нет и мы ещё не спрашивали. Привязка к «первой
// записи» была ошибкой: человек с историей записей и без номера не получил
// бы просьбу никогда. Отметку храним в базе, иначе перезапуск бота сбрасывал
// бы память и мы бы спрашивали снова у тех, кто уже отказался.
const phoneAsked = new Set();
const askPhoneOnce = async (tgId) => {
  if (phoneAsked.has(tgId)) return;
  const { data: cl } = await db.from("clients")
    .select("phone, phone_asked_at").eq("telegram_user_id", tgId).single();
  if (cl?.phone || cl?.phone_asked_at) { phoneAsked.add(tgId); return; }
  phoneAsked.add(tgId);
  const text =
    "📞 <b>Оставьте номер телефона</b>\n\n" +
    "Он понадобится в одном случае: если мастеру нужно срочно с вами связаться — " +
    "например, изменится время визита.\n\n" +
    "Номер видит только мастер, рассылок не будет. Можно пропустить — на запись это не влияет.";
  const kb = { keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }],
                          [{ text: "Не сейчас" }]],
               resize_keyboard: true, one_time_keyboard: true };

  // Отметку ставим ТОЛЬКО после удачной отправки: раньше помечали заранее,
  // и когда сообщение не ушло, человек не получал просьбу уже никогда.
  const mark = async () => { try { await db.from("clients")
    .update({ phone_asked_at: new Date().toISOString() }).eq("telegram_user_id", tgId); } catch (e) {} };

  try {
    await bot.sendMessage(tgId, text, { parse_mode: "HTML", reply_markup: kb });
    await mark();
    console.log(`📞 Просьба о номере отправлена ${tgId}`);
    return;
  } catch (e) {
    // Telegram присылает причину в теле ответа — без неё диагностировать нечем
    console.error("askPhone (с кнопкой):", e.message, JSON.stringify(e.response?.body || null));
  }
  // Запасной путь: тем же способом, что и все остальные уведомления бота
  try {
    await bot.sendMessage(tgId, text + "\n\nЧтобы поделиться, отправьте контакт через скрепку → «Контакт».",
      { parse_mode: "HTML", disable_web_page_preview: true });
    await mark();
    console.log(`📞 Просьба о номере отправлена ${tgId} (без кнопки)`);
  } catch (e2) {
    console.error("askPhone (без кнопки):", e2.message, JSON.stringify(e2.response?.body || null));
    phoneAsked.delete(tgId);      // не пометили — попробуем при следующей записи
  }
};

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
      `Все подтверждённые записи будут автоматически появляться в вашем <b>основном Google Календаре</b>.\n\n` +
      `Если запись отменяется — событие удаляется из календаря автоматически. 💜`
    );

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ Google Календарь подключён!</h2>
      <p>Вернитесь в Telegram — записи будут автоматически появляться в вашем <b>основном Google Календаре</b>.</p>
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

// ════════════════════════════════════════════════════════════
// ОБРАТНАЯ СИНХРОНИЗАЦИЯ: календарь → база
// ════════════════════════════════════════════════════════════
// Мастер удаляет событие в Google Календаре — запись должна отмениться,
// а клиент получить уведомление.
//
// Мгновенный push (events.watch) требует, чтобы домен приёмника был
// подтверждён в проекте Google. Бот живёт на *.up.railway.app — чужой
// домен, подтвердить нельзя. Поэтому опрашиваем сами: раз в 10 минут
// смотрим изменения за последние 15 (окна перекрываются, ничего не
// теряется), а повторная обработка безвредна — уже отменённые пропускаем.
//
// Когда появится свой поддомен (api.uspot.by → Railway), push можно
// включить поверх: обработчик /gcal/webhook уже написан и зовёт эту же
// функцию, опрос останется страховкой.

const GCAL_PULL_EVERY_MS  = 10 * 60 * 1000;
// Окно шире интервала с большим запасом: перекрытие ничего не стоит
// (повторная обработка — пустая операция), зато переживает перезапуск бота.
const GCAL_PULL_WINDOW_MS = 30 * 60 * 1000;

// Время события в минском календаре: "YYYY-MM-DD" + минуты от полуночи.
// Минск круглый год +03:00, поэтому пересчёт однозначный.
const minskParts = (dateTimeStr) => {
  const d = new Date(dateTimeStr);
  if (isNaN(d)) return null;
  // sv-SE даёт "YYYY-MM-DD HH:MM:SS" — удобный для разбора формат
  const s = d.toLocaleString("sv-SE", { timeZone: "Europe/Minsk" });
  const [date, time] = s.split(" ");
  const [h, m] = time.split(":").map(Number);
  return { date, min: h * 60 + m, hhmm: time.slice(0, 5) };
};
const minToHHMM = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Мастер подвинул событие в календаре. Возможны три исхода:
//  1) новое время свободно — принимаем, двигаем запись, уведомляем клиента;
//  2) занято — ставим в ближайший свободный блок и правим событие обратно,
//     чтобы календарь и база сошлись, обоим объясняем;
//  3) в этот день ничего не помещается — возвращаем событие на место.
const applyGcalMove = async (masterTgId, event, calendar, todayIso) => {
  const bookingId = event.extendedProperties?.private?.uspot_booking_id;
  const st = minskParts(event.start?.dateTime);
  const en = minskParts(event.end?.dateTime);
  if (!st || !en) return;

  const { data: bk } = await db.from("bookings").select("*").eq("id", bookingId).single();
  if (!bk) return;
  if (bk.status === "cancelled" || bk.status === "declined") return;
  if (bk.booked_date < todayIso) return;                 // прошедший визит не трогаем

  const curMin = (() => { const [h, m] = String(bk.booked_time || "0:0").split(":").map(Number);
                          return h * 60 + (m || 0); })();
  const curDur = +bk.duration_min || 60;
  let newDur = en.min - st.min;
  if (en.date !== st.date || newDur <= 0) newDur = curDur;   // через полночь — не поддерживаем

  // Ничего не изменилось (в том числе после нашей же правки) — выходим
  if (st.date === bk.booked_date && st.min === curMin && newDur === curDur) return;

  // Рабочие часы мастера в этот день недели (0 = понедельник)
  const jsDay = new Date(st.date + "T12:00:00").getDay();
  const dow = jsDay === 0 ? 6 : jsDay - 1;
  const { data: schedRows } = await db.from("master_schedule")
    .select("is_working, start_time, end_time")
    .eq("master_id", bk.master_id).eq("day_of_week", dow).limit(1);
  const schedRow = (schedRows || [])[0] || null;
  const works = schedRow?.is_working !== false;
  const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
  const dayFrom = toMin(schedRow?.start_time || "09:00");
  const dayTo   = toMin(schedRow?.end_time   || "18:00");

  // Чужие записи этого мастера в этот день
  const { data: others } = await db.from("bookings")
    .select("id, booked_time, duration_min")
    .eq("master_id", bk.master_id).eq("booked_date", st.date)
    .neq("id", bookingId)
    .not("status", "in", "(cancelled,declined)");
  const busy = (others || []).map(o => ({ s: toMin(o.booked_time), e: toMin(o.booked_time) + (+o.duration_min || 60) }));
  const fits = (start) => start >= dayFrom && start + newDur <= dayTo &&
                          !busy.some(b => b.s < start + newDur && b.e > start);

  const revert = async (why) => {
    const s0 = `${bk.booked_date}T${String(bk.booked_time || "09:00:00").slice(0, 8)}`;
    const e0 = new Date(new Date(s0 + "+03:00").getTime() + curDur * 60000)
      .toLocaleString("sv-SE", { timeZone: "Europe/Minsk" }).replace(" ", "T");
    await calendar.events.patch({
      calendarId: bk.gcal_calendar_id || "primary", eventId: event.id,
      requestBody: { start: { dateTime: `${s0}+03:00`, timeZone: "Europe/Minsk" },
                     end:   { dateTime: `${e0}+03:00`, timeZone: "Europe/Minsk" } },
    });
    await send(masterTgId,
      `↩️ <b>Перенос не применён</b>\n\n` +
      `${bk.service_name || "Услуга"} — ${bk.client_name || "Клиент"}\n` +
      `Запись осталась на ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}.\n\n` +
      `${why}\n\nПеренесите через приложение — там видно свободные окна.`);
    console.log(`↩️ GCal move reverted for booking ${bookingId}: ${why}`);
  };

  if (!works) { await revert("В этот день вы не работаете."); return; }

  // Куда в итоге ставим
  let target = st.min, shifted = false;
  if (!fits(target)) {
    // Ищем ближайшее свободное окно: шаг 15 минут, сначала позже, потом раньше.
    // «Позже» первым — так запись встаёт сразу за занятым блоком.
    let found = null;
    for (let d = 15; d <= 12 * 60 && found === null; d += 15) {
      if (fits(st.min + d)) found = st.min + d;
      else if (fits(st.min - d)) found = st.min - d;
    }
    if (found === null) { await revert("В этот день нет свободного окна нужной длины."); return; }
    target = found; shifted = true;
  }

  const newTime = minToHHMM(target);
  const { error } = await db.from("bookings")
    .update({ booked_date: st.date, booked_time: newTime + ":00", duration_min: newDur })
    .eq("id", bookingId);
  if (error) { console.error("GCal move: не удалось обновить запись:", error.message); return; }

  if (shifted) {
    const s1 = `${st.date}T${newTime}:00`;
    const e1 = minToHHMM(target + newDur);
    await calendar.events.patch({
      calendarId: bk.gcal_calendar_id || "primary", eventId: event.id,
      requestBody: { start: { dateTime: `${s1}+03:00`, timeZone: "Europe/Minsk" },
                     end:   { dateTime: `${st.date}T${e1}:00+03:00`, timeZone: "Europe/Minsk" } },
    });
    await send(masterTgId,
      `⚠️ <b>Время занято — записал рядом</b>\n\n` +
      `${bk.service_name || "Услуга"} — ${bk.client_name || "Клиент"}\n` +
      `Вы поставили на ${st.hhmm}, там уже есть запись.\n` +
      `Перенёс на <b>${newTime}</b> — ближайшее свободное окно. Событие в календаре поправлено.`);
  }

  if (bk.client_telegram_id) {
    await sendWithKeyboard(bk.client_telegram_id,
      `📅 <b>Мастер перенёс запись</b>\n\n` +
      `💇 ${bk.service_name || "Услуга"}\n` +
      `Было: ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}\n` +
      `Стало: <b>${dateRu(st.date)}, ${newTime}</b>\n\n` +
      `Подходит новое время?`,
      [[{ text: "✅ Подходит", callback_data: `keep_${bookingId}` },
        { text: "📅 Другое время", callback_data: `reschedule_${bookingId}` }]]);
  }
  console.log(`📅 Booking ${bookingId} перенесён из календаря: ${bk.booked_date} ${timeShort(bk.booked_time)} → ${st.date} ${newTime}${shifted ? " (сдвинут)" : ""}`);
};

// Разбирает изменения календаря одного мастера начиная с sinceIso.
// Возвращает число отменённых записей.
const syncFromGcal = async (masterTgId, sinceIso) => {
  const auth = await getMasterOAuth2(masterTgId);
  if (!auth) return 0;
  const calendar = google.calendar({ version: "v3", auth });

  let events;
  try {
    ({ data: events } = await calendar.events.list({
      calendarId: "primary",
      updatedMin: sinceIso,
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
    }));
  } catch (e) {
    if (isDeadGrant(e)) { await dropDeadGrant(masterTgId, "чтение календаря"); return 0; }
    console.error(`GCal pull ${masterTgId}: ${e.message}`);
    return 0;
  }

  let cancelled = 0;
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const event of events?.items || []) {
    const bookingId = event.extendedProperties?.private?.uspot_booking_id;
    if (!bookingId) continue;

    // ── Событие перенесли или растянули ──────────────────────────
    if (event.status !== "cancelled" && event.start?.dateTime) {
      try { await applyGcalMove(masterTgId, event, calendar, todayIso); }
      catch (e) { console.error(`GCal move ${bookingId}: ${e.message}`); }
      continue;
    }

    if (event.status !== "cancelled") continue;

    const { data: bk } = await db.from("bookings").select("*").eq("id", bookingId).single();
    if (!bk) continue;
    if (bk.status === "cancelled" || bk.status === "declined") continue;
    // Прошедший визит уже состоялся — удаление события в календаре
    // не должно задним числом отменять запись и слать клиенту извинения.
    if (bk.booked_date < todayIso) continue;

    const { error } = await db.from("bookings")
      .update({ status: "cancelled", cancel_reason: "master:gcal_delete" })
      .eq("id", bookingId);
    if (error) continue;

    if (bk.client_telegram_id) {
      await sendWithKeyboard(bk.client_telegram_id,
        `❌ <b>Запись отменена мастером</b>\n\n` +
        `💇 ${bk.service_name || "Услуга"}\n` +
        `📆 ${dateRu(bk.booked_date)}, ${timeShort(bk.booked_time)}\n\n` +
        `Выберите другую дату — записаться снова очень просто! 💜`,
        [[{ text: "📅 Записаться снова", web_app: { url: `${MINI_APP_URL}?startapp=m${bk.master_id}` } }]]
      );
    }
    cancelled++;
    console.log(`✅ Booking ${bookingId} cancelled — event deleted in GCal (${masterTgId})`);
  }
  return cancelled;
};

let gcalPullRunning = false;
const gcalPullSweep = async () => {
  if (!google || gcalPullRunning) return;
  gcalPullRunning = true;
  try {
    const { data: rows } = await db.from("master_gcal_tokens").select("master_telegram_id");
    if (!rows?.length) return;
    const since = new Date(Date.now() - GCAL_PULL_WINDOW_MS).toISOString();
    let total = 0;
    for (const r of rows) {
      total += await syncFromGcal(String(r.master_telegram_id), since);
    }
    if (total) console.log(`📅 GCal pull: отменено записей — ${total}`);
  } catch (e) {
    console.error("GCal pull sweep error:", e.message);
  } finally {
    gcalPullRunning = false;
  }
};

setTimeout(gcalPullSweep, 45 * 1000);
setInterval(gcalPullSweep, GCAL_PULL_EVERY_MS);

// POST /gcal/webhook — Google Calendar push notifications (when master edits/cancels)
app.post("/gcal/webhook", async (req, res) => {
  // Google дёргает этот адрес при изменении события. Разбор — той же
  // функцией, что и опрос, чтобы правила отмены не разъезжались.
  const channelId     = req.headers["x-goog-channel-id"];
  const resourceState = req.headers["x-goog-resource-state"];
  res.sendStatus(200); // отвечаем сразу, Google не ждёт обработки

  if (resourceState !== "exists" && resourceState !== "not_exists") return;
  if (!channelId) return;

  // channelId вида "uspot-{masterTgId}-{calId}"
  const parts = channelId.split("-");
  if (parts.length < 3 || parts[0] !== "uspot") return;
  const masterTgId = parts[1];

  console.log(`📅 GCal webhook: мастер ${masterTgId}, состояние ${resourceState}`);
  try {
    await syncFromGcal(masterTgId, new Date(Date.now() - 5 * 60 * 1000).toISOString());
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
