// 37°59'43.2"N 67°47'21.0"E
const OFFICE_LATITUDE = parseFloat(process.env.OFFICE_LATITUDE) || 37.995333;
const OFFICE_LONGITUDE = parseFloat(process.env.OFFICE_LONGITUDE) || 67.789167;
const OFFICE_RADIUS = parseInt(process.env.OFFICE_RADIUS) || 50; // metr

/**
 * Ikki nuqta orasidagi masofani hisoblash (Haversine formula)
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Yer radiusi metrda
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Foydalanuvchi ofis hududida ekanligini tekshirish
 */
export function isWithinOffice(userLat, userLon) {
  const distance = calculateDistance(
    userLat,
    userLon,
    OFFICE_LATITUDE,
    OFFICE_LONGITUDE
  );

  return {
    isWithin: distance <= OFFICE_RADIUS,
    distance: Math.round(distance),
    maxRadius: OFFICE_RADIUS,
  };
}

/**
 * Masofani formatlash
 */
export function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}
