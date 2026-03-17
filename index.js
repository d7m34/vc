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

// القراءة من الـ Environment Variables في Railway
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
    const command = `${ffmpeg} -f s16le -ar 48000 -ac 2 -i "${filePath}" -ab 48k "${mp3Path}"`;
    
    exec(command, async (error) => {
        if (error) {
            console.error(`Encoding Error:`, error);
            return;
        }

        const form = new FormData();
        form.append('file', fs.createReadStream(mp3Path));
        form.append('content', `🎙️ **تقرير التسجيل**\nالجزء: ${partNum}\nالوقت: ${new Date().toLocaleString('ar-SA')}`);

        try {
            await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
            console.log(`✅ Part ${partNum} uploaded.`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        } catch (err) {
            console.error(`Webhook Error:`, err.message);
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

client.on('ready', () => console.log(`🚀 Recorder Active as: ${client.user.tag}`));

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user.id) return;

    // عند دخولك القناة
    if (!oldState.channelId && newState.channelId) {
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
                        const oldPart = partCounter;
                        partCounter++;
                        startNewFile();
                        processAndSend(oldPath, oldPart);
                    }
                }
            });
        });
    }

    // عند خروجك (حتى لو بعد 5 ثوانٍ)
    if (oldState.channelId && !newState.channelId) {
        isRecording = false;
        if (currentWriteStream) {
            currentWriteStream.end();
            const lastPath = currentFilePath;
            const lastPart = partCounter;
            // تأخير بسيط لضمان إغلاق الملف قبل المعالجة
            setTimeout(() => processAndSend(lastPath, lastPart), 1000);
            currentWriteStream = null;
            partCounter = 1;
        }
    }
});

client.login(USER_TOKEN);
