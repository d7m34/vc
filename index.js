/**
 * Discord Voice Recorder
 * - discord.js-selfbot-v13 + @discordjs/voice
 * - Reads TOKEN and WEBHOOK_URL from environment variables
 * - Records all speakers, mixes into one PCM file per session
 * - Rotates at 20MB, converts to MP3 48kbps, sends to webhook, deletes files
 * - Stream-based, low RAM usage
 */

'use strict';

const { Client }               = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
}                              = require('@discordjs/voice');
const { OpusEncoder }          = require('@discordjs/opus');
const fs                       = require('fs');
const path                     = require('path');
const { spawn }                = require('child_process');
const ffmpegPath               = require('ffmpeg-static');
const axios                    = require('axios');
const FormData                 = require('form-data');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN       = process.env.TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TEMP_DIR    = path.join(__dirname, 'temp');
const MAX_BYTES   = 20 * 1024 * 1024; // 20 MB
const SIZE_CHECK  = 2000;             // check every 2 seconds
const SAMPLE_RATE = 48000;
const CHANNELS    = 2;
const FRAME_SIZE  = 960;              // Discord standard Opus frame
// ──────────────────────────────────────────────────────────────────────────────

if (!TOKEN || !WEBHOOK_URL) {
  console.error('[ERROR] TOKEN and WEBHOOK_URL must be set as environment variables.');
  process.exit(1);
}

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Shared Opus decoder (stateless per-packet decode)
const opusEncoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);

// Active sessions: guildId → RecordingSession
const sessions = new Map();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function safeDelete(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Convert a PCM file to MP3 using ffmpeg.
 * Returns a promise that resolves to the MP3 path.
 */
function convertToMp3(pcmPath) {
  return new Promise((resolve, reject) => {
    const mp3Path = pcmPath.replace(/\.pcm$/, '.mp3');
    const ff = spawn(ffmpegPath, [
      '-y',
      '-f',        's16le',
      '-ar',       String(SAMPLE_RATE),
      '-ac',       String(CHANNELS),
      '-i',        pcmPath,
      '-codec:a',  'libmp3lame',
      '-b:a',      '48k',
      mp3Path,
    ]);
    // Collect stderr only on error
    const errBuf = [];
    ff.stderr.on('data', d => errBuf.push(d));
    ff.on('close', code => {
      if (code === 0) resolve(mp3Path);
      else reject(new Error(`ffmpeg code ${code}: ${Buffer.concat(errBuf).toString().slice(-200)}`));
    });
    ff.on('error', reject);
  });
}

/**
 * Send an MP3 file to the Discord webhook.
 * Discord webhook max file size is 25MB — our chunks are max ~4MB MP3 from 20MB PCM.
 */
async function sendToWebhook(mp3Path) {
  const fileName = path.basename(mp3Path);
  const form = new FormData();
  form.append('content', `🎙️ \`${fileName}\``);
  form.append('file', fs.createReadStream(mp3Path), { filename: fileName });

  await axios.post(WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120_000,
  });
  console.log(`[WEBHOOK] ✓ Sent ${fileName}`);
}

/**
 * Full pipeline for a finished PCM chunk:
 * convert → send → delete both files.
 * Runs independently (fire-and-forget) to not block recording.
 */
async function processPcm(pcmPath) {
  console.log(`[PIPELINE] Starting: ${path.basename(pcmPath)}`);
  let mp3Path = null;
  try {
    // Verify PCM file has actual content
    const stat = fs.statSync(pcmPath);
    if (stat.size < 1024) {
      console.log(`[PIPELINE] Skipping tiny file: ${path.basename(pcmPath)}`);
      safeDelete(pcmPath);
      return;
    }

    mp3Path = await convertToMp3(pcmPath);
    console.log(`[PIPELINE] Converted to MP3: ${path.basename(mp3Path)}`);

    await sendToWebhook(mp3Path);
  } catch (err) {
    console.error(`[PIPELINE ERROR] ${path.basename(pcmPath)}: ${err.message}`);
  } finally {
    safeDelete(pcmPath);
    if (mp3Path) safeDelete(mp3Path);
    console.log(`[PIPELINE] Cleaned up: ${path.basename(pcmPath)}`);
  }
}

// ─── RECORDING SESSION ────────────────────────────────────────────────────────

class RecordingSession {
  constructor(connection, channel) {
    this.connection    = connection;
    this.channel       = channel;
    this.guildId       = channel.guild.id;
    this.receiver      = connection.receiver;

    // Current write state
    this._ws           = null;   // WriteStream
    this._pcmPath      = null;
    this._bytes        = 0;
    this._chunkIdx     = 0;
    this._rotating     = false;

    // User audio stream registry
    this._userStreams   = new Map(); // userId → audioStream

    this._openNewFile();
    this._sizeTimer = setInterval(() => this._checkSize(), SIZE_CHECK);
    this._attachReceiver();

    console.log(`[SESSION] Recording started: #${channel.name} (${this.guildId})`);
  }

  // ── File management ────────────────────────────────────────────────────────

  _openNewFile() {
    this._chunkIdx++;
    this._pcmPath = path.join(TEMP_DIR, `rec_${this.guildId}_${nowTag()}_${this._chunkIdx}.pcm`);
    this._ws      = fs.createWriteStream(this._pcmPath);
    this._bytes   = 0;
    // Handle stream errors gracefully
    this._ws.on('error', err => console.error(`[WRITE ERROR] ${err.message}`));
    console.log(`[FILE] Opened: ${path.basename(this._pcmPath)}`);
  }

  _checkSize() {
    if (!this._rotating && this._bytes >= MAX_BYTES) {
      console.log(`[ROTATE] ${path.basename(this._pcmPath)} @ ${(this._bytes / 1e6).toFixed(1)}MB`);
      this._rotate();
    }
  }

  /**
   * Atomic rotation:
   * 1. Mark rotating flag to prevent re-entry
   * 2. Save reference to old stream/path
   * 3. Open new file immediately (so no PCM is lost)
   * 4. End old stream, then kick off pipeline
   */
  _rotate() {
    this._rotating = true;

    const oldPath = this._pcmPath;
    const oldWs   = this._ws;

    // Immediately redirect new audio to new file
    this._openNewFile();
    this._rotating = false;

    // Close old stream, then process
    oldWs.end(() => processPcm(oldPath));
  }

  // ── Audio writing ─────────────────────────────────────────────────────────

  /**
   * Write decoded PCM to the current file.
   * Applies backpressure to protect RAM.
   */
  _writePcm(audioStream, pcmChunk) {
    if (!this._ws || this._ws.closed || this._ws.destroyed) return;

    const canContinue = this._ws.write(pcmChunk);
    this._bytes += pcmChunk.length;

    if (!canContinue) {
      audioStream.pause();
      this._ws.once('drain', () => {
        if (!audioStream.destroyed) audioStream.resume();
      });
    }
  }

  // ── User subscription ─────────────────────────────────────────────────────

  _attachReceiver() {
    this.receiver.speaking.on('start', userId => {
      if (this._userStreams.has(userId)) return;
      this._subscribeUser(userId);
    });
  }

  _subscribeUser(userId) {
    const audioStream = this.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 300,
      },
    });

    this._userStreams.set(userId, audioStream);

    audioStream.on('data', (opusPacket) => {
      try {
        // Decode Opus → raw PCM s16le stereo
        const pcm = opusEncoder.decode(opusPacket, FRAME_SIZE);
        this._writePcm(audioStream, pcm);
      } catch (e) {
        // Occasionally malformed packets — skip silently
      }
    });

    audioStream.on('end', () => {
      this._userStreams.delete(userId);
    });

    audioStream.on('error', (err) => {
      console.error(`[USER STREAM ${userId}] ${err.message}`);
      this._userStreams.delete(userId);
    });

    audioStream.on('close', () => {
      this._userStreams.delete(userId);
    });
  }

  // ── Graceful stop ─────────────────────────────────────────────────────────

  async stop() {
    clearInterval(this._sizeTimer);

    // Destroy all user audio streams
    for (const [uid, stream] of this._userStreams) {
      try { stream.destroy(); } catch (_) {}
      this._userStreams.delete(uid);
    }

    // Close and process the last PCM file
    if (this._ws && !this._ws.destroyed) {
      const lastPath = this._pcmPath;
      await new Promise(resolve => this._ws.end(resolve));
      this._ws = null;
      processPcm(lastPath); // fire and forget — will run after stop returns
    }

    // Destroy voice connection
    try { this.connection.destroy(); } catch (_) {}

    console.log(`[SESSION] Stopped: ${this.guildId}`);
  }
}

// ─── DISCORD CLIENT ───────────────────────────────────────────────────────────

const client = new Client({ checkUpdate: false });

client.on('ready', () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  console.log(`[INFO]  Monitoring voice state...`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Only watch our own account
  if (newState.id !== client.user.id) return;

  const guildId = newState.guild?.id;
  if (!guildId) return;

  const joinedNew  = newState.channelId && newState.channelId !== oldState.channelId;
  const leftAll    = !newState.channelId && oldState.channelId;

  // ── LEFT voice channel ───────────────────────────────────────────────────
  if (leftAll) {
    if (sessions.has(guildId)) {
      console.log(`[LEAVE] Left voice in guild ${guildId}`);
      const session = sessions.get(guildId);
      sessions.delete(guildId);
      await session.stop();
    }
    return;
  }

  // ── JOINED / SWITCHED voice channel ─────────────────────────────────────
  if (joinedNew) {
    // Stop previous session in this guild if any
    if (sessions.has(guildId)) {
      const old = sessions.get(guildId);
      sessions.delete(guildId);
      await old.stop();
    }

    const channel = newState.channel;
    if (!channel) return;

    console.log(`[JOIN] ${channel.name} (${channel.id})`);

    try {
      const connection = joinVoiceChannel({
        channelId:      channel.id,
        guildId,
        adapterCreator: newState.guild.voiceAdapterCreator,
        selfDeaf:       false,
        selfMute:       true,  // don't send audio, just receive
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const session = new RecordingSession(connection, channel);
      sessions.set(guildId, session);

      // Handle unexpected disconnects
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          console.log(`[RECONNECT] Reconnected in ${guildId}`);
        } catch {
          console.warn(`[DISCONNECT] Could not reconnect in ${guildId}`);
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

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  for (const [guildId, session] of sessions) {
    sessions.delete(guildId);
    await session.stop();
  }
  // Give pipelines time to finish sending
  await new Promise(r => setTimeout(r, 3000));
  client.destroy();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', err => console.error('[UNCAUGHT]', err.message));
process.on('unhandledRejection', err => console.error('[UNHANDLED]', err));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
