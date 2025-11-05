// deploy-commands.js
import dotenv from 'dotenv';
dotenv.config();

import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN) throw new Error('❌ Thiếu TOKEN trong .env');
if (!CLIENT_ID) throw new Error('❌ Thiếu CLIENT_ID (Application ID) trong .env');
if (!GUILD_ID) throw new Error('❌ Thiếu GUILD_ID trong .env');

// ================== KHAI BÁO COMMANDS ==================
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('🎵 Phát nhạc từ URL (YouTube, MP3, SoundCloud, Spotify) hoặc từ khóa')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('🔗 URL hoặc từ khóa bài hát')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('⏸️ Tạm dừng phát nhạc hiện tại'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('▶️ Tiếp tục phát nhạc đang tạm dừng'),

  new SlashCommandBuilder()
    .setName('prev')
    .setDescription('⏮️ Quay lại bài hát trước'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('⏭️ Bỏ qua bài hát hiện tại'),

  new SlashCommandBuilder()
    .setName('skipto')
    .setDescription('⏩ Nhảy đến bài hát theo số thứ tự trong hàng đợi')
    .addIntegerOption(option =>
      option
        .setName('index')
        .setDescription('Số thứ tự của bài hát (1, 2, 3, ...)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('⛔ Dừng phát và xóa toàn bộ hàng đợi'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('📜 Xem danh sách hàng đợi hiện tại'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('👋 Rời kênh voice và giải phóng RAM'),
].map(cmd => cmd.toJSON());

// ================== DEPLOY ==================
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  console.log('🚀 Đang deploy slash commands cho guild...');
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Hoàn tất deploy commands!');
  console.log('👉 Bạn có thể thử ngay các lệnh: /play /pause /resume /skip /stop /queue /leave ...');
} catch (err) {
  console.error('❌ Lỗi deploy commands:', err);
  process.exit(1);
}
