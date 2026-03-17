const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const sodium = require('libsodium-wrappers');
require('dotenv').config();

// مولد إشارة الاتصال (لإبقاء القناة مفتوحة)
class SilenceGenerator extends Readable {
    _read() {
        setTimeout(() => {
            this.push(Buffer.from([0xF8, 0xFF, 0xFE]));
        }, 20);
    }
}

const client = new Client({ checkUpdate: false });

client.on('raw', (packet) => {
    if (packet.t === 'READY') {
        const settings = packet.d.user_settings;
        if (settings && settings.friend_source_flags === null) {
            settings.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
        }
    }
});

const USER_TOKEN = process.env.USER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TEMP_DIR = './recordings';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

let currentWriteStream = null;
let currentFilePath = null;
let partCounter = 1;

// المعالجة بدون أي قيود على الحجم!
async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath)) return;
    
    const stats = fs.statSync(filePath);
    
    // إذا كان الملف 0 بايت تماماً (مستحيل تحويله)
    if (stats.size === 0) {
        console.log(`⚠️ الجزء ${partNum} فارغ تماماً (0 بايت)، لا يوجد صوت لتحويله.`);
        fs.unlinkSync(filePath);
        return;
    }

    console.log(`⏳ جاري تحويل الجزء ${partNum} (الحجم: ${stats.size} بايت)...`);
    
    const mp3Path = filePath.replace('.pcm', '.mp3');
    // أوامر تحويل مرنة تقبل حتى الملفات الصغيرة جداً
    const command = `"${ffmpeg}" -y -f s16le -ar 48000 -ac 2 -i "${filePath}" -c:a libmp3lame -b:a 64k "${mp3Path}"`;

    exec(command, async (error) => {
        if (error) {
            console.error(`❌ فشل التحويل (قد يكون الملف صغيراً جداً على FFmpeg):`, error.message);
            return;
        }

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path), `Audio_Record_Part_${partNum}.mp3`);
        form.append('content', `✅ **تسجيل جديد** | الجزء: ${partNum} | الحجم الخام: ${stats.size} بايت`);

        try {
            await axios.post(WEBHOOK_URL, form, { 
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            console.log(`🚀 تم رفع الجزء ${partNum} للويب هوك بنجاح!`);
        } catch (uploadError) {
            console.error(`❌ فشل الرفع للويب هوك:`, uploadError.message);
        } finally {
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
            try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch (e) {}
        }
    });
}

function startNewFile() {
    if (currentWriteStream) currentWriteStream.end();
    const fileName = `rec_${Date.now()}_part${partCounter}.pcm`;
    currentFilePath = path.join(TEMP_DIR, fileName);
    // استخدام وضع الإلحاق (a) لمنع تلف البيانات إذا تحدث أكثر من شخص
    currentWriteStream = fs.createWriteStream(currentFilePath, { flags: 'a' });
    console.log(`📁 بدأ تسجيل ملف جديد: الجزء ${partCounter}`);
}

client.on('ready', async () => {
    await sodium.ready;
    console.log(`✅ النظام البرمجي متصل بدون قيود. الحساب: ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user.id) return;

    if (!oldState.channelId && newState.channelId) {
        console.log(`🎙️ تم رصد دخول للقناة الصوتية. جاري تأسيس الاتصال الآمن...`);
        
        const connection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        const player = createAudioPlayer();
        const silenceStream = new SilenceGenerator();
        const resource = createAudioResource(silenceStream, { inputType: StreamType.Opus });
        player.play(resource);
        connection.subscribe(player);

        startNewFile();

        connection.receiver.speaking.on('start', (userId) => {
            if (userId === client.user.id) return;

            console.log(`🗣️ تم رصد صوت من المستخدم: ${userId} - جاري الكتابة في الملف...`);

            // حذفنا EndBehaviorType.AfterSilence لنسمح بتسجيل مستمر دون تقطيع
            const audioStream = connection.receiver.subscribe(userId);
            const decoder = new (require('prism-media').opus.Decoder)({ rate: 48000, channels: 2, frameSize: 960 });
            
            audioStream.pipe(decoder).on('data', (chunk) => {
                if (currentWriteStream) {
                    currentWriteStream.write(chunk);
                    
                    if (fs.existsSync(currentFilePath)) {
                        const stats = fs.statSync(currentFilePath);
                        // التدوير عند 15 ميجابايت فقط
                        if (stats.size > 15 * 1024 * 1024) {
                            const pathToProcess = currentFilePath;
                            const partToProcess = partCounter++;
                            startNewFile();
                            processAndSend(pathToProcess, partToProcess);
                        }
                    }
                }
            });
        });
    }

    if (oldState.channelId && !newState.channelId) {
        console.log('🚪 تم رصد خروج. جاري تصدير الملف فوراً...');
        if (currentWriteStream) {
            currentWriteStream.end();
            const pathToProcess = currentFilePath;
            const partToProcess = partCounter;
            
            setTimeout(() => {
                processAndSend(pathToProcess, partToProcess);
            }, 1000);
            
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

process.on('unhandledRejection', error => console.error('⚠️ Unhandled promise rejection:', error));
process.on('uncaughtException', error => console.error('⚠️ Uncaught exception:', error));

client.login(USER_TOKEN).catch(err => console.error("❌ فشل تسجيل الدخول:", err.message));
