const {
  joinVoiceChannel, createAudioPlayer, NoSubscriberBehavior,
  createAudioResource, AudioPlayerStatus,
  entersState, VoiceConnectionStatus, demuxProbe
} = require('@discordjs/voice');
const { spawn } = require('node:child_process');
const ffmpegStatic = require('ffmpeg-static');
const path = require('node:path');
const fs = require('node:fs');
const { create: createYtdlp } = require('youtube-dl-exec');
// Dùng yt-dlp.exe local (mới nhất) trên Windows, system yt-dlp trên Linux
const _localBin = path.join(__dirname, 'yt-dlp.exe');
const _linuxBin = '/usr/local/bin/yt-dlp';
const ytdlp = (process.platform === 'win32' && fs.existsSync(_localBin))
  ? createYtdlp(_localBin)
  : (process.platform !== 'win32' && fs.existsSync(_linuxBin) ? createYtdlp(_linuxBin) : require('youtube-dl-exec'));
const play = require('play-dl'); // Added play-dl
const { ChannelType } = require('discord.js');

const ffmpegPath = ffmpegStatic || 'ffmpeg';
const queues = new Map();
const IDLE_MS = 5 * 60 * 1000;

// Khởi tạo play-dl với YouTube cookie (bypass bot detection 2025+)
if (process.env.YT_COOKIE) {
  play.setToken({ youtube: { cookie: process.env.YT_COOKIE } });
  console.log('[play-dl] Đã set YouTube cookie.');
} else {
  console.warn('[play-dl] Không có YT_COOKIE — có thể bị giới hạn bởi YouTube.');
}

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
      loopMode: 'off', // 'off' | 'song' | 'queue'
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
    const finishedTrack = q.current;
    safeStopCurrent(q, /*soft=*/true);
    q.current = null;
    if (q.leaving) return;

    // Loop song: đẩy lại bài vừa xong vào đầu hàng đợi
    if (q.loopMode === 'song' && finishedTrack) {
      q.items.unshift(finishedTrack);
    }
    // Loop queue: đẩy bài vừa xong vào cuối hàng đợi
    else if (q.loopMode === 'queue' && finishedTrack) {
      q.items.push(finishedTrack);
    }

    if (q.items.length > 0 && q.connection) {
      console.log('⏳ Đang nghỉ 3s...')
      setTimeout(() => {
        next(guild).catch(e => console.warn('[next error@Idle]', e?.message || e));
      }, 3000);
    }
    else {
      armIdleTimer(guild, q);
    }
  });

  q.player.on('error', (err) => {
    console.warn('Player error:', err?.message || err);
    const finishedTrack = q.current;
    safeStopCurrent(q, /*soft=*/true);
    q.current = null;
    if (q.leaving) return;
    // Khi có lỗi, không lặp lại bài đó để tránh vòng lặp lỗi vô tận
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

function safeStopCurrent(q, soft = false) {
  try {
    if (q.proc.ff) {
      try { q.proc.ff.stdin?.destroy(); } catch { }
      try { q.proc.ff.stdout?.destroy(); } catch { }
      try { q.proc.ff.kill('SIGKILL'); } catch { }
    }
    if (q.proc.dl) {
      try { q.proc.dl.stdout?.destroy(); } catch { }
      try { q.proc.dl.kill('SIGKILL'); } catch { }
      try { typeof q.proc.dl.catch === 'function' && q.proc.dl.catch(() => { }); } catch { }
    }
  } catch { }
  q.proc = { dl: null, ff: null };
  if (!soft) { try { q.player.stop(true); } catch { } }
}

function fullCleanup(guild, q) {
  clearIdleTimer(q);
  q.leaving = true;
  safeStopCurrent(q);
  q.items = [];
  q.current = null;
  try { if (q.connection) q.connection.destroy(); } catch { }
  q.connection = null;
  q.leaving = false;
}

function formatDuration(secs) {
  const s = Number(secs);
  if (!isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Giữ lại play-dl làm search và playlist resolver, nhưng vẫn dùng yt-dlp để stream cho ổn định
// hoặc dùng trực tiếp play-dl stream nếu muốn (nhưng code cũ đang dùng ytdlp pipes)
// -> Dùng play-dl lấy info playlist, sau đó push từng url video vào queue.

async function resolvePlayableUrl(u) {
  // Check Spotify
  if (typeof u === 'string' && isSpotifyTrackUrl(u)) {
    const { search } = await spotifyToYtSearch(u);
    if (search) return search;
  }
  return u;
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


function makeOggOpusPipeline(inputStream) {
  const ff = spawn(
    ffmpegPath,
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  attachProcSwallow(ff, 'ffmpeg');

  ff.stdin.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'EOF') return;
    console.warn('[ffmpeg stdin error]', err.message);
  });

  inputStream.pipe(ff.stdin).on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'EOF') return;
  });

  return { stream: ff.stdout, ff };
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

  const playableUrl = await resolvePlayableUrl(track.url);
  if (!playableUrl) {
    if (q.textChannelId) safeSend(guild, q.textChannelId, { content: `❌ Không phát được: ${track.title || track.url}` });
    q.current = null;
    if (q.items.length > 0) next(guild).catch(() => { }); else armIdleTimer(guild, q);
    return;
  }

  try {
    // Bước 1: Validate URL với play-dl
    const urlType = await play.validate(playableUrl).catch(() => false);
    console.log(`[next] URL type: ${urlType}, streaming: ${playableUrl}`);

    let resource;

    // Chỉ thử play-dl khi là yt_video URL thực sự.
    // ytsearch1:... không được play.stream() hỗ trợ → phải dùng yt-dlp.
    if (urlType === 'yt_video') {
      try {
        const stream = await play.stream(playableUrl, { quality: 2 });
        resource = createAudioResource(stream.stream, { inputType: stream.type });
      } catch (playDlErr) {
        console.warn('[play-dl] yt_video stream failed, falling back to yt-dlp:', playDlErr?.message || playDlErr);
        // fallthrough to yt-dlp block below
      }
    }

    if (!resource) {
      // Fallback: yt-dlp với cookies.txt để bypass bot detection YouTube
      // Chrome 127+ dùng DPAPI mới, yt-dlp không đọc được → dùng file cookies.txt thủ công
      const cookieOpts = {};
      // Ưu tiên: cookies.txt cạnh bot > YT_COOKIES_FILE env > không có cookie
      const localCookies = path.join(__dirname, 'cookies.txt');
      const envCookies = process.env.YT_COOKIES_FILE;

      if (fs.existsSync(localCookies)) {
        cookieOpts.cookies = localCookies;
        console.log('[next] yt-dlp: dùng cookies.txt local...');
      } else if (envCookies && fs.existsSync(envCookies)) {
        cookieOpts.cookies = envCookies;
        console.log('[next] yt-dlp: dùng cookies file từ env:', envCookies);
      } else {
        console.warn('[next] yt-dlp: không tìm thấy cookies.txt — YouTube có thể block!');
      }

      const dl = ytdlp.exec(playableUrl, {
        output: '-',
        format: 'bestaudio/best',
        noCheckCertificates: true,
        noPlaylist: true,
        preferFreeFormats: true,
        quiet: true,
        // Truyền đường dẫn node.exe hiện tại để yt-dlp giải được n-challenge
        jsRuntimes: `node:${process.execPath}`,
        ...cookieOpts,
      });
      if (dl.stderr) dl.stderr.on('data', d => console.log('[yt-dlp]', String(d).trim()));
      if (typeof dl?.catch === 'function') dl.catch(() => { });
      attachProcSwallow(dl, 'yt-dlp-fallback');
      const { stream: oggStream, ff } = makeOggOpusPipeline(dl.stdout);
      q.proc = { dl, ff };
      const { stream, type } = await demuxProbe(oggStream);
      resource = createAudioResource(stream, { inputType: type });
    }

    if (!q.connection || q.leaving) { q.current = null; return; }
    // Chỉ clear proc nếu dùng play-dl (yt-dlp fallback tự set proc rồi)
    if (!q.proc.dl) q.proc = { dl: null, ff: null };
    q.player.play(resource);
    const sub = q.connection.subscribe(q.player);
    if (sub) console.log('[voice] subscribed');
  } catch (e) {
    console.warn('[play-dl stream error]', e?.message || e);
    if (q.textChannelId) safeSend(guild, q.textChannelId, { content: `⚠️ Lỗi phát **${track.title || track.url}**, chuyển bài tiếp...` });
    safeStopCurrent(q, /*soft=*/true);
    q.current = null;
    if (q.items.length > 0) {
      setTimeout(() => next(guild).catch(() => { }), 1000);
    } else armIdleTimer(guild, q);
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
  } catch { }
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
function currentController(guildId) {
  const q = queues.get(guildId);
  return q?.current?.requesterId ?? null;
}
function currentControllerName(guildId) {
  const q = queues.get(guildId);
  return q?.current?.requesterName ?? null;
}

// ===== Handlers =====

async function handlePlay(interaction, query) {
  if (!interaction.guild || !interaction.member?.voice?.channel) {
    return interaction.reply({ content: '❌ Bạn cần vào voice channel trước.', flags: 64 });
  }
  // Nếu đã defer từ trước (do trending gọi qua) thì không defer lại, nếu chưa thì defer
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 }).catch(() => { });
  }

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

  // --- LOGIC MỚI: XỬ LÝ PLAYLIST BẰNG PLAY-DL / YT-DLP ---
  // Kiểm tra nếu là URL playlist
  if (text.includes('list=') || (text.includes('spotify.com') && (text.includes('playlist') || text.includes('album')))) {
    try {
      // Check loại link
      const type = await play.validate(text);

      let tracks = [];
      if (type === 'yt_playlist') {
        const data = await fetchPlaylistData(text);
        if (data && data.tracks.length > 0) {
          tracks = data.tracks.map(v => ({
            url: v.url,
            title: v.title,
            duration: v.duration,
            requesterId,
            requesterName
          }));
          await interaction.editReply({ content: `✅ **Đã thêm Playlist:** ${data.title} (${tracks.length} bài) vào hàng đợi.` });
        } else {
          console.log("Playlist fetch returned no data, falling back to single video.");
          throw new Error("Empty playlist data");
        }
      }
      else if (type === 'sp_playlist' || type === 'sp_album') {
        // Spotify playlist support (requires play-dl spotify setup, but basic url extraction might work if supported or fallback)
        // Simple fallback: play-dl default behavior if tokens not set might be limited. 
        // Assuming user relies on YT mainly. If sp_playlist, just try standard play-dl handling or fallback to single track logic if it fails.
        // For simplicity, let's try to get data.
        if (play.is_expired()) {
          // Refresh token logic normally goes here, leaving empty for now assuming basic usage
        }
        const data = await play.spotify(text);
        const videos = data.all_tracks(); // This returns spotiy tracks info
        // We need to resolve these to YouTube later or now. 
        // Resolving NOW takes time. Resolving LATER is proper queue behavior.
        // However, `music.cjs` `next` logic uses `resolvePlayableUrl` which handles spotify single tracks.
        // We can just push spotify objects properly or convert them to dummy objects that `next` can handle.
        // Current `next` logic expects `url`. If we pass spotify track url, `resolvePlayableUrl` handles it.
        tracks = videos.map(v => ({
          url: v.url,
          title: `${v.name} - ${v.artists.map(a => a.name).join(', ')}`,
          duration: v.durationInSec,
          requesterId,
          requesterName
        }));
        await interaction.editReply({ content: `✅ **Đã thêm Spotify List:** ${data.name} (${tracks.length} bài) vào hàng đợi.` });
      }
      else {
        // Fallback single or search
        throw new Error("Not a playlist");
      }

      if (tracks.length > 0) {
        q.items.push(...tracks);
        if (q.player.state.status !== 'playing' && q.connection) {
          next(guild).catch(e => console.warn('[next error@playlist]', e?.message || e));
        }
        return;
      }
    } catch (e) {
      console.log("Playlist Play Error, falling back to single:", e);
      // Fallthrough
    }
  }

  // --- LOGIC CŨ (SINGLE / SEARCH) ---
  const inputUrlOrQuery = /^https?:\/\//i.test(text) ? text : `ytsearch1:${text}`;
  // Thử dùng play-dl search để lấy title chính xác hơn nếu muốn, hoặc dùng yt-dlp như cũ.
  // Để đơn giản và nhanh, giữ logic cũ cho bài lẻ, chỉ update title nếu `next` resolve được.
  q.items.push({ url: inputUrlOrQuery, title: text, duration: null, requesterId, requesterName });

  if (!interaction.replied) {
    await interaction.editReply({
      content: `✅ **Đã thêm vào hàng đợi:** ${text}`
    }).catch(() => { });
  }

  if (q.player.state.status !== 'playing' && q.connection) {
    next(guild).catch(e => console.warn('[next error@play]', e?.message || e));
  }
}

// Helper: Tìm playlist bằng yt-dlp (ổn định hơn play-dl search)
async function searchPlaylist(query) {
  try {
    const out = await ytdlp(`ytsearch1:playlist ${query}`, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      flatPlaylist: true,
      quiet: true,
      jsRuntimes: 'node',
    });
    if (out && out.entries && out.entries.length > 0) {
      return out.entries[0]; // Trả về playlist đầu tiên
    }
  } catch (e) {
    console.warn('[searchPlaylist error]', e?.message || e);
  }
  return null;
}

// Helper: Fetch playlist data (Try play-dl -> Fallback yt-dlp)
async function fetchPlaylistData(url) {
  // 1. Try play-dl
  try {
    const playlist = await play.playlist_info(url, { incomplete: true });
    const videos = await playlist.all_videos();
    return {
      title: playlist.title,
      tracks: videos.map(v => ({
        title: v.title,
        url: v.url,
        duration: v.durationInSec
      }))
    };
  } catch (e) {
    console.warn('[fetchPlaylistData] play-dl failed, trying yt-dlp:', e.message);
  }

  // 2. Fallback yt-dlp (Support Mix / RD playlists)
  try {
    const out = await ytdlp(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      flatPlaylist: true,
      quiet: true,
      jsRuntimes: 'node',
      playlistEnd: 25, // Giới hạn 25 bài cho Mix để tránh lag
    });

    // yt-dlp for playlist/mix returns entries
    if (out && out.entries && out.entries.length > 0) {
      return {
        title: out.title || "YouTube Mix",
        tracks: out.entries.map(v => ({
          title: v.title,
          url: v.url || v.webpage_url || `https://youtu.be/${v.id}`, // yt-dlp entries might have id only
          duration: v.duration
        }))
      };
    }
  } catch (e) {
    console.warn('[fetchPlaylistData] yt-dlp failed:', e.message);
  }
  return null;
}

const TRENDING_API = process.env.TRENDING_API_URL || 'https://trandingsvn-production.up.railway.app';
const TRENDING_CACHE = new Map(); // key: "COUNTRY:mode" -> { data, timestamp }
const TRENDING_CACHE_TTL = 30 * 60 * 1000; // 30 phút

async function fetchTrendingData(country) {
  const cacheKey = country;
  const cached = TRENDING_CACHE.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < TRENDING_CACHE_TTL)) {
    console.log(`[trending-cache] HIT: ${country}`);
    return cached.data;
  }

  console.log(`[trending-cache] MISS: ${country} — đang gọi API...`);

  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.TRENDING_API_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${TRENDING_API}/api/trending/${country}`, { headers });
  if (!res.ok) throw new Error(`API returned ${res.status}`);

  const data = await res.json();

  // Lưu vào cache
  TRENDING_CACHE.set(cacheKey, { data, timestamp: Date.now() });

  return data;
}

async function handleTrending(interaction) {
  if (!interaction.guild || !interaction.member?.voice?.channel) {
    return interaction.reply({ content: '❌ Bạn cần vào voice channel trước.', flags: 64 });
  }

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 64 });
    }
  } catch (e) { return; }

  const country = (interaction.options.getString('country') || 'VN').toUpperCase();
  const mode = interaction.options.getString('mode') || 'all'; // 'all' hoặc 'local'

  try {
    const isCached = TRENDING_CACHE.has(country) && (Date.now() - TRENDING_CACHE.get(country).timestamp < TRENDING_CACHE_TTL);
    await interaction.editReply({ content: `${isCached ? '⚡ Cache' : '🌐 API'} Đang lấy trending **${country}**${isCached ? ' (nhanh hơn vì đã cache)' : ' từ laogicungton.site...'}` });

    // Gọi API (có cache + API key)
    let data;
    try {
      data = await fetchTrendingData(country);
    } catch (apiErr) {
      return interaction.editReply({ content: `❌ Không tìm thấy dữ liệu trending cho **${country}**. Kiểm tra mã quốc gia và thử lại.` });
    }

    let songs = data.songs || [];

    if (songs.length === 0) {
      return interaction.editReply({ content: `❌ Không có bài nào trending cho **${country}** lúc này.` });
    }

    // Filter theo mode
    if (mode === 'local') {
      songs = songs.filter(s => s.is_local);
      if (songs.length === 0) {
        return interaction.editReply({ content: `❌ Không có nhạc bản địa nào trending ở **${country}** lúc này.` });
      }
    }

    // Build queue items từ API data
    const requesterId = interaction.user?.id;
    const requesterName = interaction.member?.displayName || interaction.user?.username;

    const tracks = songs.map(s => ({
      url: s.youtube_url,
      title: `#${s.rank} ${s.title}`,
      duration: s.duration_sec,
      requesterId,
      requesterName
    }));

    // Setup voice & queue
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
        if (s.status === VoiceConnectionStatus.Disconnected) fullCleanup(guild, q);
      });
    }

    q.items.push(...tracks);

    const modeLabel = mode === 'local' ? '🏠 Nhạc bản địa' : '🎵 Tất cả';
    const countryName = data.country_name || country;
    await interaction.editReply({
      content: [
        `✅ **Top ${songs.length} Trending — ${countryName} ${data.flag_url ? '' : ''}**`,
        `📋 Chế độ: ${modeLabel}`,
        `🎶 Đã thêm vào hàng đợi, bài đầu: **${songs[0].title}** (${songs[0].duration})`,
        ``,
        songs.slice(0, 5).map(s => `\`#${s.rank}\` ${s.title} — ${s.channel} (${s.duration})`).join('\n'),
        songs.length > 5 ? `\n... và ${songs.length - 5} bài nữa.` : ''
      ].join('\n')
    });

    if (q.player.state.status !== 'playing' && q.connection) {
      next(guild).catch(e => console.warn('[next error@trending]', e?.message || e));
    }

  } catch (e) {
    console.error('Trending Error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Lỗi khi lấy nhạc trending.' }).catch(() => { });
    }
  }
}


async function handleSkip(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '⏭️ Không có gì để skip.', flags: 64 });
  safeStopCurrent(q);
  await interaction.reply({ content: '⏭️ Đã skip.' }).catch(() => { });
  if (q.items.length > 0 && q.connection) next(interaction.guild).catch(() => { });
  else armIdleTimer(interaction.guild, q);
}
async function handleStop(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '⏹️ Không có gì để dừng.', flags: 64 });
  fullCleanup(interaction.guild, q);
  await interaction.reply({ content: '⏹️ Đã dừng và xoá hàng đợi.' });
}
async function handleQueue(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q || (!q.current && q.items.length === 0)) return interaction.reply({ content: '📭 Hàng đợi trống.', flags: 64 });
  const lines = [];
  if (q.current) lines.push(`🎶 ${q.current.title || q.current.url}`);
  q.items.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title || t.url} — ${t.requesterName ? `by ${t.requesterName}` : ''}`));
  if (q.items.length > 10) lines.push(`... và ${q.items.length - 10} bài khác.`);
  await interaction.reply({ content: '```' + lines.join('\n') + '```' });
}
async function handleLeave(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '👋 Bot đã rời trước đó.', flags: 64 });
  fullCleanup(interaction.guild, q);
  queues.delete(interaction.guildId);
  await interaction.reply({ content: '👋 Đã rời kênh và giải phóng RAM.' });
}
async function handlePause(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '⏸️ Không có gì để tạm dừng.', flags: 64 });
  try { q.player.pause(true); armIdleTimer(interaction.guild, q); await interaction.reply({ content: '⏸️ Đã tạm dừng.' }); }
  catch { await interaction.reply({ content: '❌ Không thể tạm dừng.', flags: 64 }); }
}
async function handleResume(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: '▶️ Không có gì để tiếp tục.', flags: 64 });
  try { clearIdleTimer(q); q.player.unpause(); await interaction.reply({ content: '▶️ Tiếp tục phát.' }); }
  catch { await interaction.reply({ content: '❌ Không thể tiếp tục.', flags: 64 }); }
}
async function handleSkipTo() { return; }
async function handlePrev() { return; }

async function handleLoop(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q || (!q.current && q.items.length === 0)) {
    return interaction.reply({ content: '❌ Không có nhạc nào đang phát để đặt chế độ lặp.', flags: 64 });
  }

  const mode = interaction.options.getString('mode');
  q.loopMode = mode;

  const labels = { off: '⏹️ Tắt lặp', song: '🔂 Lặp lại bài này', queue: '🔁 Lặp toàn bộ hàng đợi' };
  await interaction.reply({ content: `${labels[mode] || mode}` });
}

async function handleArtist(interaction) {
  if (!interaction.guild || !interaction.member?.voice?.channel) {
    return interaction.reply({ content: '❌ Bạn cần vào voice channel trước.', flags: 64 });
  }

  // Defer trước
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 64 });
    }
  } catch (e) { return; }

  const artistName = interaction.options.getString('name');

  try {
    // 1. Tìm kênh YouTube của nghệ sĩ
    const results = await play.search(artistName, { source: { youtube: "channel" }, limit: 1 });

    if (!results || results.length === 0) {
      return interaction.editReply({ content: `❌ Không tìm thấy kênh YouTube nào của **${artistName}**.` });
    }

    const channel = results[0];
    // 2. Lấy playlist "Uploads" (Thay UC bằng UU)
    // Check nếu id bắt đầu bằng UC
    if (!channel.id || !channel.id.startsWith('UC')) {
      return interaction.editReply({ content: `❌ Không tìm thấy danh sách video của **${channel.name}** (ID không chuẩn).` });
    }
    const uploadsId = channel.id.replace('UC', 'UU');

    await interaction.editReply({ content: `🔍 **Kênh:** ${channel.name}\n⏳ Đang tải danh sách bài hát (Lọc bài ngắn & trùng)...` });

    // 3. Lấy video (giới hạn 100 bài gần nhất để nhanh)
    const playlist = await play.playlist_info(uploadsId, { incomplete: true });
    const videos = playlist.videos; // Lấy batch đầu tiên (thường là 100)

    // 4. Lọc & Khử trùng
    // - Duration > 120s
    // - Trùng tên thì lấy bài ngắn hơn (ưu tiên Audio/Lyric)

    const map = new Map(); // NormalizedTitle -> Video

    for (const v of videos) {
      if (v.durationInSec < 120) continue; // Bỏ qua video dưới 2 phút (theo yêu cầu mới)

      // Chuẩn hóa tên: bỏ dấu ngoặc, lowercase
      // VD: "Đen - Lối Nhỏ (M/V)" -> "den - loi nho"
      const normTitle = v.title
        .toLowerCase()
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (map.has(normTitle)) {
        const existing = map.get(normTitle);
        // Giữ bài ngắn hơn
        if (v.durationInSec < existing.durationInSec) {
          map.set(normTitle, v);
        }
      } else {
        map.set(normTitle, v);
      }
    }

    const finalTracks = Array.from(map.values());

    if (finalTracks.length === 0) {
      return interaction.editReply({ content: `❌ Không tìm thấy bài hát phù hợp (trên 2 phút) trong kênh **${channel.name}**.` });
    }

    // 5. Thêm vào Queue
    const qItems = finalTracks.map(v => ({
      title: v.title,
      url: v.url,
      duration: v.durationInSec,
      requesterName: interaction.user.username,
      requesterId: interaction.user.id
    }));

    const guildId = interaction.guildId;
    let q = queues.get(guildId);

    // Nếu chưa có hàng đợi thì tạo mới & phát ngay
    if (!q) {
      q = getQueue(interaction.guild);
      q.textChannelId = interaction.channelId;

      q.connection = joinVoiceChannel({
        channelId: interaction.member.voice.channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      q.connection.subscribe(q.player);

      // Setup connection events
      q.connection.on('stateChange', (o, s) => {
        if (s.status === VoiceConnectionStatus.Disconnected) fullCleanup(interaction.guild, q);
      });
    }

    // Add tracks
    q.items.push(...qItems);

    // Nếu bot đang rảnh (không phát nhạc), start luôn
    if (q.player.state.status !== AudioPlayerStatus.Playing && q.player.state.status !== AudioPlayerStatus.Buffering && !q.current) {
      next(interaction.guild);
    }

    await interaction.editReply({
      content: `✅ **Đã thêm ${qItems.length} bài** từ kênh **${channel.name}** vào hàng đợi.`
    });

  } catch (e) {
    console.error('Artist Error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Lỗi khi tìm kiếm nghệ sĩ.' }).catch(() => { });
    }
  }
}

module.exports = {
  currentController,
  currentControllerName,

  handlePlay,
  handleSkip,
  handleStop,
  handleQueue,
  handleLeave,
  handlePause,
  handleResume,
  handleSkipTo,
  handlePrev,
  handleTrending,
  handleArtist,
  handleLoop, // Export mới
};

