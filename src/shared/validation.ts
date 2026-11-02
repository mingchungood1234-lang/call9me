/** User IDs: English letters, digits, underscore; must start with a letter; 3–20 chars. */
export const USER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
export const USER_ID_RULES =
  '3–20 characters, English letters (A–Z), digits and underscore only, starting with a letter.';

/** Room IDs: English letters, digits, dash, underscore; 1–32 chars. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const ROOM_ID_RULES = '1–32 characters: English letters, digits, "-" or "_".';

/** PIN: exactly 4 digits. Set on first login for an ID, required afterwards. */
export const PIN_PATTERN = /^\d{4}$/;
export const PIN_RULES = 'PIN must be exactly 4 digits.';

export const MAX_MESSAGE_LENGTH = 500;

export function isValidPin(value: unknown): value is string {
  return typeof value === 'string' && PIN_PATTERN.test(value);
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

export function isValidRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}
