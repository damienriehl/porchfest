// The MIME encodings a mail payload is built from, in one place.
//
// Core renders an exported .eml (waves.ts) and the SMTP adapter renders what
// goes on the wire, and for a while each carried its own copy of these three
// helpers. The copies drifted: one learned not to split a UTF-8 sequence across
// two encoded words and the other did not, so the same subject exported one way
// and transmitted another. There is one implementation now, and it lives in
// core because core may not import an adapter package while an adapter may
// import core.
//
// Everything here is a pure function of its input: no clock, no locale, no
// host state. Same message, same bytes, on every machine.

export const CRLF = "\r\n";

const MAX_QP_LINE_LENGTH = 76;
/** =?UTF-8?B?…?= must stay inside 75 characters; 45 bytes of base64 fits. */
const MAX_ENCODED_WORD_BYTES = 45;
const TAB = String.fromCharCode(9);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Quoted-printable per RFC 2045 section 6.7. Lines stay within 76 characters
 * including the soft-break "=". Chosen over base64 because an exported .eml is
 * something an organizer may open in a text editor, and a quoted-printable body
 * is still readable there.
 */
export function encodeQuotedPrintable(input: string): string {
  const normalized = input.split(CRLF).join("\n").split("\r").join("\n");
  const bytes = Buffer.from(normalized, "utf8");
  const lines: string[] = [];
  let line = "";

  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines.push(...closeLine(line));
      line = "";
      continue;
    }
    const token = encodeByte(byte);
    if (line.length + token.length > MAX_QP_LINE_LENGTH - 1) {
      lines.push(`${line}=`);
      line = "";
    }
    line += token;
  }
  lines.push(...closeLine(line));
  return lines.join(CRLF);
}

function encodeByte(byte: number): string {
  if (byte === 0x3d) return "=3D";
  if (byte === 0x09 || byte === 0x20) return String.fromCharCode(byte);
  if (byte >= 0x21 && byte <= 0x7e) return String.fromCharCode(byte);
  return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Whitespace at end of line is stripped by many relays, which would silently
 * change the body. Encode the last one so the run survives transport.
 */
function closeLine(line: string): string[] {
  const last = line.slice(-1);
  if (last !== " " && last !== TAB) return [line];
  const encoded = last === " " ? "=20" : "=09";
  const head = line.slice(0, -1);
  if (head.length + encoded.length <= MAX_QP_LINE_LENGTH) {
    return [`${head}${encoded}`];
  }
  return [`${head}=`, encoded];
}

/**
 * RFC 2047 encoded words, folded so no header line runs long.
 *
 * A value that is already printable US-ASCII is returned untouched; anything
 * else - including a CR or LF somebody smuggled into a name - travels base64
 * inside an encoded word, where it cannot become a header of its own.
 */
export function encodeHeaderValue(value: string): string {
  if (isPrintableAscii(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX_ENCODED_WORD_BYTES, bytes.length);
    // RFC 2047 section 5: an encoded word holds a whole number of characters.
    // Never split a UTF-8 sequence across two of them - a client decoding word
    // by word would show a replacement character where the cut landed.
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${bytes.subarray(start, end).toString("base64")}?=`);
    start = end;
  }
  return words.join(`${CRLF} `);
}

export function isPrintableAscii(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** RFC 5322 date, always in UTC so it never reads the host's zone. */
export function formatRfc5322Date(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "Sun";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${weekday}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${time} +0000`;
}
