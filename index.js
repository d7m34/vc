/**
 * Discord Voice Recorder - Research Use Only
 * Uses discord.js-selfbot-v13 + @discordjs/voice
 * Records voice channels, rotates at 20MB, converts to MP3 via ffmpeg, sends to webhook
 */

const { Client } = require('discord.js-selfbot-v13');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');

// ===================== CONFIG =====================
const USER_TOKEN   = 'YOUR_USER_TOKEN_HERE';
const WEBHOOK_URL  = 'YOUR_WEBHOOK_URL_HERE';
const TEMP_DIR     = path.join(__dirname, 'temp');
const MAX_SIZE_MB  = 20;                        // rotate at 20 MB
const MAX_SIZE_B   = MAX_SIZE_MB * 1024 * 1024;
const CHECK_INTERVAL_MS = 2000;                 // check file size every 2s
// ==================================================

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const client = new Client({ checkUpdate: false });

// Track active recording sessions per guild
// Map<guildId, SessionState>
const sessions = new Map();

// ─────────────────────────────────────────────────
// Utility: safe file delete
// ─────────────────────────────────────────────────
function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error(`[DELETE ERROR] ${filePath}:`, e.message);
  }
}

// ─────────────────────────────────────────────────
// Convert PCM → MP3 using ffmpeg-static (streaming)
// Returns a Promise that resolves with the mp3 path
// ─────────────────────────────────────────────────
function convertToMp3(pcmPath) {
  return new Promise((resolve, reject) => {
    const mp3Path = pcmPath.replace('.pcm', '.mp3');

    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-f', 's16le',         // PCM signed 16-bit little-endian
      '-ar', '48000',        // sample rate Discord uses
      '-ac', '2',            // stereo
      '-i', pcmPath,
      '-codec:a', 'libmp3lame',
      '-b:a', '48k',         // 48 kbps as requested
      mp3Path,
    ]);

    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve(mp3Path);
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    ffmpeg.on('error', reject);
  });
}

// ─────────────────────────────────────────────────
// Send MP3 to Discord Webhook
// ─────────────────────────────────────────────────
async function sendToWebhook(mp3Path) {
  const form = new FormData();
  const fileName = path.basename(mp3Path);
  form.append('file', fs.createReadStream(mp3Path), { filename: fileName });
  form.append('content', `🎙️ Recording: \`${fileName}\``);

  await axios.post(WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  console.log(`[WEBHOOK] Sent: ${fileName}`);
}

// ─────────────────────────────────────────────────
// Process a closed PCM file: convert → send → delete
// ─────────────────────────────────────────────────
async function processPcmFile(pcmPath) {
  try {
    console.log(`[PROCESS] Converting ${path.basename(pcmPath)} ...`);
    const mp3Path = await convertToMp3(pcmPath);
    await sendToWebhook(mp3Path);
    safeDelete(pcmPath);
    safeDelete(mp3Path);
    console.log(`[DONE] Cleaned up ${path.basename(pcmPath)}`);
  } catch (err) {
    console.error(`[PROCESS ERROR] ${pcmPath}:`, err.message);
  }
}

// ─────────────────────────────────────────────────
// Session: manages one recording session per guild
// ─────────────────────────────────────────────────
class RecordingSession {
  constructor(connection, channelId, guildId) {
    this.connection  = connection;
    this.channelId   = channelId;
    this.guildId     = guildId;
    this.receiver   = connection.receiver;

    this.currentPcmPath   = null;
    this.currentWriteStream = null;
    this.bytesWritten     = 0;
    this.chunkIndex       = 0;
    this.sizeCheckTimer   = null;
    this.activeStreams     = new Set(); // track open user audio streams

    this._startNewFile();
    this._startSizeWatcher();
    this._listenForUsers();

    console.log(`[SESSION] Started recording in guild ${guildId}`);
  }

  // Create a new PCM file for writing
  _startNewFile() {
    const ts = Date.now();
    this.chunkIndex++;
    this.currentPcmPath = path.join(
      TEMP_DIR,
      `rec_${this.guildId}_${ts}_${this.chunkIndex}.pcm`
    );
    this.currentWriteStream = fs.createWriteStream(this.currentPcmPath, { flags: 'a' });
    this.bytesWritten = 0;
    console.log(`[FILE] New file: ${path.basename(this.currentPcmPath)}`);
  }

  // Rotate: close current file, process it, open new one
  async _rotate() {
    if (!this.currentWriteStream) return;

    const closedPath = this.currentPcmPath;
    const ws = this.currentWriteStream;

    // Detach immediately so incoming audio goes to the new file
    this._startNewFile();

    ws.end(() => {
      processPcmFile(closedPath); // fire and forget
    });
  }

  // Watch file size every CHECK_INTERVAL_MS
  _startSizeWatcher() {
    this.sizeCheckTimer = setInterval(() => {
      if (this.bytesWritten >= MAX_SIZE_B) {
        console.log(`[ROTATE] ${path.basename(this.currentPcmPath)} reached ${MAX_SIZE_MB}MB`);
        this._rotate();
      }
    }, CHECK_INTERVAL_MS);
  }

  // Subscribe to every speaking user in the channel
  _listenForUsers() {
    // When a user starts speaking, subscribe to their audio
    this.receiver.speaking.on('start', (userId) => {
      if (this.activeStreams.has(userId)) return;
      this._subscribeUser(userId);
    });
  }

  _subscribeUser(userId) {
    this.activeStreams.add(userId);

    const audioStream = this.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 500, // ms of silence before closing stream
      },
    });

    // Write raw opus decoded PCM directly
    audioStream.on('data', (chunk) => {
      if (this.currentWriteStream && !this.currentWriteStream.closed) {
        // Use write() return value to apply backpressure and protect RAM
        const ok = this.currentWriteStream.write(chunk);
        this.bytesWritten += chunk.length;
        if (!ok) {
          // Drain before writing more (stream-based RAM protection)
          audioStream.pause();
          this.currentWriteStream.once('drain', () => audioStream.resume());
        }
      }
    });

    audioStream.on('end', () => {
      this.activeStreams.delete(userId);
    });

    audioStream.on('error', (err) => {
      console.error(`[AUDIO STREAM ERROR] user ${userId}:`, err.message);
      this.activeStreams.delete(userId);
    });
  }

  // Graceful stop
  async stop() {
    clearInterval(this.sizeCheckTimer);

    if (this.currentWriteStream) {
      const closedPath = this.currentPcmPath;
      await new Promise((resolve) => this.currentWriteStream.end(resolve));
      this.currentWriteStream = null;

      // Process last chunk if it has data
      if (fs.existsSync(closedPath) && fs.statSync(closedPath).size > 0) {
        processPcmFile(closedPath);
      } else {
        safeDelete(closedPath);
      }
    }

    try {
      this.connection.destroy();
    } catch (_) {}

    console.log(`[SESSION] Stopped recording in guild ${this.guildId}`);
  }
}

// ─────────────────────────────────────────────────
// Discord client events
// ─────────────────────────────────────────────────
client.on('ready', () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  console.log(`[INFO]  Watching for voice channel joins...`);
});

// Fired when the selfbot's voice state changes
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Only care about OUR own account
  if (newState.id !== client.user.id) return;

  const guildId = newState.guild.id;

  // Joined a voice channel
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    // Already recording in this guild → stop old session first
    if (sessions.has(guildId)) {
      await sessions.get(guildId).stop();
      sessions.delete(guildId);
    }

    const channel = newState.channel;
    if (!channel) return;

    console.log(`[JOIN] Joined voice channel: ${channel.name} (${channel.id})`);

    try {
      // Join with selfbot — adapterCreator handles gateway
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId:   guildId,
        adapterCreator: newState.guild.voiceAdapterCreator,
        selfDeaf:  false,
        selfMute:  true, // mute ourselves so we don't echo
      });

      // Wait until connection is ready
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const session = new RecordingSession(connection, channel.id, guildId);
      sessions.set(guildId, session);

      // Handle unexpected disconnects
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          // Attempt reconnect for 5 seconds
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (sessions.has(guildId)) {
            await sessions.get(guildId).stop();
            sessions.delete(guildId);
          }
        }
      });

    } catch (err) {
      console.error(`[CONNECTION ERROR]:`, err.message);
    }
  }

  // Left the voice channel
  if (!newState.channelId && oldState.channelId) {
    if (sessions.has(guildId)) {
      console.log(`[LEAVE] Left voice channel in guild ${guildId}`);
      await sessions.get(guildId).stop();
      sessions.delete(guildId);
    }
  }
});

// ─────────────────────────────────────────────────
// Graceful shutdown on CTRL+C
// ─────────────────────────────────────────────────
async function shutdown() {
  console.log('\n[SHUTDOWN] Stopping all sessions...');
  for (const [guildId, session] of sessions) {
    await session.stop();
    sessions.delete(guildId);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// Login
client.login(USER_TOKEN);
