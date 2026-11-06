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

/**
 * The Public chat: in everyone's chat list, readable by all, only admins (ADMIN_IDS) can
 * post — for announcements. Its ID is reserved (nobody can create or own a room with it).
 */
export const PUBLIC_ROOM_ID = 'public';

/**
 * `@UserId` mentions in chat: the @ must start a word (so "a@b.com" isn't one).
 * Group 1 is what precedes the @, group 2 the user ID.
 */
export const MENTION_PATTERN = /(^|[^\w@])@([A-Za-z][A-Za-z0-9_]{2,19})(?!\w)/g;

/** The user IDs mentioned in a message (as written, de-duplicated case-insensitively). */
export function mentionsIn(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(MENTION_PATTERN)) seen.set(match[2].toLowerCase(), match[2]);
  return [...seen.values()];
}

/** Custom emoji names, used as `:name:` in messages. */
export const EMOJI_NAME_PATTERN = /^[a-z0-9_]{2,24}$/;
export const EMOJI_NAME_RULES = '2–24 characters: lowercase letters, digits or "_".';
/** Matches `:name:` shortcodes in message text. */
export const EMOJI_SHORTCODE = /:([a-z0-9_]{2,24}):/g;
/** Largest image accepted (bytes, after the app has shrunk it). */
export const MAX_EMOJI_BYTES = 96 * 1024;
export const MAX_AVATAR_BYTES = 256 * 1024;
export const MAX_STICKER_BYTES = 256 * 1024;

export function isValidEmojiName(value: unknown): value is string {
  return typeof value === 'string' && EMOJI_NAME_PATTERN.test(value);
}

export function isValidPin(value: unknown): value is string {
  return typeof value === 'string' && PIN_PATTERN.test(value);
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

export function isValidRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

export const MAX_EMAIL_LENGTH = 254;

/** A plausible email address (the mail server has the final word). */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(value);
}
