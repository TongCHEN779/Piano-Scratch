// Sheet-music image -> notes, using a Claude vision model called directly from the browser
// with the user's own API key (nothing goes through any server of ours).
const API = 'https://api.anthropic.com/v1/messages';

export const PROMPT = `You are an optical music recognition engine. The image is piano sheet music (grand staff: treble = right hand, bass = left hand).
Transcribe every note you can read, in order, as JSON ONLY (no prose, no markdown fences) with this exact shape:
{"key_fifths": <int, -7..7, key signature: sharps positive, flats negative>,
 "beats_per_measure": <int, number of QUARTER-note beats per measure, e.g. 4/4 -> 4, 3/4 -> 3, 2/4 -> 2, 6/8 -> 3>,
 "tempo": <int bpm or null>,
 "measures": [ {"notes": [ {"pitch": "F#4", "start": 0, "dur": 1, "staff": "treble"} ]} ]}
Rules:
- "pitch" is the actual sounding pitch with the key signature and any accidentals in that measure already applied (e.g. "F#4", "Bb3", "C5"). Middle C is C4.
- "start" is the position inside the measure in quarter-note beats (0-based), "dur" is the length in quarter-note beats (eighth = 0.5, dotted quarter = 1.5, half = 2...). Merge tied notes into one longer note when it stays within the measure.
- Chords are several notes with the same start. Do not output rests.
- "staff" is "treble" or "bass". One entry in "measures" per bar, in reading order, including bars that only have rests (empty "notes").
- If something is unreadable, make your best guess rather than skipping the bar.`;

/** Load an image File/Blob into a downscaled JPEG base64 string. */
export async function imageToBase64(blob, maxEdge = 1568) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
}

export async function recognize(blob, { apiKey, model }) {
  const data = await imageToBase64(blob);
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 12000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseModelText(text);
}

/** Pull the JSON object out of a model reply (tolerates prose and ``` fences around it). */
export function parseModelText(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('没有找到 JSON，请确认粘贴的是完整回复');
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new Error('JSON 格式有误（可能回复被截断），请让 Claude 继续输出或缩小图片范围后重试');
  }
}

const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function pitchToMidi(name) {
  const m = /^([A-Ga-g])([#b♯♭x]*)(-?\d)$/.exec(String(name).trim());
  if (!m) return null;
  let alt = 0;
  for (const ch of m[2]) alt += ch === '#' || ch === '♯' ? 1 : ch === 'x' ? 2 : -1;
  return 12 * (Number(m[3]) + 1) + NATURAL[m[1].toUpperCase()] + alt;
}

/** Model JSON -> {key, beats, bpm, notes:[{midi,start,dur,hand}]} in absolute beats. */
export function toScoreData(json) {
  const beats = [2, 3, 4].includes(json.beats_per_measure) ? json.beats_per_measure : 4;
  const notes = [];
  (json.measures || []).forEach((m, mi) => {
    for (const n of m.notes || []) {
      const midi = pitchToMidi(n.pitch);
      if (midi == null || !(n.dur > 0)) continue;
      notes.push({ midi, start: mi * beats + Number(n.start || 0), dur: Number(n.dur), hand: n.staff === 'bass' ? 'L' : 'R' });
    }
  });
  const key = Math.max(-7, Math.min(7, Math.round(json.key_fifths || 0)));
  return { key, beats, bpm: json.tempo > 20 ? json.tempo : null, notes, measures: (json.measures || []).length };
}
