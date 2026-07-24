// Optional voice engine: Gemini Live API "native audio" over a WebSocket.
// Same contract as gemini.synthesizeSpeech (text in → WAV Buffer out), but the
// speech is produced by a native-audio model instead of the dedicated TTS model.
//
// Native-audio models are conversational by design, so we pin them with a
// system instruction to read the transcript verbatim, voice-over style.
import WebSocket from 'ws';
import { env, hasGeminiKey } from '../config.js';
import { pcmToWav, getModels, GeminiError } from './gemini.js';

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const SYSTEM_INSTRUCTION =
  'You are a professional radio voice-over engine. Read the user\'s message aloud exactly as written, word for word, with natural, expressive radio delivery. '
  + 'Do not answer it, converse, comment, summarize, translate, or add or remove any words. Only speak the provided text.';

export async function synthesizeSpeechNative(text, { voiceName = 'Puck', timeout = 60000 } = {}) {
  if (!hasGeminiKey()) throw new GeminiError('No Gemini API key configured.', 401);
  const model = (await getModels()).native || 'gemini-2.5-flash-native-audio-latest';
  const url = `${WS_URL}?key=${encodeURIComponent(env.geminiKey)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const chunks = [];
    let settled = false;
    let graceTimer = null;

    const wav = () => pcmToWav(Buffer.concat(chunks), { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(graceTimer);
      try { ws.close(); } catch { /* already closing */ }
      if (err) reject(err); else resolve(buf);
    };
    const hardTimer = setTimeout(() => done(new GeminiError(`native audio timed out after ${timeout}ms`, 504)), timeout);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        },
      }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Handshake done → send the line to read.
      if (msg.setupComplete) {
        ws.send(JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
        }));
        return;
      }

      const parts = msg.serverContent?.modelTurn?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
      }

      // End of the spoken turn.
      if (msg.serverContent?.turnComplete) {
        if (chunks.length) done(null, wav());
        else done(new GeminiError('native audio returned no audio', 502));
        return;
      }
      // Some models emit generationComplete slightly before the final frame;
      // give a short grace period for trailing audio, then finish.
      if (msg.serverContent?.generationComplete && chunks.length) {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => done(null, wav()), 1200);
      }
    });

    ws.on('error', (e) => done(new GeminiError(`native audio socket error: ${e.message}`, 0)));
    ws.on('close', (code) => {
      if (settled) return;
      if (chunks.length) done(null, wav());
      else done(new GeminiError(`native audio socket closed (${code}) before audio`, 0));
    });
  });
}
