import {
  joinVoiceChannel, createAudioPlayer, NoSubscriberBehavior,
  createAudioResource, AudioPlayerStatus,
  entersState, VoiceConnectionStatus, demuxProbe
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ytdlp from 'youtube-dl-exec';
import { ChannelType } from 'discord.js';
import { Console } from 'node:console';

const ffmpegPath = ffmpegStatic || 'ffmpeg';
const queues = new Map();
const IDLE_MS = 5 * 60 * 1000;

function getQueue(guild) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      items: [],
      current: null,
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      connection: null,
      proc: { dl: null, ff: null },
      idleTimer: null,
      textChannelId: null,
      leaving: false,
    };
    hookPlayer(q, guild);
    queues.set(guild.id, q);
  }
  return q;
}

function hookPlayer(q, guild) {
  q.player.on('stateChange', (oldS, newS) => {
    console.log(`[player] ${oldS.status} -> ${newS.status}`);
  });
  q.player.on('idle', () => {
    console.log('⏹️  Player: Idle');
    safeStopCurrent(q, /*soft=*/true);
    q.current = null;
    if (q.leaving) return;
    if (q.items.length > 0 && q.connection) {
      console.log('⏳ Đang nghỉ 3s...')
      SetTimeout(() => {
        next(guild).catch(e => console.warn('[next error@Idle]', e?.message || e));
      }, 3000);
    }
    else {
      armIdleTimer(guild, q);
    }
    });

  q.player.on('error', (err) => {
    console.warn('Player error:', err?.message || err);
    safeStopCurrent(q, /*soft=*/true);
    q.current = null;
    if (q.leaving) return;
    if (q.items.length > 0 && q.connection) next(guild).catch(e => console.warn('[next error@PlayerError]', e?.message || e));
    else armIdleTimer(guild, q);
  });
}

function attachProcSwallow(child, tag) {
  if (!child || child.__hooked) return;
  child.__hooked = true;
  child.on('error', (e) => console.warn(`[proc error:${tag}]`, e?.message || e));
  child.on('close', (code, signal) => {
    if (signal === 'SIGKILL' || code === 0 || code == null) return;
    console.log(`[proc close:${tag}] code=${code} signal=${signal}`);
  });
}

function clearIdleTimer(q) { if (q.idleTimer) { clearTimeout(q.idleTimer); q.idleTimer = null; } }
function armIdleTimer(guild, q) {
  clearIdleTimer(q);
  q.idleTimer = setTimeout(() => {
    try { fullCleanup(guild, q); queues.delete(guild.id); console.log(`[idle-cleanup] Disconnected from guild ${guild.id}`); }
    catch (e) { console.warn('[idle-cleanup error]', e?.message || e); }
  }, IDLE_MS);
}

function safeStopCurrent(q, soft=false) {
  try {
    if (q.proc.ff) {
      try { q.proc.ff.stdin?.destroy(); } catch {}
      try { q.proc.ff.stdout?.destroy(); } catch {}
      try { q.proc.ff.kill('SIGKILL'); } catch {}
    }
    if (q.proc.dl) {
      try { q.proc.dl.stdout?.destroy(); } catch {}
      try { q.proc.dl.kill('SIGKILL'); } catch {}
      try { typeof q.proc.dl.catch === 'function' && q.proc.dl.catch(()=>{}); } catch {}
    }
  } catch {}
  q.proc = { dl: null, ff: null };
  if (!soft) { try { q.player.stop(true); } catch {} }
}

function fullCleanup(guild, q) {
  clearIdleTimer(q);
  q.leaving = true;
  safeStopCurrent(q);
  q.items = [];
  q.current = null;
  try { if (q.connection) q.connection.destroy(); } catch {}
  q.connection = null;
  q.leaving = false;
}

function formatDuration(secs) {
  const s = Number(secs);
  if (!isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

async function fetchInfo(url, headers) {
  try {
    const out = await ytdlp(url, {
      dumpSingleJson: true, noCheckCertificates: true, noPlaylist: true, quiet: true, addHeader: headers,
    });
    const info = (typeof out === 'string') ? JSON.parse(out) : out;
    if (info && typeof info === 'object') {
      return { title: info.title || null, duration: Number(info.duration) || null, webpage_url: info.webpage_url || url };
    }
  } catch (e) { console.warn('[meta error]', e?.message || e); }
  return { title: null, duration: null, webpage_url: url };
}

function isSpotifyTrackUrl(u) {
  try { const x = new URL(u); return x.hostname.includes('open.spotify.com') && x.pathname.startsWith('/track/'); }
  catch { return false; }
}
async function spotifyToOEmbed(u) {
  const resp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`);
  if (!resp.ok) throw new Error(`oembed ${resp.status}`);
  return await resp.json();
}
async function spotifyToYtSearch(u) {
  try {
    const data = await spotifyToOEmbed(u);
    const title = data?.title || '', author = data?.author_name || '';
    const q = `${title} ${author}`.trim();
    if (q) return { search: `ytsearch1:${q}`, fallbackTitle: q };
  } catch (e) { console.warn('[spotify oembed fail]', e?.message || e); }
  return { search: null, fallbackTitle: null };
}
async function resolvePlayableUrl(u) {
  if (typeof u === 'string' && isSpotifyTrackUrl(u)) {
    const { search } = await spotifyToYtSearch(u);
    if (search) return search;
  }
  return u;
}

async function makeOggOpusPipeline(inputStream) {
  const ff = spawn(ffmpegPath, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libopus',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'ogg',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });

  attachProcSwallow(ff, 'ffmpeg');

  // --- ĐOẠN FIX LỖI EOF ---
  // Khi ffmpeg chết, nếu ta cố ghi vào stdin của nó sẽ gây lỗi.
  // Dòng này giúp bắt lỗi đó và lờ đi (vì nhạc đã dừng rồi, lỗi cũng không sao).
  ff.stdin.on('error', (err) => {
      // Bỏ qua lỗi EPIPE hoặc EOF vì đó là do ffmpeg đã tắt
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      console.warn('[ffmpeg stdin error]', err.message);
  });

  // Pipe dữ liệu và cũng bắt lỗi ở luồng pipe
  inputStream.pipe(ff.stdin).on('error', (err) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      // console.warn('[pipe error]', err.message); 
  });
  // -----------------------

  return ff.stdout;
}

async function next(guild) {
  const q = queues.get(guild.id);
  if (!q || q.items.length === 0) return;
  if (!q.connection || q.leaving) return;

  const track = q.items.shift();
  q.current = track;

  try { await entersState(q.connection, VoiceConnectionStatus.Ready, 15_000); }
  catch { console.warn('[voice] not ready'); q.current = null; return; }

  if (!q.connection || q.leaving) { q.current = null; return; }

  const headers = [];
  if (process.env.YT_COOKIE) headers.push(`cookie: ${process.env.YT_COOKIE}`);
  headers.push('referer: https://www.youtube.com', 'user-agent: Mozilla/5.0');

  const playableUrl = await resolvePlayableUrl(track.url);
  if (!playableUrl) {
    if (q.textChannelId) safeSend(guild, q.textChannelId, { content: `❌ Không phát được link này: ${track.url}` });
    q.current = null;
    if (q.items.length > 0) next(guild).catch(()=>{}); else armIdleTimer(guild, q);
    return;
  }

  const dl = ytdlp.exec(playableUrl, {
    output: '-', format: 'bestaudio/best', noCheckCertificates: true, noPlaylist: true,  addHeader: headers, //cookies:'./cookies.txt'
  });
  if (typeof dl?.catch === 'function') dl.catch(()=>{});
  attachProcSwallow(dl, 'yt-dlp');

  const oggStream = await makeOggOpusPipeline(dl.stdout);
  q.proc = { dl, ff: null };

  const { stream, type } = await demuxProbe(oggStream);
  const resource = createAudioResource(stream, { inputType: type });

  try {
    if (!q.connection || q.leaving) { safeStopCurrent(q, /*soft=*/true); q.current = null; return; }
    q.player.play(resource);
    const sub = q.connection.subscribe(q.player);
    if (sub) console.log('[voice] subscribed');
  } catch (e) {
    console.warn('[subscribe/play error]', e?.message || e);
    safeStopCurrent(q, /*soft=*/true);
    q.current = null;
    if (q.items.length > 0) next(guild).catch(()=>{}); else armIdleTimer(guild, q);
    return;
  }

  if (q.textChannelId) {
    const name = track.title || track.url;
    const dur = formatDuration(track.duration);
    const req = track.requesterName ? ` • yêu cầu: ${track.requesterName}` : '';
    safeSend(guild, q.textChannelId, { content: `🎶🎵 Đang phát: **${name}**${dur ? ` (${dur})` : ''}${req}` });
  }
}

async function safeSend(guild, channelId, payload) {
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) await ch.send(payload).catch(() => null);
  } catch {}
}

function readQueryFromInteraction(interaction) {
  try {
    const o = interaction?.options;
    return (
      (o && (o.getString?.('query') ?? o.getString?.('url') ?? o.getString?.('q') ?? o.getString?.('song'))) ?? null
    );
  } catch { return null; }
}

// ===== Helpers để index.js kiểm tra quyền điều khiển =====
export function currentController(guildId) {
  const q = queues.get(guildId);
  return q?.current?.requesterId ?? null;
}
export function currentControllerName(guildId) {
  const q = queues.get(guildId);
  return q?.current?.requesterName ?? null;
}

// ===== Handlers =====
export async function handlePlay(interaction, query) {
  if (!interaction.guild || !interaction.member?.voice?.channel) {
    return interaction.reply({ content: '❌ Bạn cần vào voice channel trước.', flags: 64 });
  }
  await interaction.deferReply({ flags: 64 }).catch(() => {});

  const guild = interaction.guild;
  const q = getQueue(guild);
  q.textChannelId = interaction.channelId;
  clearIdleTimer(q);

  if (!q.connection) {
    q.connection = joinVoiceChannel({
      channelId: interaction.member.voice.channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    q.connection.on('stateChange', (o, s) => {
      console.log(`[conn] ${o.status} -> ${s.status}`);
      if (s.status === VoiceConnectionStatus.Disconnected) fullCleanup(guild, q);
    });
  }

  let text = (typeof query === 'string') ? query.trim() : '';
  if (!text) {
    const guessed = readQueryFromInteraction(interaction);
    text = (typeof guessed === 'string') ? guessed.trim() : '';
  }
  if (!text) {
    await interaction.editReply({ content: '❌ Bạn cần nhập URL hoặc từ khoá tìm kiếm.' });
    return;
  }

  const requesterId = interaction.user?.id;
  const requesterName = interaction.member?.displayName || interaction.user?.username || interaction.user?.id;
  const inputUrlOrQuery = /^https?:\/\//i.test(text) ? text : `ytsearch1:${text}`;
  q.items.push({ url: inputUrlOrQuery, title: text, duration: null, requesterId, requesterName });

  await interaction.editReply({ 
    content: `✅ **Đã thêm vào hàng đợi:** ${text}`
  }).catch(() => {});

  if (q.player.state.status !== 'playing' && q.connection) {
    next(guild).catch(e => console.warn('[next error@play]', e?.message || e));
  }
}

export async function handleSkip(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '⏭️ Không có gì để skip.', flags: 64 });
  safeStopCurrent(q);
  await interaction.reply({ content: '⏭️ Đã skip.' }).catch(() => {});
  if (q.items.length > 0 && q.connection) next(interaction.guild).catch(()=>{});
  else armIdleTimer(interaction.guild, q);
}
export async function handleStop(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '⏹️ Không có gì để dừng.', flags: 64 });
  fullCleanup(interaction.guild, q);
  await interaction.reply({ content: '⏹️ Đã dừng và xoá hàng đợi.' });
}
export async function handleQueue(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q || (!q.current && q.items.length === 0)) return interaction.reply({ content: '📭 Hàng đợi trống.', flags: 64 });
  const lines = [];
  if (q.current) lines.push(`🎶 ${q.current.title || q.current.url}`);
  q.items.forEach((t, i) => lines.push(`${i + 1}. ${t.title || t.url} — ${t.requesterName ? `by ${t.requesterName}` : ''}`));
  await interaction.reply({ content: '```' + lines.join('\n') + '```' });
}
export async function handleLeave(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '👋 Bot đã rời trước đó.', flags: 64 });
  fullCleanup(interaction.guild, q);
  queues.delete(interaction.guildId);
  await interaction.reply({ content: '👋 Đã rời kênh và giải phóng RAM.' });
}
export async function handlePause(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '⏸️ Không có gì để tạm dừng.', flags: 64 });
  try { q.player.pause(true); armIdleTimer(interaction.guild, q); await interaction.reply({ content: '⏸️ Đã tạm dừng.' }); }
  catch { await interaction.reply({ content: '❌ Không thể tạm dừng.', flags: 64 }); }
}
export async function handleResume(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '▶️ Không có gì để tiếp tục.', flags: 64 });
  try { clearIdleTimer(q); q.player.unpause(); await interaction.reply({ content: '▶️ Tiếp tục phát.' }); }
  catch { await interaction.reply({ content: '❌ Không thể tiếp tục.', flags: 64 }); }
}
export async function handleSkipTo() { return; }
export async function handlePrev() { return; }
