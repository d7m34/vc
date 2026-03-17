const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const client = new Client({ checkUpdate: false });

// --- حل مشكلة الـ TypeError (طريقة حقن البيانات) ---
client.on('raw', (packet) => {
    // إذا كانت الحزمة هي بيانات الجاهزية، نقوم بتنظيفها قبل معالجتها
    if (packet.t === 'READY') {
        const userSettings = packet.d.user_settings;
        if (userSettings && userSettings.friend_source_flags === null) {
            userSettings.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
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
let isRecording = false;

async function processAndSend(filePath, partNum) {
    if (!fs.existsSync(filePath)) return;
    
    const mp3Path = filePath.replace('.pcm', '.mp3');
    const command = `"${ffmpeg}" -f s16le -ar 48000 -ac 2 -i "${filePath}" -ab 48k "${mp3Path}"`;
    
    exec(command, async (error) => {
        if (error) return console.error(`❌ Error Part ${partNum}:`, error);

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path));
        form.append('content', `✅ **تم تسجيل الجزء رقم ${partNum}**`);

        try {
            await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
            fs.unlinkSync(filePath);
            fs.unlinkSync(mp3Path);
            console.log(`✅ Part ${partNum} uploaded and cleaned.`);
        } catch (err) {
            console.error(`❌ Webhook error:`, err.message);
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
    console.log(`🚀 السكربت متصل الآن: ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user.id) return;

    if (!oldState.channelId && newState.channelId) {
        console.log('🎙️ بدأ التسجيل...');
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
        console.log('🚪 تم الخروج وإرسال الجزء الأخير.');
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

client.login(USER_TOKEN).catch(e => console.error("Login Failed:", e.message));
