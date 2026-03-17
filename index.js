const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

// إعداد العميل مع تعطيل التحقق من التحديثات
const client = new Client({ 
    checkUpdate: false,
    patchVoice: true // تفعيل إصلاحات الصوت للحسابات الشخصية
});

const USER_TOKEN = process.env.USER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const MAX_FILE_SIZE_MB = 20; 
const TEMP_DIR = './recordings';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

let currentWriteStream = null;
let currentFilePath = null;
let partCounter = 1;
let isRecording = false;

// --- وظيفة المعالجة والإرسال ---
async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath)) return;
    
    const mp3Path = filePath.replace('.pcm', '.mp3');
    // جودة 48k توفر مساحة هائلة وتحافظ على وضوح الصوت الأكاديمي
    const command = `"${ffmpeg}" -f s16le -ar 48000 -ac 2 -i "${filePath}" -ab 48k "${mp3Path}"`;
    
    exec(command, async (error) => {
        if (error) {
            console.error(`❌ خطأ في تحويل الجزء ${partNum}:`, error);
            return;
        }

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path));
        form.append('content', `📦 **تقرير تسجيل جديد**\nرقم الجزء: ${partNum}\nالتوقيت: ${new Date().toLocaleString('ar-SA')}`);

        try {
            await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
            console.log(`✅ تم رفع الجزء ${partNum} بنجاح.`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        } catch (err) {
            console.error(`❌ فشل رفع Webhook:`, err.message);
        }
    });
}

function startNewFile() {
    if (currentWriteStream) currentWriteStream.end();
    const fileName = `part_${partCounter}_${Date.now()}.pcm`;
    currentFilePath = path.join(TEMP_DIR, fileName);
    currentWriteStream = fs.createWriteStream(currentFilePath);
    isRecording = true;
    console.log(`📁 بدأ تسجيل ملف جديد: الجزء ${partCounter}`);
}

// --- التعامل مع الأحداث ---

client.on('ready', () => {
    console.log(`🚀 السكربت متصل الآن باسم: ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user.id) return;

    // الدخول لقناة صوتية
    if (!oldState.channelId && newState.channelId) {
        console.log('🎙️ تم رصد دخولك للقناة. جاري بدء التسجيل...');
        
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
                    
                    // تدوير الملف إذا تجاوز 20 ميجا
                    const stats = fs.statSync(currentFilePath);
                    if (stats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
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

    // الخروج من القناة
    if (oldState.channelId && !newState.channelId) {
        console.log('🚪 تم الخروج. جاري إرسال الجزء الأخير...');
        isRecording = false;
        if (currentWriteStream) {
            currentWriteStream.end();
            const lastPath = currentFilePath;
            const lastPart = partCounter;
            setTimeout(() => processAndSend(lastPath, lastPart), 2000); 
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

// تشغيل السكربت مع معالجة خطأ الدخول الشهير
client.login(USER_TOKEN).catch(err => {
    console.error("❌ فشل تسجيل الدخول. تأكد من صحة التوكن في Railway Variables.");
});
