const { Client, ClientUserSettingManager } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

// 1. إصلاح مشكلة الـ Null في المكتبة (Monkey Patch)
const originalPatch = ClientUserSettingManager.prototype._patch;
ClientUserSettingManager.prototype._patch = function(data) {
    if (data && data.friend_source_flags === null) {
        data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
    }
    return originalPatch.call(this, data);
};

const client = new Client({ checkUpdate: false });

// المتغيرات من Railway Environment
const USER_TOKEN = process.env.USER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const MAX_FILE_SIZE_MB = 20; 
const TEMP_DIR = './recordings';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

let currentWriteStream = null;
let currentFilePath = null;
let partCounter = 1;
let isRecording = false;

async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath)) return;
    
    const mp3Path = filePath.replace('.pcm', '.mp3');
    // تحويل بجودة 48k كافية جداً للصوت وتوفر مساحة هائلة
    const command = `${ffmpeg} -f s16le -ar 48000 -ac 2 -i "${filePath}" -ab 48k "${mp3Path}"`;
    
    exec(command, async (error) => {
        if (error) {
            console.error(`Encoding Error Part ${partNum}:`, error);
            return;
        }

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path));
        form.append('content', `📦 **جزء جديد من التسجيل**\nرقم الجزء: ${partNum}\nالوقت: ${new Date().toLocaleString('ar-SA')}`);

        try {
            await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
            console.log(`✅ Part ${partNum} uploaded successfully.`);
            // مسح الملفات فوراً لتوفير مساحة السيرفر
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        } catch (err) {
            console.error(`Webhook Upload Failed:`, err.message);
        }
    });
}

function startNewFile() {
    if (currentWriteStream) currentWriteStream.end();
    const fileName = `part_${partCounter}_${Date.now()}.pcm`;
    currentFilePath = path.join(TEMP_DIR, fileName);
    currentWriteStream = fs.createWriteStream(currentFilePath);
    isRecording = true;
}

client.on('ready', () => {
    console.log(`🚀 السكربت شغال الآن باسم: ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    // التأكد أن الحركة تخص حسابك أنت
    if (newState.id !== client.user.id) return;

    // حالة الدخول للقناة
    if (!oldState.channelId && newState.channelId) {
        console.log('✅ دخلت الروم، جاري بدء التسجيل...');
        const connection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        startNewFile();

        connection.receiver.speaking.on('start', (userId) => {
            const audioStream = connection.receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: 100 }
            });

            const pcmStream = audioStream.pipe(new (require('prism-media').opus.Decoder)({ rate: 48000, channels: 2, frameSize: 960 }));
            
            pcmStream.on('data', (chunk) => {
                if (currentWriteStream && isRecording) {
                    currentWriteStream.write(chunk);
                    
                    // فحص الحجم للتدوير الفوري (Rotation)
                    const stats = fs.statSync(currentFilePath);
                    if (stats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                        console.log(`📏 الحجم وصل 20MB، جاري تدوير الملف...`);
                        const oldPath = currentFilePath;
                        const oldPart = partCounter;
                        partCounter++;
                        startNewFile();
                        processAndSend(oldPath, oldPart);
                    }
                }
            });
        });
    }

    // حالة الخروج من الروم (حتى لو بعد 5 ثوانٍ)
    if (oldState.channelId && !newState.channelId) {
        console.log('🚪 خرجت من الروم، جاري معالجة الجزء الأخير...');
        isRecording = false;
        if (currentWriteStream) {
            currentWriteStream.end();
            const lastPath = currentFilePath;
            const lastPart = partCounter;
            // تأخير بسيط لضمان إغلاق الملف تماماً قبل التحويل
            setTimeout(() => processAndSend(lastPath, lastPart), 1500); 
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

client.login(USER_TOKEN).catch(err => console.error("❌ فشل تسجيل الدخول:", err.message));
