import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AuditLogEvent,
} from 'discord.js';

import {
  handlePlay, handleSkip, handleStop, handleQueue, handleLeave,
  handlePause, handleResume,
  currentController, currentControllerName
} from './music.opus.v7.6.js';


/* =========================
   0) ENV & KHỞI TẠO CLIENT
   ========================= */
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID?.trim();
const DJ_ROLE = process.env.DJ_ROLE || 'DJ';

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
    ephemeral: true,
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
    GatewayIntentBits.GuildMembers, // join/leave/role update
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
    // GatewayIntentBits.MessageContent // bật nếu cần đọc nội dung tin nhắn (cân nhắc)
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

/* =========================
   Helpers
   ========================= */
// Gửi embed vào kênh log
async function sendLog(guild, embed) {
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
      { name: 'User', value: `${member.user.tag} (${member.id})`, inline: false },
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
      { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: false },
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
      { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: false },
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
            { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
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
            { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
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


client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild?.() || !interaction.guildId) {
    return interaction.reply({ ephemeral: true, content: '❌ Chỉ dùng được trong server.' }).catch(() => {});
  }

  try {
    switch (interaction.commandName) {
      case 'play':
        return handlePlay(interaction);

      case 'queue':
        return handleQueue(interaction);

      case 'leave':
        if (!(await guardControl(interaction))) return;
        return handleLeave(interaction);

      case 'stop':
        if (!(await guardControl(interaction))) return;
        return handleStop(interaction);

      case 'skip':
        if (!(await guardControl(interaction))) return;
        return handleSkip(interaction);

      case 'pause':
        if (!(await guardControl(interaction))) return;
        return handlePause(interaction);

      case 'resume':
        if (!(await guardControl(interaction))) return;
        return handleResume(interaction);

      case 'prev':
        if (!(await guardControl(interaction))) return;
        return handlePrev?.(interaction);

      case 'skipto':
        if (!(await guardControl(interaction))) return;
        return handleSkipTo?.(interaction);

      default:
        return interaction.reply({ ephemeral: true, content: '❓ Lệnh không hỗ trợ.' }).catch(() => {});
    }
  } catch (err) {
    console.error('interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ ephemeral: true, content: '❌ Lỗi khi xử lý lệnh.' }).catch(() => {});
    }
  }
});

// ========= Ready / Login =========
client.once('ready', (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  try { c.user.setActivity('🎵 Music'); } catch {}
});

// Start the bot
client.login(TOKEN)
