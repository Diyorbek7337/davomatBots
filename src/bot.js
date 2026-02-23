import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ==================== FIREBASE SETUP ====================
let db;

try {
  let serviceAccount;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    serviceAccount = JSON.parse(readFileSync(path, 'utf8'));
  } else {
    throw new Error('Firebase service account not configured!');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });

  db = admin.firestore();
  console.log('✅ Firebase ulandi');
} catch (error) {
  console.error('❌ Firebase ulanish xatosi:', error.message);
  process.exit(1);
}

// ==================== BOT SETUP ====================
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Admin IDs
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').filter(id => id.trim());

// Office location
const OFFICE = {
  latitude: parseFloat(process.env.OFFICE_LATITUDE) || 37.9953333,
  longitude: parseFloat(process.env.OFFICE_LONGITUDE) || 67.7891667,
  radius: parseInt(process.env.OFFICE_RADIUS) || 50
};

// Default settings
const DEFAULT_WORK_START = '09:00';
const DEFAULT_WORK_END = '18:00';
const DEFAULT_LATE_THRESHOLD = 5;

// Session states
const userStates = new Map();
const sentReminders = new Set();

// ==================== KEYBOARDS ====================

const mainKeyboard = Markup.keyboard([
  ['📥 Keldim', '📤 Ketdim'],
  ['📊 Statistika', '📅 Bugungi holat'],
  ["📝 Ta'til so'rovi", '❓ Yordam']
]).resize();

const locationKeyboard = Markup.keyboard([
  [Markup.button.locationRequest('📍 Geo-joylashuvni yuborish')],
  ['❌ Bekor qilish']
]).resize();

const phoneKeyboard = Markup.keyboard([
  [Markup.button.contactRequest('📱 Telefon raqamni yuborish')],
  ['❌ Bekor qilish']
]).resize();

const cancelKeyboard = Markup.keyboard([
  ['❌ Bekor qilish']
]).resize();

const leaveTypeKeyboard = Markup.keyboard([
  ["🏖 Ta'til", "🏥 Kasallik"],
  ["👤 Shaxsiy", "❌ Bekor qilish"]
]).resize();

// ==================== HELPER FUNCTIONS ====================

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c);
}

function isWithinOffice(lat, lon) {
  const distance = calculateDistance(lat, lon, OFFICE.latitude, OFFICE.longitude);
  return { isWithin: distance <= OFFICE.radius, distance };
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  try {
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString('uz-UZ', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: 'Asia/Tashkent'
    });
  } catch (e) {
    return '-';
  }
}

function getTodayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function getCurrentTime() {
  return new Date().toLocaleTimeString('uz-UZ', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'Asia/Tashkent'
  });
}

async function notifyAdmins(message) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId.trim(), message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`Admin ${adminId} ga xabar yuborilmadi`);
    }
  }
}

// ==================== DATABASE FUNCTIONS ====================

async function getEmployee(telegramId) {
  try {
    const snapshot = await db.collection('employees')
      .where('telegramId', '==', String(telegramId))
      .limit(1)
      .get();
    
    if (snapshot.empty) return null;
    return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  } catch (error) {
    console.error('getEmployee xatosi:', error);
    throw new Error('Ma\'lumotlar bazasiga ulanishda xatolik');
  }
}

async function getAllEmployees() {
  try {
    const snapshot = await db.collection('employees')
      .where('isActive', '==', true)
      .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('getAllEmployees xatosi:', error);
    return [];
  }
}

async function registerEmployee(data) {
  try {
    const docRef = await db.collection('employees').add({
      ...data,
      isActive: true,
      hourlyRate: 0,
      workStartTime: DEFAULT_WORK_START,
      workEndTime: DEFAULT_WORK_END,
      lateThreshold: DEFAULT_LATE_THRESHOLD,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return docRef.id;
  } catch (error) {
    console.error('registerEmployee xatosi:', error);
    throw new Error('Ro\'yxatdan o\'tishda xatolik');
  }
}

async function getTodayAttendance(employeeId) {
  try {
    const today = getTodayString();
    const snapshot = await db.collection('attendance')
      .where('employeeId', '==', employeeId)
      .where('dateString', '==', today)
      .limit(1)
      .get();
    
    if (snapshot.empty) return null;
    return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  } catch (error) {
    console.error('getTodayAttendance xatosi:', error);
    throw new Error('Davomat ma\'lumotlarini olishda xatolik');
  }
}

async function checkIn(employee, location) {
  try {
    const today = getTodayString();
    const now = new Date();
    
    const existing = await getTodayAttendance(employee.id);
    if (existing?.checkIn) {
      throw new Error('Siz bugun allaqachon keldingiz qayd etgansiz');
    }
    
    const workStartTime = employee.workStartTime || DEFAULT_WORK_START;
    const lateThreshold = employee.lateThreshold || DEFAULT_LATE_THRESHOLD;
    
    const [startHour, startMin] = workStartTime.split(':').map(Number);
    
    const workStartWithThreshold = new Date();
    workStartWithThreshold.setHours(startHour, startMin + lateThreshold, 0, 0);
    
    const actualStart = new Date();
    actualStart.setHours(startHour, startMin, 0, 0);
    
    let isLate = false;
    let lateMinutes = 0;
    
    if (now > workStartWithThreshold) {
      isLate = true;
      lateMinutes = Math.floor((now - actualStart) / 1000 / 60);
    }
    
    const data = {
      employeeId: employee.id,
      employeeName: employee.name,
      dateString: today,
      date: admin.firestore.FieldValue.serverTimestamp(),
      checkIn: admin.firestore.FieldValue.serverTimestamp(),
      checkInTime: now.toISOString(),
      checkInLocation: location,
      isLate,
      lateMinutes,
      expectedStartTime: workStartTime,
      status: 'present'
    };
    
    if (existing) {
      await db.collection('attendance').doc(existing.id).update(data);
    } else {
      await db.collection('attendance').add(data);
    }
    
    return { isLate, lateMinutes, workStartTime };
  } catch (error) {
    console.error('checkIn xatosi:', error);
    throw error;
  }
}

async function checkOut(employee, location) {
  try {
    const existing = await getTodayAttendance(employee.id);
    
    if (!existing?.checkIn) {
      throw new Error('Avval "📥 Keldim" tugmasini bosing');
    }
    
    if (existing.checkOut) {
      throw new Error('Siz bugun allaqachon ketdingiz qayd etgansiz');
    }
    
    const now = new Date();
    const workEndTime = employee.workEndTime || DEFAULT_WORK_END;
    const [endHour, endMin] = workEndTime.split(':').map(Number);
    
    const workEnd = new Date();
    workEnd.setHours(endHour, endMin, 0, 0);
    
    let isEarlyLeave = false;
    let earlyMinutes = 0;
    
    if (now < workEnd) {
      isEarlyLeave = true;
      earlyMinutes = Math.floor((workEnd - now) / 1000 / 60);
    }
    
    let workedHours = 0;
    if (existing.checkInTime) {
      const checkInDate = new Date(existing.checkInTime);
      const workedMinutes = Math.floor((now - checkInDate) / 1000 / 60);
      workedHours = Math.round(workedMinutes / 60 * 100) / 100;
    }
    
    await db.collection('attendance').doc(existing.id).update({
      checkOut: admin.firestore.FieldValue.serverTimestamp(),
      checkOutTime: now.toISOString(),
      checkOutLocation: location,
      isEarlyLeave,
      earlyMinutes,
      expectedEndTime: workEndTime,
      workedMinutes: Math.round(workedHours * 60),
      workedHours
    });
    
    return { isEarlyLeave, earlyMinutes, workedHours, workEndTime };
  } catch (error) {
    console.error('checkOut xatosi:', error);
    throw error;
  }
}

async function getMonthlyStats(employeeId) {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `${year}-${month}`;
    
    const snapshot = await db.collection('attendance')
      .where('employeeId', '==', employeeId)
      .get();
    
    const records = snapshot.docs
      .map(d => d.data())
      .filter(r => r.dateString && r.dateString.startsWith(prefix));
    
    const totalWorkedMinutes = records.reduce((sum, r) => sum + (r.workedMinutes || 0), 0);
    
    return {
      presentDays: records.filter(r => r.checkIn).length,
      lateDays: records.filter(r => r.isLate).length,
      onTimeDays: records.filter(r => r.checkIn && !r.isLate).length,
      earlyLeaveDays: records.filter(r => r.isEarlyLeave).length,
      totalLateMinutes: records.reduce((sum, r) => sum + (r.lateMinutes || 0), 0),
      totalWorkedHours: Math.round(totalWorkedMinutes / 60 * 100) / 100
    };
  } catch (error) {
    console.error('getMonthlyStats xatosi:', error);
    throw new Error('Statistikani olishda xatolik');
  }
}

async function createLeaveRequest(data) {
  try {
    await db.collection('leave_requests').add({
      ...data,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'telegram'
    });
  } catch (error) {
    console.error('createLeaveRequest xatosi:', error);
    throw new Error('So\'rov yuborishda xatolik');
  }
}

// ==================== AUTOMATIC REMINDERS ====================

async function sendMorningReminders() {
  try {
    const employees = await getAllEmployees();
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    
    for (const emp of employees) {
      if (!emp.telegramId) continue;
      
      const workStart = emp.workStartTime || DEFAULT_WORK_START;
      const [hour, min] = workStart.split(':').map(Number);
      
      // 30 minutes before
      const reminderHour = min >= 30 ? hour : hour - 1;
      const reminderMin = min >= 30 ? min - 30 : min + 30;
      
      if (currentHour === reminderHour && Math.abs(currentMin - reminderMin) <= 1) {
        const key = `morning_${emp.id}_${getTodayString()}`;
        if (!sentReminders.has(key)) {
          try {
            await bot.telegram.sendMessage(
              emp.telegramId,
              `🔔 *Ertalabki eslatma*\n\n` +
              `Assalomu alaykum, ${emp.name}!\n\n` +
              `⏰ Ish vaqtingiz ${workStart} da boshlanadi.\n` +
              `📍 Ofisga yetib kelganda "📥 Keldim" bosing.`,
              { parse_mode: 'Markdown', ...mainKeyboard }
            );
            sentReminders.add(key);
            console.log(`🔔 Eslatma: ${emp.name}`);
          } catch (err) {
            console.error(`Eslatma xatosi: ${emp.name}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('sendMorningReminders xatosi:', error);
  }
}

async function sendLateReminders() {
  try {
    const employees = await getAllEmployees();
    const now = new Date();
    const today = getTodayString();
    
    for (const emp of employees) {
      if (!emp.telegramId) continue;
      
      const workStart = emp.workStartTime || DEFAULT_WORK_START;
      const lateThreshold = emp.lateThreshold || DEFAULT_LATE_THRESHOLD;
      const [hour, min] = workStart.split(':').map(Number);
      
      const lateTime = new Date();
      lateTime.setHours(hour, min + lateThreshold + 10, 0, 0);
      
      if (now > lateTime) {
        const key = `late_${emp.id}_${today}`;
        if (!sentReminders.has(key)) {
          const attendance = await getTodayAttendance(emp.id);
          
          if (!attendance?.checkIn) {
            try {
              await bot.telegram.sendMessage(
                emp.telegramId,
                `⚠️ *Diqqat!*\n\n` +
                `${emp.name}, siz hali kelganingizni qayd etmadingiz!\n\n` +
                `⏰ Ish vaqti: ${workStart}\n` +
                `🕐 Hozir: ${getCurrentTime()}\n\n` +
                `"📥 Keldim" tugmasini bosing.`,
                { parse_mode: 'Markdown', ...mainKeyboard }
              );
              sentReminders.add(key);
              
              await notifyAdmins(
                `⚠️ *Xodim kelmadi*\n\n👤 ${emp.name}\n⏰ Ish vaqti: ${workStart}`
              );
            } catch (err) {
              console.error(`Late eslatma xatosi: ${emp.name}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('sendLateReminders xatosi:', error);
  }
}

async function sendEndOfDayReminders() {
  try {
    const employees = await getAllEmployees();
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    
    for (const emp of employees) {
      if (!emp.telegramId) continue;
      
      const workEnd = emp.workEndTime || DEFAULT_WORK_END;
      const [hour, min] = workEnd.split(':').map(Number);
      
      // 10 minutes before
      const reminderMin = min >= 10 ? min - 10 : min + 50;
      const reminderHour = min >= 10 ? hour : hour - 1;
      
      if (currentHour === reminderHour && Math.abs(currentMin - reminderMin) <= 1) {
        const key = `end_${emp.id}_${getTodayString()}`;
        if (!sentReminders.has(key)) {
          const attendance = await getTodayAttendance(emp.id);
          
          if (attendance?.checkIn && !attendance?.checkOut) {
            try {
              await bot.telegram.sendMessage(
                emp.telegramId,
                `🔔 *Eslatma*\n\n` +
                `${emp.name}, ish vaqti tugashiga 10 daqiqa!\n\n` +
                `⏰ Ish tugashi: ${workEnd}\n\n` +
                `Ketayotganda "📤 Ketdim" bosing.`,
                { parse_mode: 'Markdown', ...mainKeyboard }
              );
              sentReminders.add(key);
            } catch (err) {
              console.error(`End eslatma xatosi: ${emp.name}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('sendEndOfDayReminders xatosi:', error);
  }
}

// Clear old reminders at midnight
function clearOldReminders() {
  const today = getTodayString();
  for (const key of sentReminders) {
    if (!key.includes(today)) {
      sentReminders.delete(key);
    }
  }
}

// Run reminders every minute
setInterval(() => {
  const hour = new Date().getHours();
  if (hour >= 7 && hour <= 20) {
    sendMorningReminders();
    sendLateReminders();
    sendEndOfDayReminders();
  }
  if (hour === 0) {
    clearOldReminders();
  }
}, 60000);

// ==================== BOT HANDLERS ====================

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  
  try {
    const employee = await getEmployee(telegramId);
    
    if (employee) {
      let msg = `Assalomu alaykum, *${employee.name}*! 👋\n\n`;
      msg += `📍 Lavozim: ${employee.position || '-'}\n`;
      msg += `⏰ Ish vaqti: ${employee.workStartTime || '09:00'} - ${employee.workEndTime || '18:00'}\n`;
      
      if (employee.hourlyRate > 0) {
        msg += `💰 Soatlik: ${employee.hourlyRate.toLocaleString()} so'm`;
      } else {
        msg += `⚠️ Maosh belgilanmagan`;
      }
      
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
    } else {
      userStates.set(telegramId, { step: 'phone' });
      await ctx.reply(
        `Assalomu alaykum! 👋\n\nRo'yxatdan o'tish uchun telefon raqamingizni yuboring:`,
        phoneKeyboard
      );
    }
  } catch (error) {
    await ctx.reply('❌ Xatolik: ' + error.message);
  }
});

bot.on('contact', async (ctx) => {
  const telegramId = ctx.from.id;
  const state = userStates.get(telegramId);
  
  if (state?.step !== 'phone') return;
  
  const contact = ctx.message.contact;
  if (contact.user_id !== telegramId) {
    await ctx.reply('❌ Faqat o\'z telefon raqamingizni yuboring!', phoneKeyboard);
    return;
  }
  
  userStates.set(telegramId, { step: 'name', phone: contact.phone_number });
  await ctx.reply(`✅ Telefon: ${contact.phone_number}\n\nIsmingizni kiriting:`, cancelKeyboard);
});

bot.on('location', async (ctx) => {
  const telegramId = ctx.from.id;
  const state = userStates.get(telegramId);
  const { latitude, longitude } = ctx.message.location;
  
  if (!state || !['checkin', 'checkout'].includes(state.action)) {
    await ctx.reply('❌ Avval "📥 Keldim" yoki "📤 Ketdim" bosing.', mainKeyboard);
    return;
  }
  
  try {
    const employee = await getEmployee(telegramId);
    if (!employee) {
      userStates.delete(telegramId);
      await ctx.reply('❌ Ro\'yxatdan o\'tmagansiz. /start bosing.');
      return;
    }
    
    const locCheck = isWithinOffice(latitude, longitude);
    
    if (!locCheck.isWithin) {
      userStates.delete(telegramId);
      await ctx.reply(
        `❌ *Ofis hududida emassiz!*\n\n📍 Masofa: *${locCheck.distance}m*\n✅ Ruxsat: *${OFFICE.radius}m*`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
      return;
    }
    
    const locationData = { latitude, longitude, distance: locCheck.distance };
    
    if (state.action === 'checkin') {
      const result = await checkIn(employee, locationData);
      
      let msg = `✅ *Kelganingiz qayd etildi!*\n\n👤 ${employee.name}\n🕐 ${getCurrentTime()}`;
      
      if (result.isLate) {
        msg += `\n\n⚠️ *Kechikish: ${result.lateMinutes} daq*`;
        await notifyAdmins(`⚠️ *Kechikdi*\n\n👤 ${employee.name}\n⏰ ${result.lateMinutes} daq`);
      } else {
        msg += `\n\n✅ *O'z vaqtida!*`;
      }
      
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
    } else {
      const result = await checkOut(employee, locationData);
      
      let msg = `✅ *Ketganingiz qayd etildi!*\n\n👤 ${employee.name}\n🕐 ${getCurrentTime()}\n⏱ Ishlagan: *${result.workedHours} soat*`;
      
      if (employee.hourlyRate > 0) {
        const earned = Math.round(result.workedHours * employee.hourlyRate);
        msg += `\n💰 Bugun: *${earned.toLocaleString()} so'm*`;
      }
      
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
    }
    
    userStates.delete(telegramId);
  } catch (error) {
    userStates.delete(telegramId);
    await ctx.reply(`❌ ${error.message}`, mainKeyboard);
  }
});

bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;
  const state = userStates.get(telegramId);
  
  // Cancel
  if (text === '❌ Bekor qilish') {
    userStates.delete(telegramId);
    const emp = await getEmployee(telegramId).catch(() => null);
    await ctx.reply('Bekor qilindi.', emp ? mainKeyboard : Markup.removeKeyboard());
    return;
  }
  
  // Registration
  if (state?.step === 'name') {
    if (text.length < 3) {
      await ctx.reply('❌ Ism juda qisqa.');
      return;
    }
    userStates.set(telegramId, { ...state, step: 'position', name: text });
    await ctx.reply(`✅ Ism: ${text}\n\nLavozimingiz:`, cancelKeyboard);
    return;
  }
  
  if (state?.step === 'position') {
    try {
      await registerEmployee({
        name: state.name,
        phone: state.phone,
        position: text,
        telegramId: String(telegramId)
      });
      userStates.delete(telegramId);
      await ctx.reply(`🎉 *Ro'yxatdan o'tdingiz!*\n\n👤 ${state.name}\n💼 ${text}`, { parse_mode: 'Markdown', ...mainKeyboard });
      await notifyAdmins(`🆕 *Yangi xodim*\n\n👤 ${state.name}\n📱 ${state.phone}\n💼 ${text}`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
    return;
  }
  
  // Leave request flow
  if (state?.step === 'leave_type') {
    let leaveType;
    if (text === "🏖 Ta'til") leaveType = 'vacation';
    else if (text === "🏥 Kasallik") leaveType = 'sick';
    else if (text === "👤 Shaxsiy") leaveType = 'personal';
    else {
      await ctx.reply('❌ Tanlang:', leaveTypeKeyboard);
      return;
    }
    userStates.set(telegramId, { ...state, step: 'leave_start', leaveType });
    await ctx.reply(`Boshlanish sanasi:\n\nFormat: *KK.OO.YYYY*`, { parse_mode: 'Markdown', ...cancelKeyboard });
    return;
  }
  
  if (state?.step === 'leave_start') {
    const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) {
      await ctx.reply('❌ Format: KK.OO.YYYY');
      return;
    }
    const startDate = `${m[3]}-${m[2]}-${m[1]}`;
    userStates.set(telegramId, { ...state, step: 'leave_end', startDate });
    await ctx.reply(`✅ Boshlanish: ${text}\n\nTugash sanasi:`, cancelKeyboard);
    return;
  }
  
  if (state?.step === 'leave_end') {
    const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) {
      await ctx.reply('❌ Format: KK.OO.YYYY');
      return;
    }
    const endDate = `${m[3]}-${m[2]}-${m[1]}`;
    userStates.set(telegramId, { ...state, step: 'leave_reason', endDate });
    await ctx.reply(`✅ Tugash: ${text}\n\nSabab (yoki "o'tkazish"):`, cancelKeyboard);
    return;
  }
  
  if (state?.step === 'leave_reason') {
    try {
      const employee = await getEmployee(telegramId);
      const reason = text === "o'tkazish" ? '' : text;
      const types = { vacation: "Ta'til", sick: "Kasallik", personal: "Shaxsiy" };
      
      await createLeaveRequest({
        employeeId: employee.id,
        employeeName: employee.name,
        type: state.leaveType,
        startDate: state.startDate,
        endDate: state.endDate,
        reason
      });
      
      const days = Math.ceil((new Date(state.endDate) - new Date(state.startDate)) / 86400000) + 1;
      
      userStates.delete(telegramId);
      await ctx.reply(`✅ *So'rov yuborildi!*\n\n📋 ${types[state.leaveType]}\n📅 ${state.startDate} → ${state.endDate}\n⏱ ${days} kun\n\n⏳ Tasdiqlashni kuting.`, { parse_mode: 'Markdown', ...mainKeyboard });
      await notifyAdmins(`📝 *Ta'til so'rovi*\n\n👤 ${employee.name}\n📋 ${types[state.leaveType]}\n📅 ${state.startDate} → ${state.endDate}\n⏱ ${days} kun`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`, mainKeyboard);
    }
    return;
  }
  
  // Main menu
  try {
    const employee = await getEmployee(telegramId);
    
    if (text === '📥 Keldim') {
      if (!employee) { await ctx.reply('❌ /start bosing.'); return; }
      const today = await getTodayAttendance(employee.id);
      if (today?.checkIn) {
        await ctx.reply(`ℹ️ Allaqachon qayd etilgan.\n🕐 ${formatTime(today.checkIn)}`, mainKeyboard);
        return;
      }
      userStates.set(telegramId, { action: 'checkin' });
      await ctx.reply(`📍 *Joylashuvni yuboring*`, { parse_mode: 'Markdown', ...locationKeyboard });
      return;
    }
    
    if (text === '📤 Ketdim') {
      if (!employee) { await ctx.reply('❌ /start bosing.'); return; }
      const today = await getTodayAttendance(employee.id);
      if (!today?.checkIn) {
        await ctx.reply('❌ Avval "📥 Keldim" bosing.', mainKeyboard);
        return;
      }
      if (today.checkOut) {
        await ctx.reply(`ℹ️ Allaqachon qayd etilgan.\n🕐 ${formatTime(today.checkOut)}`, mainKeyboard);
        return;
      }
      userStates.set(telegramId, { action: 'checkout' });
      await ctx.reply(`📍 *Joylashuvni yuboring*`, { parse_mode: 'Markdown', ...locationKeyboard });
      return;
    }
    
    if (text === "📝 Ta'til so'rovi") {
      if (!employee) { await ctx.reply('❌ /start bosing.'); return; }
      userStates.set(telegramId, { step: 'leave_type' });
      await ctx.reply(`📝 *Ta'til/kasallik*\n\nTurini tanlang:`, { parse_mode: 'Markdown', ...leaveTypeKeyboard });
      return;
    }
    
    if (text === '📅 Bugungi holat') {
      if (!employee) { await ctx.reply('❌ /start bosing.'); return; }
      const today = await getTodayAttendance(employee.id);
      let msg = `📅 *Bugungi holat*\n\n👤 ${employee.name}\n`;
      if (!today?.checkIn) msg += `\n❓ Hali qayd etilmagan`;
      else if (!today.checkOut) {
        msg += `\n🟢 Ish joyida\n🕐 Kelish: ${formatTime(today.checkIn)}`;
        if (today.isLate) msg += ` ⚠️ +${today.lateMinutes}daq`;
      } else {
        msg += `\n✅ Yakunlangan\n🕐 ${formatTime(today.checkIn)} → ${formatTime(today.checkOut)}\n⏱ ${today.workedHours} soat`;
        if (employee.hourlyRate) msg += `\n💰 ${Math.round(today.workedHours * employee.hourlyRate).toLocaleString()} so'm`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
      return;
    }
    
    if (text === '📊 Statistika') {
      if (!employee) { await ctx.reply('❌ /start bosing.'); return; }
      const stats = await getMonthlyStats(employee.id);
      const month = new Date().toLocaleDateString('uz-UZ', { month: 'long' });
      const rate = stats.presentDays > 0 ? Math.round((stats.onTimeDays / stats.presentDays) * 100) : 0;
      let msg = `📊 *${month}*\n\n👤 ${employee.name}\n\n`;
      msg += `✅ Kelgan: ${stats.presentDays} kun\n`;
      msg += `🎯 O'z vaqtida: ${stats.onTimeDays} (${rate}%)\n`;
      msg += `⚠️ Kechikkan: ${stats.lateDays} kun\n`;
      msg += `⏱ Ishlagan: ${stats.totalWorkedHours} soat`;
      if (employee.hourlyRate) {
        msg += `\n\n💰 *~${Math.round(stats.totalWorkedHours * employee.hourlyRate).toLocaleString()} so'm*`;
      }
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
      return;
    }
    
    if (text === '❓ Yordam') {
      await ctx.reply(
        `❓ *Yordam*\n\n` +
        `📥 Keldim - Ishga kelganda\n` +
        `📤 Ketdim - Ketayotganda\n` +
        `📅 Bugungi holat\n` +
        `📊 Statistika\n` +
        `📝 Ta'til so'rovi\n\n` +
        `🔔 *Eslatmalar:*\n` +
        `• 30 daq oldin - ertalabki\n` +
        `• Kechikayotganda - ogohlantirish\n` +
        `• 10 daq oldin - ish tugashi`,
        { parse_mode: 'Markdown', ...mainKeyboard }
      );
      return;
    }
  } catch (error) {
    await ctx.reply(`❌ ${error.message}`, mainKeyboard);
  }
});

bot.catch((err, ctx) => {
  console.error('Bot xatosi:', err);
  ctx.reply('❌ Xatolik.', mainKeyboard).catch(() => {});
});

console.log('🤖 Bot ishga tushmoqda...');
bot.launch().then(() => {
  console.log('✅ Bot ishga tushdi!');
  console.log(`📍 Ofis: ${OFFICE.latitude}, ${OFFICE.longitude}`);
  console.log('🔔 Avtomatik eslatmalar yoqilgan');
}).catch(err => {
  console.error('❌ Bot ishga tushmadi:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
