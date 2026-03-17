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
const SILENCE_FRAME = Buffer.alloc(3840); // 20ms صمت بصيغة PCM s16le stereo 48kHz

// إنشاء مجلد مؤقت
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── دوال مساعدة ────────────────────────────────────────────────

/**
 * حذف ملف بأمان بدون رمي خطأ
 */
function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[CLEANUP] Deleted: ${path.basename(filePath)}`);
    }
  } catch (err) {
    console.error(`[CLEANUP ERROR] ${err.message}`);
  }
}

/**
 * توليد timestamp آمن لأسماء الملفات
 */
function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

/**
 * تحويل PCM إلى MP3 باستخدام ffmpeg
 * PCM format: signed 16-bit little-endian, 48kHz, stereo
 */
function convertPcmToMp3(pcmPath) {
  return new Promise((resolve, reject) => {
    const mp3Path = pcmPath.replace(/\.pcm$/, '.mp3');

    console.log(`[FFMPEG] Converting: ${path.basename(pcmPath)} → ${path.basename(mp3Path)}`);

    const ff = spawn(ffmpegPath, [
      '-y',                    // overwrite
      '-f', 's16le',          // input format: signed 16-bit little-endian
      '-ar', '48000',         // sample rate: 48kHz
      '-ac', '2',             // channels: stereo
      '-i', pcmPath,          // input file
      '-codec:a', 'libmp3lame',
      '-b:a', '48k',         // bitrate: 48kbps
      '-af', 'silenceremove=start_periods=0:start_duration=0:start_threshold=0',
      mp3Path
    ]);

    const stderrChunks = [];
    ff.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    ff.on('error', (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });

    ff.on('close', (code) => {
      if (code === 0) {
        const mp3Size = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
        console.log(`[FFMPEG] Done: ${path.basename(mp3Path)} (${(mp3Size / 1024).toFixed(1)} KB)`);
        resolve(mp3Path);
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().slice(-500);
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * إرسال ملف MP3 إلى Discord Webhook
 */
async function sendToWebhook(mp3Path) {
  const fileName = path.basename(mp3Path);
  const fileSize = fs.statSync(mp3Path).size;

  console.log(`[WEBHOOK] Sending: ${fileName} (${(fileSize / 1024).toFixed(1)} KB)`);

  const form = new FormData();
  form.append('content', `🎙️ تسجيل صوتي: \`${fileName}\` (${(fileSize / 1024).toFixed(1)} KB)`);
  form.append('file', fs.createReadStream(mp3Path), {
    filename: fileName,
    contentType: 'audio/mpeg'
  });

  await axios.post(WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120_000
  });

  console.log(`[WEBHOOK] Sent successfully: ${fileName}`);
}

/**
 * خط أنابيب كامل: تحويل + إرسال + حذف
 */
async function processPcmFile(pcmPath) {
  let mp3Path = null;

  try {
    // تحقق من حجم الملف
    if (!fs.existsSync(pcmPath)) return;
    const size = fs.statSync(pcmPath).size;

    if (size < 4096) {
      console.log(`[PROCESS] Skipping tiny file: ${path.basename(pcmPath)} (${size} bytes)`);
      safeDelete(pcmPath);
      return;
    }

    console.log(`[PROCESS] Processing: ${path.basename(pcmPath)} (${(size / 1024 / 1024).toFixed(2)} MB)`);

    // تحويل إلى MP3
    mp3Path = await convertPcmToMp3(pcmPath);

    // إرسال للـ webhook
    await sendToWebhook(mp3Path);

  } catch (err) {
    console.error(`[PROCESS ERROR] ${err.message}`);
  } finally {
    // تنظيف الملفات
    safeDelete(pcmPath);
    if (mp3Path) safeDelete(mp3Path);
  }
}

// ─── جلسة التسجيل ───────────────────────────────────────────────

/**
 * RecordingSession
 * تدير تسجيل الصوت من VoiceConnection واحد
 * تكتب PCM خام وتقوم بالـ rotation عند 20MB
 */
class RecordingSession {
  constructor(connection, guildId, channelId) {
    this.connection = connection;
    this.guildId = guildId;
    this.channelId = channelId;
    this.destroyed = false;

    // إدارة الملف الحالي
    this._writeStream = null;
    this._currentPath = null;
    this._bytesWritten = 0;
    this._fileIndex = 0;
    this._isRotating = false;

    // تتبع المستخدمين الذين نستمع لهم
    this._subscribedUsers = new Set();

    // بدء ملف جديد
    this._openNewFile();

    // فحص دوري للحجم
    this._rotateTimer = setInterval(() => {
      if (!this.destroyed && !this._isRotating && this._bytesWritten >= MAX_PCM_BYTES) {
        this._rotateFile();
      }
    }, ROTATE_CHECK_MS);

    // ربط مستقبل الصوت
    this._setupReceiver();

    console.log(`[SESSION] Started recording for guild ${guildId} in channel ${channelId}`);
  }

  /**
   * فتح ملف PCM جديد للكتابة
   */
  _openNewFile() {
    this._fileIndex++;
    const filename = `rec_${this.guildId}_${safeTimestamp()}_${String(this._fileIndex).padStart(3, '0')}.pcm`;
    this._currentPath = path.join(TEMP_DIR, filename);
    this._writeStream = fs.createWriteStream(this._currentPath, {
      highWaterMark: 64 * 1024 // 64KB buffer
    });
    this._bytesWritten = 0;

    this._writeStream.on('error', (err) => {
      console.error(`[FILE ERROR] ${err.message}`);
    });

    console.log(`[SESSION] Opened new file: ${filename}`);
  }

  /**
   * تدوير الملف: إغلاق القديم وفتح جديد بدون فقدان صوت
   */
  _rotateFile() {
    if (this._isRotating || this.destroyed) return;
    this._isRotating = true;

    const oldPath = this._currentPath;
    const oldStream = this._writeStream;

    // فتح ملف جديد فوراً قبل إغلاق القديم
    this._openNewFile();

    // الآن أي كتابة جديدة ستذهب للملف الجديد
    this._isRotating = false;

    // إغلاق القديم ومعالجته
    if (oldStream && !oldStream.destroyed) {
      oldStream.end(() => {
        console.log(`[SESSION] Rotated file: ${path.basename(oldPath)} (${(this._bytesWritten / 1024 / 1024).toFixed(2)} MB written to new file)`);
        // معالجة الملف القديم بشكل غير متزامن
        processPcmFile(oldPath).catch(err => {
          console.error(`[ROTATE PROCESS ERROR] ${err.message}`);
        });
      });
    }
  }

  /**
   * كتابة chunk مع backpressure
   * يعيد true إذا يمكن الاستمرار، false إذا يجب الانتظار
   */
  _writeChunk(chunk) {
    if (this.destroyed || !this._writeStream || this._writeStream.destroyed) {
      return true;
    }

    const ok = this._writeStream.write(chunk);
    this._bytesWritten += chunk.length;
    return ok;
  }

  /**
   * إعداد مستقبل الصوت
   * في discord.js-selfbot-v13:
   *   - connection.receiver هو VoiceReceiver
   *   - receiver.speaking هو مجموعة (Collection) مع event 'start' و 'end'
   *   - receiver.createStream(userId, options) يعيد ReadableStream
   */
  _setupReceiver() {
    const receiver = this.connection.receiver;

    if (!receiver) {
      console.error('[SESSION] No receiver available on connection!');
      return;
    }

    console.log('[SESSION] Setting up voice receiver...');

    // ─── الطريقة 1: الاستماع لحدث speaking ──────────────────────
    // في discord.js-selfbot-v13، الـ receiver يطلق 'speaking' event
    // أو يمكن الاستماع عبر connection.on('speaking')

    // محاولة الطريقة الأولى: receiver.speaking event
    if (receiver.speaking) {
      // speaking هو Map/Collection مع EventEmitter
      const speakingEmitter = receiver.speaking;

      if (typeof speakingEmitter.on === 'function') {
        speakingEmitter.on('start', (userId) => {
          this._subscribeToUser(userId, receiver);
        });

        console.log('[SESSION] Listening via receiver.speaking.on("start")');
      }
    }

    // محاولة الطريقة الثانية: connection.on('speaking')
    this.connection.on('speaking', (user, speaking) => {
      if (!user) return;
      if (speaking) {
        this._subscribeToUser(user.id, receiver);
      }
    });

    console.log('[SESSION] Listening via connection.on("speaking")');

    // محاولة الطريقة الثالثة: الاستماع المباشر من receiver
    // بعض إصدارات المكتبة تدعم receiver.on('data')
    if (typeof receiver.on === 'function') {
      receiver.on('data', (userId, chunk) => {
        if (!this.destroyed) {
          this._writeChunk(chunk);
        }
      });
    }
  }

  /**
   * الاشتراك في صوت مستخدم معين
   */
  _subscribeToUser(userId, receiver) {
    if (this.destroyed) return;
    if (this._subscribedUsers.has(userId)) return;

    try {
      // في discord.js-selfbot-v13:
      // createStream(userId, { mode: 'pcm', end: 'manual' })
      // mode: 'pcm' يعطي PCM مباشرة (s16le, 48kHz, stereo)
      // mode: 'opus' يعطي Opus packets
      // end: 'manual' يعني لا يغلق الـ stream تلقائياً عند السكوت

      let audioStream = null;

      // محاولة createStream (الطريقة الأكثر شيوعاً)
      if (typeof receiver.createStream === 'function') {
        audioStream = receiver.createStream(userId, {
          mode: 'pcm',
          end: 'manual'
        });
      }
      // محاولة subscribe (بعض الإصدارات)
      else if (typeof receiver.subscribe === 'function') {
        audioStream = receiver.subscribe(userId, {
          mode: 'pcm',
          end: 'manual'
        });
      }

      if (!audioStream) {
        console.error(`[SESSION] Cannot create audio stream for user ${userId}`);
        return;
      }

      this._subscribedUsers.add(userId);
      console.log(`[SESSION] Subscribed to user: ${userId} (total: ${this._subscribedUsers.size})`);

      // قراءة البيانات الصوتية
      audioStream.on('data', (chunk) => {
        if (this.destroyed) return;

        const ok = this._writeChunk(chunk);

        // Backpressure: إذا الـ buffer ممتلئ، أوقف القراءة مؤقتاً
        if (!ok && audioStream.pause) {
          audioStream.pause();
          this._writeStream.once('drain', () => {
            if (!this.destroyed && audioStream && !audioStream.destroyed) {
              audioStream.resume();
            }
          });
        }
      });

      audioStream.on('error', (err) => {
        console.error(`[AUDIO ERROR] User ${userId}: ${err.message}`);
        this._subscribedUsers.delete(userId);
      });

      audioStream.on('end', () => {
        console.log(`[SESSION] Audio stream ended for user: ${userId}`);
        this._subscribedUsers.delete(userId);
      });

      audioStream.on('close', () => {
        this._subscribedUsers.delete(userId);
      });

    } catch (err) {
      console.error(`[SUBSCRIBE ERROR] User ${userId}: ${err.message}`);
    }
  }

  /**
   * إيقاف الجلسة بالكامل
   */
  async stop() {
    if (this.destroyed) return;
    this.destroyed = true;

    console.log(`[SESSION] Stopping recording for guild ${this.guildId}`);

    // إيقاف فحص الحجم
    if (this._rotateTimer) {
      clearInterval(this._rotateTimer);
      this._rotateTimer = null;
    }

    // إغلاق ملف الكتابة الحالي
    if (this._writeStream && !this._writeStream.destroyed) {
      const lastPath = this._currentPath;
      await new Promise((resolve) => {
        this._writeStream.end(resolve);
      });
      this._writeStream = null;

      // معالجة الملف الأخير
      if (lastPath) {
        await processPcmFile(lastPath);
      }
    }

    // قطع الاتصال الصوتي
    try {
      if (this.connection) {
        this.connection.disconnect();
      }
    } catch (err) {
      console.error(`[SESSION] Disconnect error: ${err.message}`);
    }

    this._subscribedUsers.clear();
    console.log(`[SESSION] Stopped for guild ${this.guildId}`);
  }
}

// ─── العميل ─────────────────────────────────────────────────────

const client = new Client({
  checkUpdate: false,
  // لا نحتاج intents في selfbot - المكتبة تتعامل معها تلقائياً
});

// تخزين الجلسات النشطة (guildId → RecordingSession)
const activeSessions = new Map();

client.on('ready', () => {
  console.log('═══════════════════════════════════════════');
  console.log(`[READY] Logged in as: ${client.user.tag}`);
  console.log(`[READY] User ID: ${client.user.id}`);
  console.log(`[READY] Guilds: ${client.guilds.cache.size}`);
  console.log(`[READY] Temp dir: ${TEMP_DIR}`);
  console.log(`[READY] Max PCM size: ${MAX_PCM_BYTES / 1024 / 1024} MB`);
  console.log('═══════════════════════════════════════════');
});

/**
 * مراقبة حالة الصوت
 * عندما يدخل حسابنا قناة صوتية (يدوياً من التطبيق)
 * السكربت ينضم تلقائياً ويبدأ التسجيل
 */
client.on('voiceStateUpdate', async (oldState, newState) => {
  // نهتم فقط بحسابنا
  if (newState.id !== client.user.id) return;

  const guildId = newState.guild?.id;
  if (!guildId) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // ─── الحالة 1: خرجنا من القناة الصوتية ────────────────────
  if (!newChannelId && oldChannelId) {
    console.log(`[VOICE] Left channel in guild ${guildId}`);

    if (activeSessions.has(guildId)) {
      const session = activeSessions.get(guildId);
      activeSessions.delete(guildId);
      await session.stop();
    }
    return;
  }

  // ─── الحالة 2: دخلنا قناة صوتية أو انتقلنا لقناة أخرى ──
  if (newChannelId && newChannelId !== oldChannelId) {
    console.log(`[VOICE] Joined/moved to channel ${newChannelId} in guild ${guildId}`);

    // إيقاف الجلسة القديمة إن وجدت
    if (activeSessions.has(guildId)) {
      const oldSession = activeSessions.get(guildId);
      activeSessions.delete(guildId);
      await oldSession.stop();
    }

    const channel = newState.channel;
    if (!channel) {
      console.error('[VOICE] Channel object is null');
      return;
    }

    // ─── الانضمام للقناة الصوتية ─────────────────────────────
    // في discord.js-selfbot-v13، الطريقة الصحيحة هي:
    // channel.join() → Promise<VoiceConnection>
    try {
      console.log(`[VOICE] Attempting to join channel: ${channel.name} (${channel.id})`);

      let connection = null;

      // الطريقة 1: channel.join()
      if (typeof channel.join === 'function') {
        connection = await channel.join();
        console.log('[VOICE] Connected via channel.join()');
      }
      // الطريقة 2: client.voice.joinChannel()
      else if (client.voice && typeof client.voice.joinChannel === 'function') {
        connection = await client.voice.joinChannel(channel);
        console.log('[VOICE] Connected via client.voice.joinChannel()');
      }
      // الطريقة 3: البحث في الاتصالات الموجودة
      // إذا حسابنا دخل يدوياً من التطبيق، قد يكون الاتصال موجود أصلاً
      else {
        // انتظار قليلاً ثم البحث عن الاتصال
        await new Promise(r => setTimeout(r, 2000));

        if (client.voice && client.voice.connections) {
          connection = client.voice.connections.get(guildId);
        }

        if (connection) {
          console.log('[VOICE] Found existing connection');
        }
      }

      if (!connection) {
        console.error('[VOICE] Failed to establish voice connection');
        console.log('[VOICE] Available methods on channel:', Object.getOwnPropertyNames(Object.getPrototypeOf(channel)).filter(m => typeof channel[m] === 'function'));
        return;
      }

      // انتظار حتى يصبح الاتصال جاهزاً
      if (connection.status !== 0) { // 0 = CONNECTED in some versions
        console.log(`[VOICE] Waiting for connection to be ready (status: ${connection.status})...`);
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout after 10s'));
          }, 10000);

          // بعض الإصدارات تستخدم 'ready'، بعضها 'authenticated'
          const onReady = () => {
            clearTimeout(timeout);
            resolve();
          };

          if (connection.status === 0 || connection.status === 'connected') {
            clearTimeout(timeout);
            resolve();
            return;
          }

          connection.once('ready', onReady);
          connection.once('authenticated', onReady);
          connection.once('connected', onReady);

          // في حال كان جاهزاً أصلاً
          connection.once('speaking', () => {
            clearTimeout(timeout);
            resolve();
          });
        }).catch(err => {
          console.warn(`[VOICE] ${err.message}, proceeding anyway...`);
        });
      }

      console.log('[VOICE] Connection established successfully');

      // تعيين الحساب كأصم وصامت (لا يسمعنا أحد)
      try {
        if (typeof connection.setSpeaking === 'function') {
          connection.setSpeaking(0); // لا نتكلم
        }
      } catch (_) {}

      // إنشاء جلسة تسجيل
      const session = new RecordingSession(connection, guildId, newChannelId);
      activeSessions.set(guildId, session);

      // مراقبة قطع الاتصال
      connection.on('disconnect', async () => {
        console.log(`[VOICE] Disconnected from guild ${guildId}`);
        if (activeSessions.has(guildId)) {
          const s = activeSessions.get(guildId);
          activeSessions.delete(guildId);
          await s.stop();
        }
      });

      connection.on('error', (err) => {
        console.error(`[VOICE CONNECTION ERROR] ${err.message}`);
      });

      connection.on('close', async () => {
        console.log(`[VOICE] Connection closed for guild ${guildId}`);
        if (activeSessions.has(guildId)) {
          const s = activeSessions.get(guildId);
          activeSessions.delete(guildId);
          await s.stop();
        }
      });

    } catch (err) {
      console.error(`[VOICE JOIN ERROR] ${err.message}`);
      console.error(err.stack);
    }
  }
});

// ─── معالجة الأخطاء العامة ──────────────────────────────────────

client.on('error', (err) => {
  console.error(`[CLIENT ERROR] ${err.message}`);
});

client.on('warn', (warning) => {
  console.warn(`[CLIENT WARN] ${warning}`);
});

// ─── إيقاف نظيف ────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[SHUTDOWN] Received ${signal}, cleaning up...`);

  // إيقاف جميع الجلسات
  const stopPromises = [];
  for (const [guildId, session] of activeSessions) {
    activeSessions.delete(guildId);
    stopPromises.push(
      session.stop().catch(err => {
        console.error(`[SHUTDOWN] Error stopping session ${guildId}: ${err.message}`);
      })
    );
  }

  await Promise.allSettled(stopPromises);

  // انتظار قليلاً للسماح بإكمال العمليات
  await new Promise(r => setTimeout(r, 3000));

  // إغلاق العميل
  try {
    client.destroy();
  } catch (_) {}

  console.log('[SHUTDOWN] Complete');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
  // لا نوقف البرنامج - نحاول الاستمرار
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ─── مراقبة استهلاك الذاكرة ──────────────────────────────────────

setInterval(() => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const sessions = activeSessions.size;
  console.log(`[MONITOR] RSS: ${rss}MB | Heap: ${heap}MB | Active sessions: ${sessions}`);
}, 60_000); // كل دقيقة

// ─── تسجيل الدخول ──────────────────────────────────────────────

console.log('[STARTUP] Logging in...');
client.login(TOKEN).catch((err) => {
  console.error(`[LOGIN FAILED] ${err.message}`);

  // أخطاء شائعة
  if (err.message.includes('TOKEN_INVALID') || err.message.includes('Incorrect login')) {
    console.error('[LOGIN] The token is invalid. Make sure you copied the full user token.');
    console.error('[LOGIN] User tokens are NOT bot tokens. Do not add "Bot " prefix.');
  }

  process.exit(1);
});
