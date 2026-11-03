import type { CustomEmoji } from '../../shared/types';
import { EMOJI_SHORTCODE } from '../../shared/validation';
import { el } from './dom';
import type { AppSocket } from './socket';

/** The picker's built-in emoji, by group. */
export const STANDARD_EMOJI: { label: string; emoji: string[] }[] = [
  {
    label: 'Smileys',
    emoji: [...'😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😛😜🤪😎🤩🥳😏😌😴🤔🤨😐🙄😬😮😯😲🥺😢😭😤😡🤯😱😳🤗🤫🤭🫡🤐😷🤒🤕🤠👻💀🤖👽🙈🙉🙊'],
  },
  { label: 'Gestures', emoji: [...'👍👎👌✌🤞🤟🤘👋🙌👏🙏💪👀🫶🤝✋☝👆👇👈👉'] },
  { label: 'Hearts', emoji: [...'❤🧡💛💚💙💜🖤🤍🤎💔💕💖💯✨🔥⭐🌟💥💫'] },
  { label: 'Things', emoji: [...'🎉🎊🎁🎂🍕🍔🍟☕🍺🍻🥂🍿⚽🏀🎮🎧🎵📞📷💻📱⏰✅❌❓❗💡🚀🌈☀🌙⚡☔🐶🐱🐼🦊🐸🐵🦄🐝'] },
];

/** Older symbols (❤ ☀ ✌…) need the emoji variation selector to show in color. */
export function withEmojiStyle(char: string): string {
  return (char.codePointAt(0) ?? 0) < 0x1f000 ? `${char}️` : char;
}

/** Custom emoji everyone can use: kept current from the server's `emoji:update`. */
export class CustomEmojiStore {
  private list: CustomEmoji[] = [];
  private byName = new Map<string, CustomEmoji>();
  private readonly listeners: (() => void)[] = [];

  constructor(socket: AppSocket) {
    socket.on('emoji:update', (list) => {
      this.list = list;
      this.byName = new Map(list.map((e) => [e.name, e]));
      this.listeners.forEach((l) => l());
    });
  }

  get all(): CustomEmoji[] {
    return this.list;
  }

  get(name: string): CustomEmoji | undefined {
    return this.byName.get(name);
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

/** Unicode emoji plus the joiners/modifiers that build up sequences like 👍🏽 or 👩‍💻. */
const UNICODE_EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu;
const JUMBO_LIMIT = 3;

/**
 * Fills `target` with `text`, turning `:name:` into the custom emoji's picture. Messages
 * that are just a few emoji are marked "jumbo" (shown bigger), like most chat apps do.
 */
export function renderRichText(target: HTMLElement, text: string, store: CustomEmojiStore): void {
  const nodes: Node[] = [];
  let customCount = 0;
  let unknownCount = 0;
  // split() with a capture group alternates: text, name, text, name, ...
  const parts = text.split(EMOJI_SHORTCODE);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      if (part) nodes.push(document.createTextNode(part));
      continue;
    }
    const emoji = store.get(part);
    if (!emoji) {
      nodes.push(document.createTextNode(`:${part}:`));
      unknownCount++;
      continue;
    }
    const img = el('img', { className: 'emoji-custom', title: `:${emoji.name}:` });
    img.src = emoji.url;
    img.alt = `:${emoji.name}:`;
    img.loading = 'lazy';
    img.decoding = 'async';
    nodes.push(img);
    customCount++;
  }
  target.replaceChildren(...nodes);

  const leftover = parts.filter((_, i) => i % 2 === 0).join('');
  const unicodeCount = [...leftover.matchAll(/\p{Extended_Pictographic}/gu)].length;
  const onlyEmoji = unknownCount === 0 && leftover.replace(UNICODE_EMOJI, '').trim() === '';
  const total = customCount + unicodeCount;
  target.classList.toggle('msg-jumbo', onlyEmoji && total > 0 && total <= JUMBO_LIMIT);
}
