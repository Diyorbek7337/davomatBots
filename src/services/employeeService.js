import { db } from '../config/firebase.js';
import admin from 'firebase-admin';

const EMPLOYEES_COLLECTION = 'employees';
const ATTENDANCE_COLLECTION = 'attendance';
const HOLIDAYS_COLLECTION = 'holidays';

// Late threshold in minutes
const LATE_THRESHOLD = parseInt(process.env.LATE_THRESHOLD) || 5;

// ==================== TA'TILLAR ====================

/**
 * Bugun ta'til kunmi tekshirish
 */
export async function isHoliday(date = new Date()) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const snapshot = await db
    .collection(HOLIDAYS_COLLECTION)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('date', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .limit(1)
    .get();

  if (!snapshot.empty) {
    const holiday = snapshot.docs[0].data();
    return { isHoliday: true, name: holiday.name };
  }
  return { isHoliday: false, name: null };
}

// ==================== XODIMLAR ====================

/**
 * Telegram ID bo'yicha xodimni topish
 */
export async function getEmployeeByTelegramId(telegramId) {
  const snapshot = await db
    .collection(EMPLOYEES_COLLECTION)
    .where('telegramId', '==', telegramId.toString())
    .limit(1)
    .get();
  
  if (snapshot.empty) return null;
  
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

/**
 * Yangi xodimni ro'yxatdan o'tkazish (o'zi ro'yxatdan o'tish)
 */
export async function registerEmployee(data) {
  // Telefon raqam allaqachon bormi tekshirish
  const cleanPhone = data.phone.replace(/\D/g, '');
  const phoneSnapshot = await db.collection(EMPLOYEES_COLLECTION).get();
  
  for (const doc of phoneSnapshot.docs) {
    const emp = doc.data();
    const empPhone = emp.phone?.replace(/\D/g, '');
    if (empPhone && empPhone === cleanPhone) {
      throw new Error('Bu telefon raqam allaqachon ro\'yxatdan o\'tgan');
    }
  }
  
  // Telegram ID allaqachon bormi tekshirish
  const telegramSnapshot = await db
    .collection(EMPLOYEES_COLLECTION)
    .where('telegramId', '==', data.telegramId)
    .limit(1)
    .get();
  
  if (!telegramSnapshot.empty) {
    throw new Error('Bu Telegram akkaunt allaqachon ro\'yxatdan o\'tgan');
  }
  
  // Yangi xodim qo'shish
  const docRef = await db.collection(EMPLOYEES_COLLECTION).add({
    name: data.name,
    phone: data.phone,
    position: data.position,
    telegramId: data.telegramId,
    telegramUsername: data.telegramUsername || null,
    isActive: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  
  return docRef.id;
}

/**
 * Xodimni Telegram ID bilan bog'lash
 */
export async function linkTelegramId(employeeId, telegramId) {
  await db.collection(EMPLOYEES_COLLECTION).doc(employeeId).update({
    telegramId: telegramId.toString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ==================== DAVOMAT ====================

/**
 * Bugungi sana (UTC+5 Toshkent)
 */
function getTodayDate() {
  const now = new Date();
  // Adjust for Tashkent timezone
  const tashkentOffset = 5 * 60; // UTC+5 in minutes
  const localOffset = now.getTimezoneOffset();
  now.setMinutes(now.getMinutes() + localOffset + tashkentOffset);
  now.setHours(0, 0, 0, 0);
  return now;
}

/**
 * Bugungi davomat yozuvini olish
 */
export async function getTodayAttendance(employeeId) {
  const today = getTodayDate();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const snapshot = await db
    .collection(ATTENDANCE_COLLECTION)
    .where('employeeId', '==', employeeId)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(today))
    .where('date', '<', admin.firestore.Timestamp.fromDate(tomorrow))
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

/**
 * Keldi qayd etish
 */
export async function checkIn(employeeId, location, method = 'button') {
  const today = getTodayDate();

  // Mavjud yozuvni tekshirish
  const existing = await getTodayAttendance(employeeId);
  if (existing && existing.checkIn) {
    throw new Error('Siz bugun allaqachon kelganingizni qayd etgansiz');
  }

  const attendanceData = {
    employeeId,
    date: admin.firestore.Timestamp.fromDate(today),
    checkIn: admin.firestore.FieldValue.serverTimestamp(),
    checkInLocation: location,
    checkInMethod: method,
    status: 'present',
  };

  // Kechikishni tekshirish (5 daqiqa threshold bilan)
  const workStart = process.env.WORK_START_TIME || '09:00';
  const [startHour, startMin] = workStart.split(':').map(Number);
  
  const now = new Date();
  // Convert to Tashkent time
  const tashkentOffset = 5 * 60;
  const localOffset = now.getTimezoneOffset();
  const tashkentNow = new Date(now.getTime() + (localOffset + tashkentOffset) * 60 * 1000);
  
  // Work start time + threshold
  const workStartWithThreshold = new Date(tashkentNow);
  workStartWithThreshold.setHours(startHour, startMin + LATE_THRESHOLD, 0, 0);
  
  // Actual work start time (for calculating late minutes)
  const actualWorkStart = new Date(tashkentNow);
  actualWorkStart.setHours(startHour, startMin, 0, 0);

  if (tashkentNow > workStartWithThreshold) {
    attendanceData.isLate = true;
    attendanceData.lateMinutes = Math.floor((tashkentNow - actualWorkStart) / 1000 / 60);
  } else {
    attendanceData.isLate = false;
    attendanceData.lateMinutes = 0;
  }

  if (existing) {
    await db.collection(ATTENDANCE_COLLECTION).doc(existing.id).update(attendanceData);
    return { ...attendanceData, id: existing.id };
  } else {
    const docRef = await db.collection(ATTENDANCE_COLLECTION).add(attendanceData);
    return { ...attendanceData, id: docRef.id };
  }
}

/**
 * Ketdi qayd etish
 */
export async function checkOut(employeeId, location, method = 'button') {
  const existing = await getTodayAttendance(employeeId);

  if (!existing) {
    throw new Error('Siz bugun kelganingizni qayd etmagansiz');
  }

  if (existing.checkOut) {
    throw new Error('Siz bugun allaqachon ketganingizni qayd etgansiz');
  }

  const updateData = {
    checkOut: admin.firestore.FieldValue.serverTimestamp(),
    checkOutLocation: location,
    checkOutMethod: method,
  };

  // Erta ketishni tekshirish
  const workEnd = process.env.WORK_END_TIME || '18:00';
  const [endHour, endMin] = workEnd.split(':').map(Number);
  
  const now = new Date();
  // Convert to Tashkent time
  const tashkentOffset = 5 * 60;
  const localOffset = now.getTimezoneOffset();
  const tashkentNow = new Date(now.getTime() + (localOffset + tashkentOffset) * 60 * 1000);
  
  const workEndTime = new Date(tashkentNow);
  workEndTime.setHours(endHour, endMin, 0, 0);

  if (tashkentNow < workEndTime) {
    updateData.isEarlyLeave = true;
    updateData.earlyMinutes = Math.floor((workEndTime - tashkentNow) / 1000 / 60);
  } else {
    updateData.isEarlyLeave = false;
    updateData.earlyMinutes = 0;
  }

  await db.collection(ATTENDANCE_COLLECTION).doc(existing.id).update(updateData);
  return { ...existing, ...updateData };
}

/**
 * Xodimning oylik statistikasi
 */
export async function getMonthlyStats(employeeId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  endOfMonth.setHours(23, 59, 59, 999);

  const snapshot = await db
    .collection(ATTENDANCE_COLLECTION)
    .where('employeeId', '==', employeeId)
    .where('date', '>=', admin.firestore.Timestamp.fromDate(startOfMonth))
    .where('date', '<=', admin.firestore.Timestamp.fromDate(endOfMonth))
    .get();

  const records = snapshot.docs.map(doc => doc.data());

  return {
    totalDays: records.length,
    presentDays: records.filter(r => r.checkIn).length,
    lateDays: records.filter(r => r.isLate).length,
    earlyLeaveDays: records.filter(r => r.isEarlyLeave).length,
    totalLateMinutes: records.reduce((sum, r) => sum + (r.lateMinutes || 0), 0),
  };
}
