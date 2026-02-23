import crypto from 'crypto';

const QR_SECRET = process.env.QR_SECRET || 'default_secret_key';
const QR_INTERVAL = 15; // soniya

/**
 * Joriy vaqt oynasini hisoblash
 */
export function getCurrentTimeWindow() {
  return Math.floor(Date.now() / 1000 / QR_INTERVAL);
}

/**
 * Hash yaratish
 */
function generateHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * QR kodni tekshirish
 * @param {string} code - Skanerdan olingan kod
 * @param {number} tolerance - Qancha vaqt oynasi orqaga ruxsat (default: 1)
 */
export function verifyQRCode(code, tolerance = 1) {
  const currentWindow = getCurrentTimeWindow();
  
  // Joriy va oldingi vaqt oynalarini tekshirish
  for (let i = 0; i <= tolerance; i++) {
    const checkWindow = currentWindow - i;
    const input = `${QR_SECRET}_${checkWindow}`;
    const hash = generateHash(input);
    const expectedCode = hash.substring(0, 16).toUpperCase();
    
    if (code.toUpperCase() === expectedCode) {
      return {
        valid: true,
        timeWindow: checkWindow,
        delay: i * QR_INTERVAL,
      };
    }
  }
  
  return {
    valid: false,
    timeWindow: null,
    delay: null,
  };
}

/**
 * QR URL dan kodni ajratib olish
 */
export function parseQRUrl(url) {
  try {
    // Format: attendance://check?code=XXXX&t=TIMESTAMP
    if (url.startsWith('attendance://')) {
      const params = new URLSearchParams(url.split('?')[1]);
      return {
        code: params.get('code'),
        timeWindow: parseInt(params.get('t')),
      };
    }
    // Oddiy kod sifatida
    return { code: url.toUpperCase(), timeWindow: null };
  } catch {
    return null;
  }
}
