require('dotenv').config();

/* =========================
   Railway Support: Load cookies từ Environment Variable
   ========================= */
const fs = require('fs');
const path = require('path');

if (process.env.COOKIES_CONTENT) {
  try {
    fs.writeFileSync(path.join(__dirname, 'cookies.txt'), process.env.COOKIES_CONTENT);
    console.log('✅ Cookies file created from COOKIES_CONTENT environment variable');
  } catch (error) {
    console.error('❌ Error writing cookies file:', error.message);
  }
}

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  AuditLogEvent,
  REST,
  Routes
} = require('discord.js');

const {
  handlePlay, handleSkip, handleStop, handleQueue, handleLeave,
  handlePause, handleResume, handleTrending, handleArtist, handleLoop,
  currentController, currentControllerName
} = require('./music.cjs');

// const Canvas = require('canvas');
const axios = require('axios');

/* =========================
   0) ENV & KHỞI TẠO CLIENT
   ========================= */
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID?.trim();
const DJ_ROLE = process.env.DJ_ROLE || 'DJ';
const WEB_API_URL = "https://laogicungton.site/api.php"
const WEB_API_SECRET = process.env.WEB_API_SECRET; // Phải giống trong file PHP
const ALLOWED_ROLES = ["AD-N", "Net"]; // Tên các role được phép

/* =========================
   Kiểm Tra Quyền Người Dùng
   ========================= */

function isMod(member) {
  return (
    member.permissions.has(['Administrator', 'ManageGuild', 'MoveMembers']) ||
    member.roles.cache?.some(r => r.name === DJ_ROLE)
  );
}

async function guardControl(interaction) {
  const ownerId = currentController(interaction.guildId);          // id người đang sở hữu bài hiện tại
  if (!ownerId) return true;                                       // không phát gì -> cho phép
  if (ownerId === interaction.user.id) return true;                // đúng chủ bài -> cho phép
  if (isMod(interaction.member)) return true;                      // admin/DJ -> override

  const name = currentControllerName(interaction.guildId) || 'người yêu cầu hiện tại';
  await interaction.reply({
    flags: 64,
    content: `❌ Chỉ **${name}** (hoặc Admin/DJ) mới dùng được lệnh này khi bài của họ đang phát.`
  });
  return false;
}


if (!TOKEN) {
  console.error('❌ TOKEN không tồn tại. Hãy đặt TOKEN trong file .env');
  process.exit(1);
}
if (!TOKEN.includes('.')) {
  console.error('❌ TOKEN có vẻ không đúng định dạng. Hãy reset token ở tab Bot và dán lại.');
  process.exit(1);
}
if (!LOG_CHANNEL_ID) {
  console.error('❌ LOG_CHANNEL_ID không tồn tại. Đặt ID kênh log trong .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});
/* =========================
   Helpers
   ========================= */
// Gửi embed vào kênh log
async function sendLog(guild, embed) {
  const My_SERVER_ID = '1382264943877029941';
  if (guild.id !== My_SERVER_ID) return; // Chỉ log trong server chính
  try {
    const ch = await guild.channels.fetch(LOG_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) {
      console.warn('⚠️ Không tìm thấy kênh log hoặc kênh không phải text.');
      return;
    }
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('Lỗi gửi log:', err);
  }
}

// Tìm entry audit log gần đây cho targetId & action type
async function fetchRecentAudit(guild, type, targetId, windowMs = 8000) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    const entries = [...logs.entries.values()];
    const now = Date.now();
    for (const e of entries) {
      const tid = e.target?.id ?? e.target;
      if (String(tid) === String(targetId) && now - e.createdTimestamp <= windowMs) {
        return e;
      }
    }
  } catch (err) {
    console.error('fetchRecentAudit lỗi:', err);
  }
  return null;
}

/* =========================
   1) Member join
   ========================= */
client.on('guildMemberAdd', async (member) => {
  const embed = new EmbedBuilder()
    .setTitle('🟢 Thành viên đã vào server')
    .addFields(
      { name: 'User', value: `${member.user.username} (${member.id})`, inline: false },
      { name: 'Mention', value: `<@${member.id}>`, inline: true },
    )
    .setTimestamp()
    .setColor(0x57F287);
  await sendLog(member.guild, embed);
});

/* =========================
   2) Member remove (leave vs kick)
   ========================= */
client.on('guildMemberRemove', async (member) => {
  let kickedBy = null;
  try {
    const entry = await fetchRecentAudit(member.guild, AuditLogEvent.MemberKick, member.id, 8000);
    if (entry) kickedBy = entry.executor;
  } catch (err) {
    console.error(err);
  }

  const embed = new EmbedBuilder()
    .setTimestamp();

  if (kickedBy) {
    embed
      .setTitle('🔴 Thành viên bị kick')
      .addFields(
        { name: 'User', value: `${member.user?.tag ?? member.id} (${member.id})`, inline: false },
        { name: 'Kick bởi', value: `${kickedBy.tag} (${kickedBy.id})`, inline: false },
      )
      .setColor(0xED4245);
  } else {
    embed
      .setTitle('🟠 Thành viên rời server')
      .addFields({ name: 'User', value: `${member.user?.tag ?? member.id} (${member.id})`, inline: false })
      .setColor(0xFAA61A);
  }

  await sendLog(member.guild, embed);
});

/* =========================
   3) Ban / Unban
   ========================= */
client.on('guildBanAdd', async (ban) => {
  // ban: GuildBan { guild, user }
  const entry = await fetchRecentAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, 8000);
  const who = entry ? `${entry.executor.tag} (${entry.executor.id})` : 'Không xác định';

  const embed = new EmbedBuilder()
    .setTitle('⛔ Thành viên bị ban')
    .addFields(
      { name: 'User', value: `${ban.user.username} (${ban.user.id})`, inline: false },
      { name: 'Ban bởi', value: who, inline: false },
    )
    .setTimestamp()
    .setColor(0x992D22);
  await sendLog(ban.guild, embed);
});

client.on('guildBanRemove', async (ban) => {
  // ban: GuildBan { guild, user }
  const entry = await fetchRecentAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id, 8000);
  const who = entry ? `${entry.executor.tag} (${entry.executor.id})` : 'Không xác định';

  const embed = new EmbedBuilder()
    .setTitle('✅ Thành viên được unban')
    .addFields(
      { name: 'User', value: `${ban.user.username} (${ban.user.id})`, inline: false },
      { name: 'Unban bởi', value: who, inline: false },
    )
    .setTimestamp()
    .setColor(0x00B0F4);
  await sendLog(ban.guild, embed);
});

/* =========================
   4) Role changes trên member
   ========================= */
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const added = newRoles.filter(r => !oldRoles.has(r.id));
    const removed = oldRoles.filter(r => !newRoles.has(r.id));

    if (added.size > 0) {
      for (const role of added.values()) {
        const entry = await fetchRecentAudit(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, 8000);
        const who = entry ? `${entry.executor.tag} (${entry.executor.id})` : 'Không xác định';

        const embed = new EmbedBuilder()
          .setTitle('🔰 Role được thêm')
          .addFields(
            { name: 'User', value: `${newMember.user.username} (${newMember.id})`, inline: false },
            { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
            { name: 'Thực hiện bởi', value: who, inline: true },
          )
          .setTimestamp()
          .setColor(0x5865F2);
        await sendLog(newMember.guild, embed);
      }
    }

    if (removed.size > 0) {
      for (const role of removed.values()) {
        const entry = await fetchRecentAudit(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, 8000);
        const who = entry ? `${entry.executor.tag} (${entry.executor.id})` : 'Không xác định';

        const embed = new EmbedBuilder()
          .setTitle('❌ Role bị bỏ')
          .addFields(
            { name: 'User', value: `${newMember.user.username} (${newMember.id})`, inline: false },
            { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
            { name: 'Thực hiện bởi', value: who, inline: true },
          )
          .setTimestamp()
          .setColor(0xF04747);
        await sendLog(newMember.guild, embed);
      }
    }
  } catch (err) {
    console.error('Lỗi guildMemberUpdate:', err);
  }
});

/* =========================
   5) Role tạo / xóa
   ========================= */
client.on('roleCreate', async (role) => {
  const embed = new EmbedBuilder()
    .setTitle('🆕 Role được tạo')
    .addFields({ name: 'Role', value: `${role.name} (${role.id})`, inline: false })
    .setTimestamp()
    .setColor(0x57F287);

  const entry = await fetchRecentAudit(role.guild, AuditLogEvent.RoleCreate, role.id, 8000);
  if (entry) embed.addFields({ name: 'Bởi', value: `${entry.executor.tag} (${entry.executor.id})`, inline: true });

  await sendLog(role.guild, embed);
});

client.on('roleDelete', async (role) => {
  const embed = new EmbedBuilder()
    .setTitle('🗑️ Role bị xóa')
    .addFields({ name: 'Role', value: `${role.name} (${role.id})`, inline: false })
    .setTimestamp()
    .setColor(0xED4245);

  const entry = await fetchRecentAudit(role.guild, AuditLogEvent.RoleDelete, role.id, 8000);
  if (entry) embed.addFields({ name: 'Xóa bởi', value: `${entry.executor.tag} (${entry.executor.id})`, inline: true });

  await sendLog(role.guild, embed);
});

/* =========================
   6) Channel tạo / xóa
   ========================= */
client.on('channelCreate', async (channel) => {
  const guild = channel.guild;
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setTitle('📢 Channel được tạo')
    .addFields(
      { name: 'Tên', value: `${channel.name} (${channel.id})`, inline: false },
      { name: 'Loại', value: `${channel.type}`, inline: true },
    )
    .setTimestamp()
    .setColor(0x57F287);

  const entry = await fetchRecentAudit(guild, AuditLogEvent.ChannelCreate, channel.id, 8000);
  if (entry) embed.addFields({ name: 'Bởi', value: `${entry.executor.tag} (${entry.executor.id})`, inline: true });

  await sendLog(guild, embed);
});

client.on('channelDelete', async (channel) => {
  const guild = channel.guild;
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Channel bị xóa')
    .addFields({ name: 'Tên', value: `${channel.name} (${channel.id})`, inline: false })
    .setTimestamp()
    .setColor(0xED4245);

  const entry = await fetchRecentAudit(guild, AuditLogEvent.ChannelDelete, channel.id, 8000);
  if (entry) embed.addFields({ name: 'Xóa bởi', value: `${entry.executor.tag} (${entry.executor.id})`, inline: true });

  await sendLog(guild, embed);
});

/* =========================
   7) Message delete (tùy chọn)
   ========================= */
client.on('messageDelete', async (message) => {
  try {
    if (message.partial) {
      try { await message.fetch(); } catch { /* ignore */ }
    }
    if (!message.guild) return;

    if (message.author && message.author.bot) return; // Bỏ qua bot

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Tin nhắn bị xóa')
      .addFields(
        { name: 'Tác giả', value: message.author ? `${message.author.tag} (${message.author.id})` : 'Không rõ', inline: false },
        { name: 'Kênh', value: `${message.channel?.name ?? message.channel?.id}`, inline: true },
        { name: 'Nội dung', value: message.content?.slice(0, 1024) || '(không có nội dung)', inline: false },
      )
      .setTimestamp()
      .setColor(0xF04747);

    await sendLog(message.guild, embed);
  } catch (err) {
    console.error('messageDelete lỗi:', err);
  }
});

/* ========================= Đăng Kí LỆNH / BUTTONS ========================= */
const commands = [
  {
    name: 'artist',
    description: '🎤 Phát tuyển tập bài hát của Ca sĩ/Nghệ sĩ',
    options: [
      {
        name: 'name',
        description: 'Tên Ca sĩ/Nghệ sĩ (VD: Đen Vâu, Chillies...)',
        type: 3, // STRING
        required: true,
      }
    ]
  },
  {
    name: 'trending',
    description: '🔥 Phát nhạc Trending theo quốc gia (Dữ liệu từ laogicungton.site)',
    options: [
      {
        name: 'country',
        description: 'Mã quốc gia (VD: VN, US, KR, JP, GB, AU, TH...)',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'mode',
        description: 'Chế độ phát nhạc',
        type: 3, // STRING
        required: false,
        choices: [
          { name: '🎵 Tất cả (mặc định)', value: 'all' },
          { name: '🏠 Nhạc bản địa', value: 'local' },
        ]
      }
    ]
  },
  {
    name: 'login',
    description: '🚀 Lấy Token đăng nhập Web (Chỉ hiện cho riêng bạn)',
  },
  {
    name: 'play',
    description: '🎵 Phát Nhạc Từ URL (YouTube, Spotify, v.v.)',
    options: [
      {
        name: 'query',
        description: 'URL hoặc từ khóa tìm kiếm',
        type: 3, // STRING
        required: true,
      }
    ]
  },

  {
    name: 'pause',
    description: '⏸️ Dừng Nhạc Tạm Thời',
  },
  {
    name: 'queue',
    description: ' Xem Danh Sách Phát Hiện Tại',
  },
  {
    name: 'leave',
    description: '🚪 Rời khỏi kênh thoại',
  },
  {
    name: 'stop',
    description: '⏹️ Dừng phát nhạc và xóa danh sách phát',
  },
  {
    name: 'skip',
    description: '⏭️ Bỏ qua bài hát hiện tại',
  },
  {
    name: 'resume',
    description: '▶️ Tiếp tục phát nhạc bị tạm dừng',
  },
  {
    name: 'prev',
    description: '⏮️ Quay lại bài hát trước đó',
  },
  {
    name: 'skipto',
    description: '⏩ Nhảy đến bài hát trong danh sách phát',
  },
  {
    name: 'reset',
    description: '🔄 Đặt lại Token đăng nhập Web của bạn',
  },
  {
    name: 'loop',
    description: '🔁 Chọn chế độ lặp lại nhạc',
    options: [
      {
        name: 'mode',
        description: 'Chế độ lặp',
        type: 3, // STRING
        required: true,
        choices: [
          { name: '⏹️ Tắt lặp (off)', value: 'off' },
          { name: '🔂 Lặp lại bài này (song)', value: 'song' },
          { name: '🔁 Lặp toàn bộ hàng đợi (queue)', value: 'queue' },
        ]
      }
    ]
  }
];

const rest = new REST({ version: '10' });
// ====================================================
// 2. SỰ KIỆN BOT ONLINE
// ====================================================
client.once('clientReady', async () => {
  console.log(`✅ Bot đã online: ${client.user.username}`);

  // Lấy token trực tiếp từ bot để nạp vào REST
  const tokenToUse = client.token;

  try {
    console.log('⏳ Đang làm mới lệnh Slash (/) ...');
    rest.setToken(tokenToUse);
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    console.log('✅ Đăng ký lệnh thành công!');
  } catch (error) {
    console.error('❌ Lỗi đăng ký lệnh:', error);
  }
});

// ====================================================
// 3. XỬ LÝ LỆNH SLASH (/LOGIN & /RESET)
// ====================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Chỉ dùng trong server (trừ lệnh login/reset có thể cân nhắc mở DM nếu muốn, nhưng ở đây check guild)
  if (!interaction.guildId) {
    return interaction.reply({ content: '❌ Chỉ dùng được trong server.', flags: 64 }).catch(() => { });
  }

  const { commandName } = interaction;

  try {
    console.log(`[DEBUG] Handling command: '${commandName}'`);
    // --- NHÓM LỆNH HỆ THỐNG: LOGIN & RESET ---
    if (['login', 'reset'].includes(commandName)) {

      // 1. Check quyền
      const member = interaction.member;
      const hasRole = member.roles.cache.some(role => ALLOWED_ROLES.includes(role.name));
      if (!hasRole) {
        return await interaction.reply({ content: "⛔ Bạn không có quyền (Role: AD-N/Net)!", flags: 64 });
      }

      // 2. Defer ngay lập tức để tránh lỗi "Unknown interaction" do timeout 3s
      await interaction.deferReply({ flags: 64 });

      // 3. Chuẩn bị gọi API
      const params = new URLSearchParams();
      params.append('secret', process.env.WEB_API_SECRET);
      params.append('user_id', interaction.user.id);

      // Xử lý riêng từng lệnh
      if (commandName === 'login') {
        const roleType = member.roles.cache.some(r => r.name === 'AD-N') ? 'AD-N' : 'Net';
        params.append('action', 'create_token'); // Action chuẩn
        params.append('role', roleType);

        // Gọi API với timeout 5s để không bị treo
        const response = await axios.post(WEB_API_URL, params, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 5000
        });
        const data = response.data;

        if (data.status === 'success') {
          const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('🔑 Token Truy Cập')
            // Dùng 3 dấu huyền để dễ nhìn hơn
            .setDescription(`\`\`\`${data.token}\`\`\`\n⚠️ Token có hạn 30 phút.\n👉 Bấm nút bên dưới để tự động đăng nhập.`)
            .setFooter({ text: 'Chỉ mình bạn nhìn thấy tin nhắn này.' });

          // Tạo nút bấm dạng Link
          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setLabel('🚀 Đăng Nhập Nhanh')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://laogicungton.site/?auto_token=${data.token}`) // Truyền token lên URL
            );

          await interaction.editReply({ embeds: [embed], components: [row] });
        }

      } else if (commandName === 'reset') {
        params.append('action', 'reset_token');

        const response = await axios.post(WEB_API_URL, params, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 5000
        });
        const data = response.data;

        if (data.status === 'success') {
          await interaction.editReply({ content: `✅ **Thành công:** ${data.msg}\n(Đã kích hoạt Kill Switch)` });
        } else {
          await interaction.editReply({ content: `⚠️ **Thông báo:** ${data.msg}` });
        }
      }
      return; // Kết thúc xử lý Login/Reset
    }

    // --- NHÓM LỆNH NHẠC (MUSIC) ---
    // Guard Control: Check xem có được phép điều khiển nhạc không
    const musicCommands = ['leave', 'stop', 'skip', 'pause', 'resume', 'prev', 'skipto', 'trending', 'artist', 'loop'];
    if (musicCommands.includes(commandName)) {
      if (!(await guardControl(interaction))) return;
    }

    switch (commandName) {
      case 'artist': return handleArtist(interaction);
      case 'trending': return handleTrending(interaction);
      case 'play': return handlePlay(interaction);
      case 'queue': return handleQueue(interaction);
      case 'leave': return handleLeave(interaction);
      case 'stop': return handleStop(interaction);
      case 'skip': return handleSkip(interaction);
      case 'pause': return handlePause(interaction);
      case 'resume': return handleResume(interaction);
      case 'prev': return handlePrev?.(interaction);
      case 'skipto': return handleSkipTo?.(interaction);
      case 'loop': return handleLoop(interaction);
      default:
        // Nếu lệnh không khớp cái nào
        return interaction.reply({ content: '❓ Lệnh không hỗ trợ.', flags: 64 }).catch(() => { });
    }

  } catch (err) {
    console.error(`🚨 Lỗi xử lý lệnh /${commandName}:`, err.message);

    // Xử lý lỗi an toàn để không crash bot
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "❌ Có lỗi xảy ra khi xử lý yêu cầu!" });
      } else {
        await interaction.reply({ content: "❌ Có lỗi xảy ra!", flags: 64 });
      }
    } catch (e) {
      // Nếu không thể reply (do token hết hạn hẳn), chỉ log ra console
      console.error('Không thể gửi thông báo lỗi tới user:', e.message);
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  // Bỏ qua lệnh slash cũ
  if (message.content.startsWith('!login') || message.content.startsWith('!reset')) return;

  if (message.content.startsWith('!')) {
    try {
      // music.execute(message); // music is not defined
      console.log('Legacy prefix commands not supported');
    } catch (error) {
      console.error("Lỗi Music:", error);
    }
  }
});

client.on('guildMemberAdd', async member => {
  try {
    const channel = member.guild.channels.cache.find(ch => ch.name === 'welcome');
    if (!channel) return;

    const canvas = Canvas.createCanvas(700, 250);
    const ctx = canvas.getContext('2d');
    // Lưu ý: Cần đảm bảo file wallpaper.jpg cùng thư mục với index.cjs
    const background = await Canvas.loadImage(path.join(__dirname, 'wallpaper.jpg')).catch(() => null);

    if (background) ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = '#23272a'; ctx.fillRect(0, 0, canvas.width, canvas.height); }

    ctx.strokeStyle = '#74037b'; ctx.strokeRect(0, 0, canvas.width, canvas.height);
    ctx.font = '28px sans-serif'; ctx.fillStyle = '#ffffff';
    ctx.fillText('Welcome to the server,', canvas.width / 2.5, canvas.height / 3.5);
    ctx.font = '35px sans-serif'; ctx.fillStyle = '#ffffff';
    ctx.fillText(`${member.displayName}!`, canvas.width / 2.5, canvas.height / 1.8);

    ctx.beginPath(); ctx.arc(125, 125, 100, 0, Math.PI * 2, true); ctx.closePath(); ctx.clip();
    const avatar = await Canvas.loadImage(member.user.displayAvatarURL({ extension: 'jpg' }));
    ctx.drawImage(avatar, 25, 25, 200, 200);

    const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });
    channel.send({ content: `Chào mừng ${member} đã đến với server!`, files: [attachment] });
  } catch (e) { console.error("Lỗi Welcome:", e); }
});

// --- ANTI-CRASH ---
process.on('unhandledRejection', (reason) => { console.log('🚨 Lỗi chưa xử lý:', reason); });
process.on('uncaughtException', (err) => { console.log('🚨 Lỗi nghiêm trọng:', err); });

// ĐĂNG NHẬP CUỐI CÙNG
client.login(TOKEN);
