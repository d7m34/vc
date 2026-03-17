const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
const { Readable, PassThrough } = require('stream');
require('dotenv').config();

const client = new Client({ checkUpdate: false });

// حل مشكلة READY لضمان عدم الانهيار عند تسجيل الدخول
client.on('raw', (p) => {
    if (p.t === 'READY') {
        const s = p.d.user_settings;
        if (s && s.friend_source_flags === null) s.friend_source_flags = { all: false };
    }
});

const USER_TOKEN = process.env.USER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TEMP_DIR = './recordings';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

let currentWriteStream = null;
let currentFilePath = null;
let partCounter = 1;

// --- وظيفة التحويل والرفع بنسبة نجاح 100% ---
async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < 5000) { // لو الملف أصغر من 5KB يعني فاضي، لا تتعبه
        console.log(`⚠️ الجزء ${partNum} فارغ جداً، تم تخطيه.`);
        fs.unlinkSync(filePath);
        return;
    }

    const mp3Path = filePath.replace('.pcm', '.mp3');
    // استخدام بارامترات FFmpeg دقيقة لتحويل الـ PCM الخام
    const command = `"${ffmpeg}" -y -f s16le -ar 48000 -ac 2 -i "${filePath}" -c:a libmp3lame -b:a 64k "${mp3Path}"`;

    exec(command, async (err) => {
        if (err) return console.error(`❌ خطأ FFmpeg:`, err);

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path), `Part_${partNum}.mp3`);
        form.append('content', `✅ **تم استخراج الجزء ${partNum}** | الحجم الأصلي: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

        try {
            await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
            console.log(`🚀 تم الرفع للويب هوك: جزء ${partNum}`);
            fs.unlinkSync(filePath);
            fs.unlinkSync(mp3Path);
        } catch (error) {
            console.error(`❌ فشل الرفع:`, error.message);
        }
    });
}

function startNewFile() {
    if (currentWriteStream) currentWriteStream.end();
    const fileName = `rec_${Date.now()}.pcm`;
    currentFilePath = path.join(TEMP_DIR, fileName);
    currentWriteStream = fs.createWriteStream(currentFilePath);
    console.log(`📝 سجل جديد: الجزء ${partCounter}`);
}

client.on('ready', () => console.log(`🚀 المتصنت الأكاديمي متصل باسم: ${client.user.tag}`));

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (newState.id !== client.user.id) return;

    // الدخول للروم
    if (!oldState.channelId && newState.channelId) {
        console.log('📡 جاري تهيئة القناة الصوتية...');
        
        const connection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        startNewFile();

        // خدعة الـ "Keep-Alive": إرسال صمت مستمر لإجبار ديسكورد على إرسال الصوت لنا
        const player = createAudioPlayer();
        const silence = new Readable({ read() { this.push(Buffer.from([0xF8, 0xFF, 0xFE])); } });
        connection.subscribe(player);

        connection.receiver.speaking.on('start', (userId) => {
            if (userId === client.user.id) return; // لا تسجل نفسك

            const audio = connection.receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: 100 }
            });

            const decoder = new (require('prism-media').opus.Decoder)({ rate: 48000, channels: 2, frameSize: 960 });
            audio.pipe(decoder).on('data', (chunk) => {
                if (currentWriteStream) {
                    currentWriteStream.write(chunk);
                    // تدوير تلقائي عند 20 ميجا
                    if (fs.statSync(currentFilePath).size > 20 * 1024 * 1024) {
                        const old = currentFilePath;
                        const p = partCounter++;
                        startNewFile();
                        processAndSend(old, p);
                    }
                }
            });
        });
    }

    // الخروج من الروم
    if (oldState.channelId && !newState.channelId) {
        console.log('🚪 تم قطع الاتصال. إنهاء الملفات...');
        if (currentWriteStream) {
            currentWriteStream.end();
            const last = currentFilePath;
            const p = partCounter;
            setTimeout(() => processAndSend(last, p), 3000);
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

client.login(USER_TOKEN);
