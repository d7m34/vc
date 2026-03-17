const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
const sodium = require('libsodium-wrappers');
require('dotenv').config();

// 1. مولد صمت آمن: يرسل إطار صامت كل 20 ملي ثانية لخداع ديسكورد وفتح استقبال الصوت
class SilenceGenerator extends Readable {
    _read() {
        setTimeout(() => {
            this.push(Buffer.from([0xF8, 0xFF, 0xFE])); // إطار Opus صامت
        }, 20);
    }
}

const client = new Client({ checkUpdate: false });

// 2. ترقيع نهائي لمشكلة إعدادات الأصدقاء (تمنع الانهيار عند تسجيل الدخول)
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

// 3. نظام المعالجة والرفع الموثوق
async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath)) return;
    
    const stats = fs.statSync(filePath);
    // إذا كان الملف صغيراً جداً (أقل من 50KB)، نتجاهله لتجنب إرسال ملفات صامتة
    if (stats.size < 50000) {
        console.log(`⚠️ الجزء ${partNum} لا يحتوي على بيانات كافية (صمت)، تم تخطيه.`);
        try { fs.unlinkSync(filePath); } catch (e) {}
        return;
    }

    const mp3Path = filePath.replace('.pcm', '.mp3');
    // استخدام LAME Encoder لضمان عمل الـ MP3 على جميع الأجهزة
    const command = `"${ffmpeg}" -y -f s16le -ar 48000 -ac 2 -i "${filePath}" -c:a libmp3lame -b:a 64k "${mp3Path}"`;

    exec(command, async (error) => {
        if (error) {
            console.error(`❌ فشل التحويل للجزء ${partNum}:`, error);
            return;
        }

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path), `Audio_Record_Part_${partNum}.mp3`);
        form.append('content', `✅ **تم التقاط تسجيل جديد**\nالجزء: ${partNum} | الحجم الخام: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

        try {
            await axios.post(WEBHOOK_URL, form, { 
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            console.log(`🚀 تم رفع الجزء ${partNum} بنجاح للويب هوك.`);
        } catch (uploadError) {
            console.error(`❌ فشل إرسال الويب هوك:`, uploadError.message);
        } finally {
            // تنظيف السيرفر فوراً لتجنب استهلاك مساحة Railway
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
            try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch (e) {}
        }
    });
}

function startNewFile() {
    if (currentWriteStream) currentWriteStream.end();
    const fileName = `rec_${Date.now()}_part${partCounter}.pcm`;
    currentFilePath = path.join(TEMP_DIR, fileName);
    currentWriteStream = fs.createWriteStream(currentFilePath);
    console.log(`📁 بدأ تسجيل ملف جديد: الجزء ${partCounter}`);
}

// 4. التشغيل الأساسي
client.on('ready', async () => {
    await sodium.ready; // ضمان جاهزية التشفير قبل أي عملية صوتية
    console.log(`✅ النظام البرمجي متصل ومستقر. الحساب: ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    // التأكد أن التحديث يخص حساب البوت نفسه
    if (newState.id !== client.user.id) return;

    // حالة الدخول للقناة
    if (!oldState.channelId && newState.channelId) {
        console.log(`🎙️ تم رصد دخول للقناة الصوتية. جاري تأسيس الاتصال الآمن...`);
        
        const connection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        // تشغيل الصمت الوهمي لإجبار ديسكورد على إرسال بيانات الآخرين
        const player = createAudioPlayer();
        const silenceStream = new SilenceGenerator();
        const resource = createAudioResource(silenceStream, { inputType: StreamType.Opus });
        player.play(resource);
        connection.subscribe(player);

        startNewFile();

        // التقاط الصوت من المتحدثين
        connection.receiver.speaking.on('start', (userId) => {
            // تجاوز صوت الحساب نفسه لمنع التغذية الراجعة (Feedback Loop)
            if (userId === client.user.id) return;

            const audioStream = connection.receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: 150 }
            });

            const decoder = new (require('prism-media').opus.Decoder)({ rate: 48000, channels: 2, frameSize: 960 });
            
            audioStream.pipe(decoder).on('data', (chunk) => {
                if (currentWriteStream) {
                    currentWriteStream.write(chunk);
                    
                    // التدوير التلقائي إذا تجاوز الملف 15 ميجابايت لضمان سرعة الرفع
                    if (fs.existsSync(currentFilePath)) {
                        const stats = fs.statSync(currentFilePath);
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

    // حالة الخروج من القناة
    if (oldState.channelId && !newState.channelId) {
        console.log('🚪 تم رصد خروج من القناة. جاري إنهاء وتصدير الملف الأخير...');
        if (currentWriteStream) {
            currentWriteStream.end();
            const pathToProcess = currentFilePath;
            const partToProcess = partCounter;
            
            // إعطاء مهلة قصيرة لضمان إغلاق الستريم بالكامل
            setTimeout(() => {
                processAndSend(pathToProcess, partToProcess);
            }, 2000);
            
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

// التعامل مع الأخطاء العامة حتى لا ينهار السكربت أبداً
process.on('unhandledRejection', error => console.error('⚠️ Unhandled promise rejection:', error));
process.on('uncaughtException', error => console.error('⚠️ Uncaught exception:', error));

client.login(USER_TOKEN).catch(err => console.error("❌ فشل تسجيل الدخول:", err.message));
