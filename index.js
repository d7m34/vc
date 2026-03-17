/**
 * Discord Voice Recorder v7
 * Uses @kirdock/discordjs-voice-recorder — designed specifically for selfbots
 * TOKEN and WEBHOOK_URL from environment variables
 */

'use strict';

const { Client }       = require('discord.js-selfbot-v13');
const { VoiceRecorder } = require('@kirdock/discordjs-voice-recorder');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
}                      = require('@discordjs/voice');
const fs               = require('fs');
const path             = require('path');
const { spawn }        = require('child_process');
const ffmpegPath       = require('ffmpeg-static');
const axios            = require('axios');
const FormData         = require('form-data');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN        = process.env.TOKEN;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const TEMP_DIR     = path.join(__dirname, 'temp');
const ROTATE_MIN   = 10; // rotate every 10 minutes (before 20MB limit)
// ──────────────────────────────────────────────────────────────────────────────

if (!TOKEN || !WEBHOOK_URL) {
  console.error('[ERROR] TOKEN and WEBHOOK_URL must be set as environment variables.');
  process.exit(1);
}

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const sessions = new Map(); // guildId → { connection, rotateTimer }

// ─── UTILS ────────────────────────────────────────────────────────────────────

function safeDelete(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sendToWebhook(filePath) {
  const form = new FormData();
  form.append('content', `🎙️ \`${path.basename(filePath)}\``);
  form.append('file', fs.createReadStream(filePath), { filename: path.basename(filePath) });
  await axios.post(WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120_000,
  });
  console.log(`[WEBHOOK] ✓ ${path.basename(filePath)}`);
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────

// patchVoice: true is required for selfbot to work with @discordjs/voice
const client = new Client({ checkUpdate: false, patchVoice: true });
const recorder = new VoiceRecorder({}, client);

client.on('ready', () => console.log(`[READY] ${client.user.tag}`));

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.id !== client.user.id) return;

  const guildId = newState.guild?.id;
  if (!guildId) return;

  // ── LEFT voice ──────────────────────────────────────────────────────────────
  if (!newState.channelId && oldState.channelId) {
    await stopSession(guildId);
    return;
  }

  // ── JOINED / SWITCHED ───────────────────────────────────────────────────────
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    await stopSession(guildId); // stop previous if any

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

      console.log(`[CONNECTION] Created — state: ${connection.state.status}`);

      // Start recording immediately
      recorder.startRecording(connection);
      console.log(`[RECORDING] Started in #${channel.name}`);

      // Rotate every ROTATE_MIN minutes: save → send → new recording
      const rotateTimer = setInterval(async () => {
        await rotateRecording(connection, guildId, channel.id);
      }, ROTATE_MIN * 60 * 1000);

      sessions.set(guildId, { connection, rotateTimer, channelId: channel.id });

      // Handle disconnect
      connection.on('stateChange', async (oldS, newS) => {
        console.log(`[VOICE STATE] ${oldS.status} → ${newS.status}`);
        if (newS.status === VoiceConnectionStatus.Destroyed) {
          await stopSession(guildId);
        }
      });

    } catch (err) {
      console.error(`[JOIN ERROR] ${err.message}`);
    }
  }
});

// ─── ROTATE ───────────────────────────────────────────────────────────────────

async function rotateRecording(connection, guildId, channelId) {
  try {
    const mp3Path = path.join(TEMP_DIR, `rec_${guildId}_${nowTag()}.mp3`);
    const ws = fs.createWriteStream(mp3Path);

    console.log(`[ROTATE] Saving recording to ${path.basename(mp3Path)}`);

    await recorder.getRecordedVoice(ws, channelId, 'single', 1);

    console.log(`[ROTATE] Saved. Sending to webhook...`);
    await sendToWebhook(mp3Path);
    safeDelete(mp3Path);

    // Restart recording fresh
    recorder.startRecording(connection);
    console.log(`[ROTATE] New recording started`);
  } catch (err) {
    console.error(`[ROTATE ERROR] ${err.message}`);
  }
}

// ─── STOP SESSION ─────────────────────────────────────────────────────────────

async function stopSession(guildId) {
  if (!sessions.has(guildId)) return;

  const { connection, rotateTimer, channelId } = sessions.get(guildId);
  sessions.delete(guildId);

  clearInterval(rotateTimer);

  // Save last chunk before stopping
  try {
    const mp3Path = path.join(TEMP_DIR, `rec_${guildId}_${nowTag()}_final.mp3`);
    const ws = fs.createWriteStream(mp3Path);
    await recorder.getRecordedVoice(ws, channelId, 'single', 1);
    await sendToWebhook(mp3Path);
    safeDelete(mp3Path);
  } catch (err) {
    console.error(`[STOP ERROR] ${err.message}`);
  }

  try { connection.destroy(); } catch (_) {}
  console.log(`[SESSION] Stopped — guild ${guildId}`);
}

// ─── SHUTDOWN ─────────────────────────────────────────────────────────────────

async function shutdown(sig) {
  console.log(`\n[${sig}] Shutting down...`);
  for (const [id] of sessions) {
    await stopSession(id);
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
