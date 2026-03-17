const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
require('dotenv').config();

const client = new Client({ checkUpdate: false });

// حل مشكلة الـ Null في READY
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
const MAX_FILE_SIZE_MB = 20; 
const TEMP_DIR = './recordings';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

let currentWriteStream = null;
let currentFilePath = null;
let partCounter = 1;

// --- دالة لإرسال صمت وهمي (لفتح قناة الصوت) ---
function playSilence(connection) {
    const player = createAudioPlayer();
    // إنشاء ستريم صامت تماماً
    const silenceStream = new Readable({ read() { this.push(Buffer.from([0xF8, 0xFF, 0xFE])); this.push(null); } });
    const resource = createAudioResource(silenceStream);
    player.play(resource);
    connection.subscribe(player);
}

async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) return; // تجاهل الملفات شبه الفارغة
    
    const mp3Path = filePath.replace('.pcm', '.mp3');
    const command = `"${ffmpeg}" -f s16le -ar 48000 -ac 2 -i "${filePath}" -ab 64k "${mp3Path}"`;
    
    exec(command, async (error) => {
        if (error) return console.error(`❌ التحويل فشل:`, error);

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path));
        form.append('content', `📊 **تقرير المحاضرة - الجزء ${partNum}**`);

        try {
            await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
            fs.unlinkSync(filePath);
            fs.unlinkSync(mp3Path);
            console.log(`✅ تم رفع الجزء ${partNum}.`);
        } catch (err) {
            console.error(`❌ خطأ ويب هوك:`, err.message);
        }
    });
}

function startNewFile() {
    if (currentWriteStream) currentWriteStream.end();
    const fileName = `rec_part_${partCounter}_${Date.now()}.pcm`;
    currentFilePath = path.join(TEMP_DIR, fileName);
    currentWriteStream = fs.createWriteStream(currentFilePath);
    console.log(`📁 إنشاء ملف جديد: الجزء ${partCounter}`);
}

client.on('ready', () => console.log(`🚀 المتصنت الأكاديمي جاهز: ${client.user.tag}`));

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user.id) return;

    if (!oldState.channelId && newState.channelId) {
        console.log('🎙️ دخلت الروم، جاري تفعيل سحب البيانات...');
        
        const connection = joinVoiceChannel({
            channelId: newState.channelId,
            guildId: newState.guild.id,
            adapterCreator: newState.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false, // يجب أن يكون false لفتح القناة
        });

        // تشغيل الصمت فوراً لفتح استقبال الصوت
        playSilence(connection);
        startNewFile();

        connection.receiver.speaking.on('start', (userId) => {
            // تجاهل صوتك أنت لعدم حدوث Loop
            if (userId === client.user.id) return;

            const audioStream = connection.receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: 150 }
            });

            const pcmStream = audioStream.pipe(new (require('prism-media').opus.Decoder)({ rate: 48000, channels: 2, frameSize: 960 }));
            
            pcmStream.on('data', (chunk) => {
                if (currentWriteStream) {
                    currentWriteStream.write(chunk);
                    if (fs.statSync(currentFilePath).size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                        const oldPath = currentFilePath;
                        const oldPart = partCounter++;
                        startNewFile();
                        processAndSend(oldPath, oldPart);
                    }
                }
            });
        });
    }

    if (oldState.channelId && !newState.channelId) {
        console.log('🚪 تم قطع الاتصال، معالجة البيانات النهائية...');
        if (currentWriteStream) {
            currentWriteStream.end();
            const lastPath = currentFilePath;
            const lastPart = partCounter;
            setTimeout(() => processAndSend(lastPath, lastPart), 2500);
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

client.login(USER_TOKEN);
