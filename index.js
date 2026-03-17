/**
 * Discord Voice Recorder v5
 * KEY: Client must be initialized with { patchVoice: true }
 * This patches @discordjs/voice to work with user tokens (selfbot)
 */

'use strict';

const { Client }             = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
}                            = require('@discordjs/voice');
const { OpusEncoder }        = require('@discordjs/opus');
const fs                     = require('fs');
const path                   = require('path');
const { spawn }              = require('child_process');
const ffmpegPath             = require('ffmpeg-static');
const axios                  = require('axios');
const FormData               = require('form-data');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN       = process.env.TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TEMP_DIR    = path.join(__dirname, 'temp');
const MAX_BYTES   = 20 * 1024 * 1024;
const SIZE_CHECK  = 2000;
const SAMPLE_RATE = 48000;
const CHANNELS    = 2;
const FRAME_SIZE  = 960;
// ──────────────────────────────────────────────────────────────────────────────

if (!TOKEN || !WEBHOOK_URL) {
  console.error('[ERROR] TOKEN and WEBHOOK_URL must be set as environment variables.');
  process.exit(1);
}

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const encoder  = new OpusEncoder(SAMPLE_RATE, CHANNELS);
const sessions = new Map();

// ─── UTILS ────────────────────────────────────────────────────────────────────

function safeDelete(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function convertToMp3(pcmPath) {
  return new Promise((resolve, reject) => {
    const mp3Path = pcmPath.replace(/\.pcm$/, '.mp3');
    const errBuf  = [];
    const ff = spawn(ffmpegPath, [
      '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      '-i', pcmPath, '-codec:a', 'libmp3lame', '-b:a', '48k', mp3Path,
    ]);
    ff.stderr.on('data', d => errBuf.push(d));
    ff.on('close', code => {
      if (code === 0) resolve(mp3Path);
      else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errBuf).toString().slice(-300)}`));
    });
    ff.on('error', reject);
  });
}

async function sendToWebhook(mp3Path) {
  const form = new FormData();
  form.append('content', `🎙️ \`${path.basename(mp3Path)}\``);
  form.append('file', fs.createReadStream(mp3Path), { filename: path.basename(mp3Path) });
  await axios.post(WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120_000,
  });
  console.log(`[WEBHOOK] ✓ ${path.basename(mp3Path)}`);
}

async function processPcm(pcmPath) {
  let mp3Path = null;
  try {
    const size = fs.existsSync(pcmPath) ? fs.statSync(pcmPath).size : 0;
    if (size < 4096) { safeDelete(pcmPath); return; }
    console.log(`[PIPELINE] Converting ${path.basename(pcmPath)} (${(size / 1e6).toFixed(2)} MB)`);
    mp3Path = await convertToMp3(pcmPath);
    await sendToWebhook(mp3Path);
  } catch (err) {
    console.error(`[PIPELINE ERROR] ${err.message}`);
  } finally {
    safeDelete(pcmPath);
    if (mp3Path) safeDelete(mp3Path);
  }
}

// ─── RECORDING SESSION ────────────────────────────────────────────────────────

class RecordingSession {
  constructor(connection, guildId) {
    this.connection = connection;
    this.guildId    = guildId;
    this.receiver   = connection.receiver;
    this._ws        = null;
    this._pcmPath   = null;
    this._bytes     = 0;
    this._idx       = 0;
    this._rotating  = false;
    this._subs      = new Set();

    this._openFile();
    this._timer = setInterval(() => this._checkRotate(), SIZE_CHECK);
    this._attach();
    console.log(`[SESSION] Started — guild ${guildId}`);
  }

  _openFile() {
    this._idx++;
    this._pcmPath = path.join(TEMP_DIR, `rec_${this.guildId}_${nowTag()}_${this._idx}.pcm`);
    this._ws = fs.createWriteStream(this._pcmPath);
    this._bytes = 0;
    this._ws.on('error', e => console.error('[WS ERROR]', e.message));
    console.log(`[FILE] ${path.basename(this._pcmPath)}`);
  }

  _checkRotate() {
    if (!this._rotating && this._bytes >= MAX_BYTES) {
      console.log(`[ROTATE] ${(this._bytes / 1e6).toFixed(1)} MB`);
      this._rotate();
    }
  }

  _rotate() {
    this._rotating = true;
    const oldPath  = this._pcmPath;
    const oldWs    = this._ws;
    this._openFile();          // redirect audio to new file immediately
    this._rotating = false;
    oldWs.end(() => processPcm(oldPath));
  }

  _write(audioStream, chunk) {
    if (!this._ws || this._ws.destroyed) return;
    const ok = this._ws.write(chunk);
    this._bytes += chunk.length;
    if (!ok) {
      audioStream.pause();
      this._ws.once('drain', () => { if (!audioStream.destroyed) audioStream.resume(); });
    }
  }

  _attach() {
    this.receiver.speaking.on('start', userId => {
      if (this._subs.has(userId)) return;
      this._subs.add(userId);

      const audio = this.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
      });

      audio.on('data', opusPacket => {
        try {
          const pcm = encoder.decode(opusPacket, FRAME_SIZE);
          this._write(audio, pcm);
        } catch (_) {}
      });

      audio.on('end',   ()  => this._subs.delete(userId));
      audio.on('close', ()  => this._subs.delete(userId));
      audio.on('error', err => {
        console.error(`[AUDIO ${userId}]`, err.message);
        this._subs.delete(userId);
      });
    });
  }

  async stop() {
    clearInterval(this._timer);
    if (this._ws && !this._ws.destroyed) {
      const last = this._pcmPath;
      await new Promise(r => this._ws.end(r));
      this._ws = null;
      processPcm(last);
    }
    try { this.connection.destroy(); } catch (_) {}
    console.log(`[SESSION] Stopped — guild ${this.guildId}`);
  }
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────

// patchVoice: true → patches @discordjs/voice internals to accept user tokens
const client = new Client({ checkUpdate: false, patchVoice: true });

client.on('ready', () => console.log(`[READY] ${client.user.tag}`));

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.id !== client.user.id) return;

  const guildId = newState.guild?.id;
  if (!guildId) return;

  // Left voice
  if (!newState.channelId && oldState.channelId) {
    if (sessions.has(guildId)) {
      const s = sessions.get(guildId);
      sessions.delete(guildId);
      await s.stop();
    }
    return;
  }

  // Joined / switched channel
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    if (sessions.has(guildId)) {
      const s = sessions.get(guildId);
      sessions.delete(guildId);
      await s.stop();
    }

    const channel = newState.channel;
    if (!channel) return;

    console.log(`[JOIN] #${channel.name} (${channel.id})`);

    try {
      const connection = joinVoiceChannel({
        channelId:      channel.id,
        guildId,
        adapterCreator: newState.guild.voiceAdapterCreator,
        selfDeaf:       false,
        selfMute:       true,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log(`[CONNECTED] Ready`);

      const session = new RecordingSession(connection, guildId);
      sessions.set(guildId, session);

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          console.log(`[RECONNECT] Reconnected`);
        } catch {
          if (sessions.has(guildId)) {
            const s = sessions.get(guildId);
            sessions.delete(guildId);
            await s.stop();
          }
        }
      });

    } catch (err) {
      console.error(`[JOIN ERROR] ${err.message}`);
    }
  }
});

// ─── SHUTDOWN ─────────────────────────────────────────────────────────────────

async function shutdown(sig) {
  console.log(`\n[${sig}] Shutting down...`);
  for (const [id, session] of sessions) {
    sessions.delete(id);
    await session.stop();
  }
  await new Promise(r => setTimeout(r, 4000));
  client.destroy();
  process.exit(0);
}

process.on('SIGINT',             () => shutdown('SIGINT'));
process.on('SIGTERM',            () => shutdown('SIGTERM'));
process.on('uncaughtException',  e  => console.error('[UNCAUGHT]', e.message));
process.on('unhandledRejection', e  => console.error('[UNHANDLED]', e));

client.login(TOKEN);
